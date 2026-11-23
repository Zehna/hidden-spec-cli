# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Zehna/hidden-spec-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Zehna/hidden-spec-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

Entry for make.fun [`hidden-spec-cli-01-run-20261122`](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) (see `SPEC.md`, the whole contract).

`main.ts` (Node 22, standard library only) reads a patch in one of four formats —
unified diff, SEARCH/REPLACE blocks, V4A, JSON text-editor tool calls — finds the
lines each edit names at the first of three matching tiers (exact, trailing
whitespace ignored, leading+trailing whitespace ignored; `--strict` is tier 0
only), and changes every file or none (atomic: any failed edit means nothing is
written). Run as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`runner.ts` is the kit's trial runner (unchanged); `check.ts` runs the kit's
100 public practice checks against `main.ts`.

Practice result (Node v22.20.0, kit `program/generator/practice.json`):
**100 of 100 passed, practice score 1000.** The house strict applier (tier 0
only) scores an estimated 73/100 on the same set, so this entry beats it by 27
checks on practice. Scored checks are drawn after the deadline from a sealed
pool of 300, including kinds the practice set does not show.
