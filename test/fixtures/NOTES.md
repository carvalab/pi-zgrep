# zg compat fixture notes (for parser / arg-builder authors)

These notes describe the exact output shapes observed on `zg` **0.2.1**
(installed via `npm install -g @zvec/zvec-grep`, engine node v24).

## Version

```
$ zg --version
0.2.1

$ zg -v
0.2.1
```

The version string is a plain `MAJOR.MINOR.PATCH` triple on stdout, no
prefix, no suffix, no trailing newline decoration.

## `zg <command> --help`

Top-level `zg --help` (and `zg help`) opens with a banner line:

```
zvec-grep 0.2.1
```

then a `Usage:` block, then section headings. `zg <command> --help` (e.g.
`zg query --help`, `zg status --help`) does NOT repeat the banner — it
starts directly with `Usage:`. Subcommands used here:

- `zg query --help` → 54 lines, sections include `Search routes:`, `Result
  options:`, `Embedding runtime:`, `File filters:`, `Environment:`.
- `zg status --help` → 8 lines, ends with the `--check-ready` description.

Both help outputs are stable text and safe as arg-builder tripwire
inputs (compare as text after stripping the version line / a leading
blank line).

## `zg status` (before/after index)

`zg status` (no flag) prints a status block on stdout. The first
non-empty line carries a one-character severity marker + a short label
followed by a colon-free description:

```
? Workspace index is not configured
  /tmp/tmp.EAkzBafaw1/sample-project

  Storage     .zvec-grep/index.zvec
  Policy      undecided

  Next        zg index or zg query --rg
```

After a successful `zg index` the marker switches to `✓` and the body
gains a `Coverage` bar, `Entities`, `Queue`, and `Embedding` lines:

```
✓ Workspace index is ready
  /tmp/tmp.EAkzBafaw1/sample-project

  Coverage    ████████████████████ 100%  1 / 1 files
  Entities    1
  Truncated   0 fragments
  Queue       0 pending · 0 failed

  Embedding   local/potion-code-16m-v2
              256 dimensions · cosine

  Storage     .zvec-grep/index.zvec
```

`--check-ready` does not change the output; it only sets the exit code
to non-zero (here: `1`) when the index is not ready, and `0` once it is.

## `zg index`

The last ~20 lines of `zg index` (the rest is noisy spinner text) look
like:

```
tip	Default indexing skips common noise. For large or remote-embedding indexes, inspect this long-lived workspace and choose focused -g/--glob and -t/--type filters.
Scanning files...
Preparing local/potion-code-16m-v2
Downloading local/potion-code-16m-v2 · 16 KiB
Indexing complete
Workspace index
files	1 scanned, 1 added, 0 modified, 0 retried, 0 unchanged, 0 deleted, 0 failed
entities	1
duration	3s (2901ms)
roots	/tmp/tmp.EAkzBafaw1/sample-project
```

The first indexing run downloads the local embedding model
(`potion-code-16m-v2`, ~16 KiB). Subsequent runs are faster.

## `zg query` output shapes — both flavors observed

The default output mode is documented as `agent markdown` (help text:
`--human  Human-readable output (default: agent markdown)`). Both modes
are non-empty and human-readable in this build. **The default mode is
the parser target.**

### Default (`agent markdown`) — captured in `query-output.txt`

```
query groups (1):
Q1 [primary]: where is the theme restored
hits: 1

#1 matchedBy=fts+vector hello.ts:2-4
source:
2	function loadTheme(): string {
3	  return "dark";
4	}
```

Shape invariants observed across all four routes:

- Header: `query groups (N):`
- One stanza per group, beginning with `Q<N> [<role>]: <text>` where
  `<role>` is `primary` (positional / hybrid) or `supplemental`
  (`--fts`, `--vector`, `--rg`).
- Each group: `hits: <N>`
- Each hit starts with `#<i> <key=value...> <path>:<start>-<end>` where
  the `<key=value...>` token set is space-delimited. Observed keys:
  `matchedBy` (always), and with `--human` only: `score`, `Range`,
  `Status`, `Kind`, `Symbol`, `Signature`, `Modifiers`.
- For `--rg` the stanza format changes: it begins with the bare
  `<path>` and a ripgrep-style numbered hit block (`<line>:<text>`),
  no `query groups` header.

### `--human` mode (for reference only)

```
Context: /tmp/tmp.EAkzBafaw1/sample-project workspace index
Query: where is the theme restored
Routes: fts:where is the theme restored, vector:where is the theme restored
Coverage: ranked_sample
Groups: 1
Files: 1
Hits: 1

Group: Q1 [primary]
Query: where is the theme restored
Hits: 1

File: hello.ts
Hits: 1

  #1 function loadTheme matchedBy=fts+vector score=0.0328
  Range: 2-4  Status: fresh
  Kind: code/function
  Symbol: loadTheme
  Signature: function loadTheme(): string
  Modifiers: exported
  Source:
    2	function loadTheme(): string {
    3	  return "dark";
    4	}
```

`--human` works for `--rg` too but yields a different stanza layout
(`Coverage: rg_exhaustive`, numbered lexical_match entries).

## Four routes — what worked

All four routes returned 0 and produced hits. The scratch dir held a
single-file index (1 entity), so each route yielded exactly 1 hit.

| Route                                | Exit | Hits | Stanza type        |
|--------------------------------------|------|------|--------------------|
| `zg query "..."` (positional hybrid) | 0    | 1    | `query groups (1)` |
| `zg query --fts "loadTheme"`         | 0    | 1    | `query groups (1)` |
| `zg query --vector "..."`            | 0    | 1    | `query groups (1)` |
| `zg query --rg "loadTheme"`          | 0    | 2    | ripgrep-style      |

For `--rg` the parser must not assume the `query groups` header — see
the `--rg` example in this file.

## Default mode is non-empty

The task brief asked us to retry with `--human` if the default output
was empty or error-shaped. **That was not needed:** the default output
is non-empty, contains the hit path `hello.ts`, and is the documented
`agent markdown` form. Both modes are captured above for the parser
author.

## Exit codes observed

- `zg status --check-ready` (unindexed) → `1`
- `zg status --check-ready` (indexed)   → `0`
- `zg query ...` (any route)            → `0`
- `zg index` (initial)                  → `0` (downloads model on first
  run)
- `npm install -g @zvec/zvec-grep` (first attempt) → `1` (sharp
  optional-dep postinstall build failed; see residual risks).

## Residual risks / environment notes

- `npm install -g @zvec/zvec-grep` failed first time with a
  `sharp@0.34.5` postinstall source build error (`Please add node-gyp
  to your dependencies`). Workaround used: `--ignore-scripts`. Sharp's
  prebuilt `@img/sharp-linux-x64` binary is already present in the
  tree; the CLI runs fine without building sharp from source.
- The sample project lives at `test/fixtures/sample-project/hello.ts`
  for the repo (only the source is committed). All indexing and query
  runs were executed against a scratch copy under `/tmp` to avoid
  poisoning the pi-zg worktree with `.zvec-grep/` state.
