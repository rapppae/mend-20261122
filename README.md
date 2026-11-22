# mend: one patch tool for every AI edit format

`mend` is a command-line tool that applies the edits AI models write, in four formats, to a tree of
text files. `SPEC.md` is the whole specification. It is built for the make.fun competition
"Build mend, one patch tool for every AI edit format".

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, or standard input when it is absent or `-`.
- `--format` picks one of `unified`, `search-replace`, `v4a`, `json`; `auto` (the default) detects
  the format from the patch text.
- `--check` does everything but write: the same output and exit code as without it.
- `--strict` matches lines exactly (tier 0 only).

It reads a patch, finds the lines each edit names at the first of three matching tiers (exact,
trailing whitespace ignored, leading and trailing whitespace ignored, with re-indentation at the
third tier), and writes every change or none, printing what it changed or why it failed.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. It does all of SPEC.md: the command
  line, the output and exit codes, safe paths, format detection, all four formats, three-tier
  matching, and the all-or-nothing write. Its last lines hand a trial over to `runner.ts` when
  `MAKEFUN_ENV_URL` is set: keep them.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts`
  on each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the
  files left in the directory).
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It
passes when the exit code, everything written to stdout and every file afterwards are exactly
what SPEC.md says. stderr is never compared. Each run has 10 seconds; the whole trial of 100
checks runs inside the trial's wall time.

## Local grading

100 of 100 practice checks pass (`practice score 1000`), plus an extra edge-case battery written
from SPEC.md sentences the practice set does not show (usage errors, lone markers, chained
moves, tier-0-wins ambiguity, end-of-file chunks, CRLF and no-final-newline files).
