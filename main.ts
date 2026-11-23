// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-10: the command line, output and exit codes, safe
// paths, format detection, three-tier line matching (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON
// edits (section 9), and order/atomicity (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then
// this file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files and lines (SPEC.md section 3) and matching (section 5)
// ---------------------------------------------------------------------------

interface FileParts {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileParts {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

const rtrimWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWS = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function tierMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWS(a) === rtrimWS(b);
  return trimWS(a) === trimWS(b);
}

interface Occurrence {
  tier: number;
  positions: number[];
}

/** First tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once, at or after `from`. */
function findOccurrences(lines: string[], o: string[], strict: boolean, from = 0): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    if (o.length <= lines.length) {
      for (let i = from; i + o.length <= lines.length; i++) {
        let ok = true;
        for (let k = 0; k < o.length; k++) {
          if (!tierMatch(lines[i + k]!, o[k]!, tier)) {
            ok = false;
            break;
          }
        }
        if (ok) positions.push(i);
      }
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

interface NEntry {
  text: string;
  ctx: boolean;
  ctxIdx: number;
}

/** Build the replacement lines for N at occurrence `pos` (section 5). */
function buildN(entries: NEntry[], tier: number, fileLines: string[], pos: number, o: string[]): string[] {
  return entries.map((e) => {
    if (e.ctx) return fileLines[pos + e.ctxIdx]!;
    const t = e.text;
    if (tier === 2 && o.length > 0) {
      if (t === '' || t.trim() === '') return t;
      const f = leadingWS(fileLines[pos]!);
      const p = leadingWS(o[0]!);
      if (t.startsWith(p)) return f + t.slice(p.length);
    }
    return t;
  });
}

function replaceAt(lines: string[], o: string[], entries: NEntry[], tier: number, pos: number): string[] {
  const rep = buildN(entries, tier, lines, pos, o);
  return [...lines.slice(0, pos), ...rep, ...lines.slice(pos + o.length)];
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  body: string[];
}

/** O lines, N entries, and whether the hunk's last context/`+` line is followed by a `\` line. */
function hunkParts(body: string[]): { o: string[]; n: NEntry[]; noEol: boolean } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const bl of body) {
    if (bl === '') {
      // An empty line is a context line whose text is empty (section 6).
      o.push('');
      n.push({ text: '', ctx: true, ctxIdx: o.length - 1 });
    } else if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, ctxIdx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: false, ctxIdx: -1 });
    }
  }
  let noEol = false;
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.startsWith(' ') || body[j]!.startsWith('+')) last = j;
  }
  if (last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\')) noEol = true;
  return { o, n, noEol };
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, failPath: string): string {
  const parts = splitFile(before);
  let lines = parts.lines;
  let final = parts.final;
  let d = 0;
  for (const hunk of hunks) {
    const { o, n, noEol } = hunkParts(hunk.body);
    if (o.length === 0) {
      const pos = Math.min(hunk.a + d, lines.length);
      const runsToEnd = pos === lines.length;
      const rep = n.map((e) => e.text);
      lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos)];
      if (runsToEnd) final = !noEol;
      d += n.length;
      continue;
    }
    const occ = findOccurrences(lines, o, strict);
    if (occ === null) throw new Fail('no-match', failPath);
    const target = hunk.a - 1 + d;
    let pos = occ.positions[0]!;
    let best = Math.abs(pos - target);
    for (const p of occ.positions) {
      const dist = Math.abs(p - target);
      if (dist < best) {
        best = dist;
        pos = p;
      }
    }
    const runsToEnd = pos + o.length === lines.length;
    lines = replaceAt(lines, o, n, occ.tier, pos);
    if (runsToEnd) final = !noEol;
    d += n.length - o.length;
  }
  return joinFile(lines, parts.br, final);
}

interface UnifiedSection {
  oldP: string | null;
  newP: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
  hasPair?: boolean;
}

function unifiedPath(line: string): string {
  // text after the four characters (`--- ` / `+++ `), up to the first tab, surrounding spaces removed
  return line.slice(4).split('\t')[0]!.trim();
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function makeUnifiedEdit(sec: UnifiedSection, strict: boolean): Edit {
  let oldP = sec.oldP;
  let newP = sec.newP;
  if (oldP !== null) oldP = stripPrefix(oldP);
  if (newP !== null) newP = stripPrefix(newP);
  const creation = sec.creation || oldP === '/dev/null';
  const deletion = !creation && (sec.deletion || newP === '/dev/null');
  const oldPath = oldP;
  const newPath = newP;
  const hunks = sec.hunks;
  return (tree) => {
    const paths = [oldPath, newPath].filter((p): p is string => p !== null && p !== '/dev/null');
    for (const p of paths) {
      if (!safe(p)) throw new Fail('unsafe', p);
    }
    if (creation) {
      const np = newPath!;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const contentLines: string[] = [];
      let noEol = false;
      for (const hunk of hunks) {
        const body = hunk.body;
        let last = -1;
        for (let j = 0; j < body.length; j++) {
          if (body[j]!.startsWith('+')) {
            contentLines.push(body[j]!.slice(1));
            last = j;
          }
        }
        if (last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\')) noEol = true;
      }
      tree.now.set(np, contentLines.length === 0 ? '' : contentLines.join('\n') + (noEol ? '' : '\n'));
      return;
    }
    if (deletion) {
      const op = oldPath!;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath!;
    const np = newPath!;
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np) {
      if (tree.get(np) !== null) throw new Fail('exists', np);
      tree.move(op, np, applyHunks(before, hunks, strict, op));
      return;
    }
    tree.now.set(op, applyHunks(before, hunks, strict, op));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    let sec: UnifiedSection | null = null;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/([^ ]+) b\/([^ ]+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      sec = { oldP: m[1]!, newP: m[2]!, creation: false, deletion: false, hunks: [] };
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldP: unifiedPath(l), newP: unifiedPath(lines[i + 1]!), creation: false, deletion: false, hunks: [], hasPair: true };
      i += 2;
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else {
      i++;
      continue;
    }
    const s = sec;
    // header
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        if (s.hasPair) break;
        s.oldP = unifiedPath(h);
        s.newP = unifiedPath(lines[i + 1]!);
        s.hasPair = true;
        i += 2;
        continue;
      }
      if (h.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (h.startsWith('rename from ')) {
        s.oldP = h.slice(12).trim();
        i++;
        continue;
      }
      if (h.startsWith('rename to ')) {
        s.newP = h.slice(10).trim();
        i++;
        continue;
      }
      if (h.startsWith('new file mode')) {
        s.creation = true;
        i++;
        continue;
      }
      if (h.startsWith('deleted file mode')) {
        s.deletion = true;
        i++;
        continue;
      }
      i++;
    }
    // hunks
    while (i < lines.length) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (h.startsWith('@@')) {
        const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(h);
        if (!hm) throw new Exit2(`error: parse ${i + 1}`);
        const a = parseInt(hm[1]!, 10);
        i++;
        const body: string[] = [];
        while (i < lines.length) {
          const b = lines[i]!;
          // The body ends at a `--- ` line followed by a `+++ ` line (section 6):
          // that starts the next section, it is not an old line.
          if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
          if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
            body.push(b);
            i++;
          } else break;
        }
        while (body.length > 0 && body[body.length - 1] === '') body.pop();
        s.hunks.push({ a, body });
        continue;
      }
      i++;
    }
    edits.push(makeUnifiedEdit(s, strict));
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const parts = splitFile(before);
    const occ = findOccurrences(parts.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = occ.positions[0]!;
    const entries: NEntry[] = newLines.map((t) => ({ text: t, ctx: false, ctxIdx: -1 }));
    const out = replaceAt(parts.lines, oldLines, entries, occ.tier, pos);
    tree.now.set(path, joinFile(out, parts.br, parts.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const sIdx = i;
    let eq = -1;
    for (let j = sIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${sIdx + 1}`);
    const oldLines = lines.slice(sIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let k = sIdx - 1; k >= prevEnd; k--) {
      const t = lines[k]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${sIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevEnd = rep + 1;
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4AChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
}

type V4ASection =
  | { kind: 'add'; path: string; lines: string[]; lineNo: number }
  | { kind: 'delete'; path: string; lineNo: number }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: V4AChunk[]; lineNo: number };

function chunkParts(body: string[]): { o: string[]; n: NEntry[] } {
  const o: string[] = [];
  const n: NEntry[] = [];
  for (const bl of body) {
    if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, ctxIdx: o.length - 1 });
    } else if (bl.startsWith('-')) {
      o.push(bl.slice(1));
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: false, ctxIdx: -1 });
    } else if (bl === '') {
      o.push('');
      n.push({ text: '', ctx: true, ctxIdx: o.length - 1 });
    }
  }
  return { o, n };
}

function makeV4AEdit(sec: V4ASection, strict: boolean): Edit {
  if (sec.kind === 'add') {
    const path = sec.path;
    const contentLines = sec.lines;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, contentLines.length === 0 ? '' : contentLines.join('\n') + '\n');
    };
  }
  if (sec.kind === 'delete') {
    const path = sec.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  const path = sec.path;
  const moveTo = sec.moveTo;
  const chunks = sec.chunks;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const parts = splitFile(before);
    let lines = parts.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        let found: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let j = cursor; j < lines.length; j++) {
            if (tierMatch(lines[j]!, chunk.anchor, tier)) {
              found = j;
              break;
            }
          }
          if (found !== null) break;
        }
        if (found === null) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      const { o, n } = chunkParts(chunk.body);
      if (o.length === 0) {
        const pos = chunk.eof ? lines.length : cursor;
        const rep = n.map((e) => e.text);
        lines = [...lines.slice(0, pos), ...rep, ...lines.slice(pos)];
        cursor = pos + rep.length;
        continue;
      }
      const occ = findOccurrences(lines, o, strict, cursor);
      if (occ === null) throw new Fail('no-match', path);
      const pos = occ.positions[0]!;
      if (chunk.eof && pos + o.length !== lines.length) throw new Fail('no-match', path);
      lines = replaceAt(lines, o, n, occ.tier, pos);
      cursor = pos + n.length;
    }
    const result = joinFile(lines, parts.br, parts.final);
    if (moveTo !== null) tree.move(path, moveTo, result);
    else tree.now.set(path, result);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let cur: V4ASection | null = null;
  let curChunk: V4AChunk | null = null;
  let afterEof = false;
  let sawBody = false;
  const flush = (): void => {
    if (cur === null) return;
    if (cur.kind === 'add') {
      // Blank lines at the end of a section are not part of it (section 8);
      // a blank line is empty or only whitespace.
      while (cur.lines.length > 0 && cur.lines[cur.lines.length - 1]!.trim() === '') cur.lines.pop();
    } else if (cur.kind === 'update') {
      const chunks = cur.chunks;
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.body.length > 0 && lastChunk.body[lastChunk.body.length - 1]!.trim() === '') lastChunk.body.pop();
      }
      if (chunks.length === 0 && cur.moveTo === null) throw new Exit2(`error: parse ${cur.lineNo}`);
    }
    edits.push(makeV4AEdit(cur, strict));
    cur = null;
    curChunk = null;
    afterEof = false;
    sawBody = false;
  };
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const lineNo = i + 1;
    if (l.startsWith('*** Add File:')) {
      flush();
      cur = { kind: 'add', path: l.slice(13).trim(), lines: [], lineNo };
      i++;
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      flush();
      cur = { kind: 'delete', path: l.slice(16).trim(), lineNo };
      i++;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      flush();
      cur = { kind: 'update', path: l.slice(16).trim(), moveTo: null, chunks: [], lineNo };
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'add') {
      if (l.startsWith('+')) {
        cur.lines.push(l.slice(1));
        i++;
        continue;
      }
      if (l.trim() === '') {
        // An empty (or only-whitespace) line is an empty line of the file;
        // at the end of the section it is trimmed away by flush().
        cur.lines.push('');
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (cur.kind === 'delete') {
      if (blank(l)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    // update section
    if (l.startsWith('*** Move to:')) {
      if (cur.chunks.length === 0 && cur.moveTo === null && !sawBody) {
        cur.moveTo = l.slice(12).trim();
        sawBody = true;
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (l.trim() === '*** End of File') {
      if (curChunk !== null && !afterEof) {
        curChunk.eof = true;
        afterEof = true;
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${lineNo}`);
    }
    if (l.startsWith('@@')) {
      curChunk = { anchor: l.slice(2).trim() === '' ? null : l.slice(2).trim(), eof: false, body: [] };
      cur.chunks.push(curChunk);
      afterEof = false;
      sawBody = true;
      i++;
      continue;
    }
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (afterEof) throw new Exit2(`error: parse ${lineNo}`);
      if (curChunk === null) {
        curChunk = { anchor: null, eof: false, body: [] };
        cur.chunks.push(curChunk);
      }
      curChunk.body.push(l);
      sawBody = true;
      i++;
      continue;
    }
    if (l === '') {
      if (curChunk === null || afterEof) {
        i++;
        continue;
      }
      curChunk.body.push(l);
      sawBody = true;
      i++;
      continue;
    }
    throw new Exit2(`error: parse ${lineNo}`);
  }
  flush();
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Invocation (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves: Array<[string, string]> = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: A/D/M, plus R for a move (old existed before, is gone now, new
  // did not exist before, exists now), sorted by path (by <new> for R).
  const changedPaths = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  const deleted = changedPaths.filter((p) => tree.now.get(p) === null);
  const added = changedPaths.filter((p) => tree.original(p) === null && tree.now.get(p) !== null);
  const modified = changedPaths.filter((p) => tree.original(p) !== null && tree.now.get(p) !== null);
  const usedAdded = new Set<string>();
  const reachable = (from: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      for (const [a, b] of tree.moves) {
        if (a === cur && !seen.has(b)) {
          seen.add(b);
          stack.push(b);
        }
      }
    }
    return seen;
  };
  const rows: { key: string; line: string }[] = [];
  for (const d of [...deleted].sort(byteCompare)) {
    const r = reachable(d);
    const target = [...added].sort(byteCompare).find((a) => !usedAdded.has(a) && r.has(a));
    if (target !== undefined) {
      usedAdded.add(target);
      rows.push({ key: target, line: `R ${d} -> ${target}` });
    } else {
      rows.push({ key: d, line: `D ${d}` });
    }
  }
  for (const a of [...added].sort(byteCompare)) {
    if (!usedAdded.has(a)) rows.push({ key: a, line: `A ${a}` });
  }
  for (const m of modified) rows.push({ key: m, line: `M ${m}` });
  rows.sort((x, y) => byteCompare(x.key, y.key));
  if (!check) {
    for (const p of changedPaths) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
