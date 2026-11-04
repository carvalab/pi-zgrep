# zg compat fixture notes (for parser / arg-builder authors)

Every file here was captured from the **0.3.0** engine — the native Rust CLI
shipped as `@zvec/zvec-grep`'s per-platform optional dependency
(`node_modules/@zvec/zvec-grep-<os>-<arch>/bin/zg`). 0.3.0 has no
subcommands: `zg <query>` searches, `--index`/`--status`/`--rg` are flags.
Re-capture with the argv below against a scratch copy of `sample-project/`.

## Fixture → argv (the authoritative map)

| Fixture                    | argv (cwd = a scratch copy of `sample-project/`)                                                       | Exit |
|----------------------------|--------------------------------------------------------------------------------------------------------|------|
| `zg-version.txt`           | `zg --version` (identical for `-v`)                                                                     | 0    |
| `help-banner.txt`          | `zg --help`                                                                                             | 0    |
| `help-query.txt`           | `zg --help search`                                                                                      | 0    |
| `help-status.txt`          | `zg --status --help`                                                                                    | 0    |
| `index-output.txt`         | `zg --index --embedding local/potion-code-16m-v2`, last 5 stdout lines                                   | 0    |
| `status-notready.txt`      | `zg --status` where the index needs a rebuild                                                           | 0    |
| `status-notready-exit.txt` | stderr of `zg --status --check-ready` in that same state                                                | 1    |
| `status-ready.txt`         | `zg --status` after the `--index` above                                                                 | 0    |
| `query-output.txt`         | `zg --hybrid "where is the theme restored" --limit 5 --preview short --color never --mode auto`          | 0    |
| `query-output-multi.txt`   | `zg --hybrid loadTheme --hybrid "restore user theme at startup" --limit 5 --preview short --color never --mode auto` | 0 |
| `query-output-none.txt`    | `zg --fts loadTheme --limit 5 --preview none --color never --mode auto`                                  | 0    |
| `query-output-rg.txt`      | `zg --rg loadTheme --limit 5 --color never`                                                              | 0    |
| `query-no-matches.txt`     | `zg --rg zzz-no-such-symbol --limit 5 --color never`                                                     | 0    |

Those argv are the 0.3.0 capture equivalents of the builder argv, not its
literal output: the captures pinned `--limit 5` (the tool default is 10) and,
for `query-output-none.txt`, a non-default `--preview none`. The query and
status fixtures are read by `test/parse.test.ts`, so a shape change there is
a test failure rather than a silent parse miss.

## Version

`--version` and `-v` both print a bare `MAJOR.MINOR.PATCH` triple, one
trailing newline, no prefix. 0.3.0 is also the runner's floor: every
candidate is gated on this line and a 0.2.x binary is rejected by name
(`src/index.ts:586-629`).

## Help shapes

`zg --help` (49 lines) opens with `zvec-grep 0.3.0`, a blank line, then
`Usage:` and the flag list. `zg --help search` (96 lines) does **not**
repeat the banner — it starts at `Usage:` — and documents the routes,
result options, file filters, and the `-e` rule for `-`-leading patterns.
`zg --status --help` (12 lines) is the short usage plus the `Output:`
block for `--color`. Only `help-query.txt` is test-pinned (`test/args.test.ts`);
`help-banner.txt` and `help-status.txt` are captured reference, so a diff in
them fires no test.

## `--status` (before / after `--index`)

There is **no headline line** in 0.3.0 (0.2.x printed `✓ Workspace index is
ready`); the block starts at the `Coverage` field. Not ready, fresh
workspace (`status-notready.txt` is the same shape for a legacy index that
must be rebuilt — `Coverage    Unavailable (rebuild required)`; a virgin
directory says `Unavailable (index not configured)`):

```
  Coverage    Unavailable (rebuild required)

  Embedding   Not configured
  FTS         Not configured

  Storage     .zvec-grep/index
```

Ready (`status-ready.txt`), after the `--index` above:

```
  Coverage    ████████████████████ 100%  1 / 1 files

  Embedding   local/potion-code-16m-v2
              256 dimensions · cosine
  FTS         tokenizer=jieba filters=lowercase

  Storage     .zvec-grep/index
```

`--check-ready` never changes stdout; it only sets the exit code (`1` while
the index is not ready) and writes one stderr line
(`status-notready-exit.txt`: `Error: workspace index is not ready`).
`parseStatusOutput` reads `Coverage` for freshness; `Unavailable (…)`
carries the reason in parentheses, which is how `rebuild required` and
`index not configured` reach `ensureIndex`.

## `--index`

Progress lines (`Indexing index: 1/1 files`, `Optimizing …`, `Saving …`,
`Finishing …`) go to **stderr**; the stdout summary is all
`index-output.txt` holds (tab-separated `key<TAB>value`, `roots` scrubbed
to a placeholder path):

```
Workspace index
files	1 scanned, 1 added, 0 modified, 0 retried, 0 unchanged, 0 deleted, 0 failed
entities	1
duration	462ms (462ms)
roots	/work/sample-project
```

No test reads this file yet: it is captured reference for the `--index`
summary shape, not a tripwire.

## Query output — `--preview short` (the parser target)

`query-output.txt`, byte for byte:

```
#1 hello.ts:2-4
symbol: [function] loadTheme
  2: function loadTheme(): string {
  3:   return "dark";
  4: }
```

Shape invariants, identical across the four routes:

- Each hit starts with `#<rank> <path>:<start>-<end>` at column 0; `<rank>`
  restarts at 1 in every query group.
- Metadata lines follow at column 0 as `<key>: <value>`. A symbol hit
  carries `symbol: [<kind>] <name>`. There is no `matchedBy=` token
  (0.2.x) and no `score=` on this line in `short` mode.
- Preview lines are indented two spaces and written `<line>: <text>`.

`--preview none` (`query-output-none.txt`) keeps one source line per hit as
`<line>` + TAB + `<text>` — no colon, no indent:

```
#1 hello.ts:2-4
2	function loadTheme(): string {
```

`--preview full` is byte-identical to `short` for a four-line function, so
only `short`/`none` are captured. `--preview detail` is a **different
shape** the parser deliberately does not handle: grouped per file with
`Context:`/`Coverage:`/`Files:` headers and `Range:`/`Status:`/`Kind:`/
`Symbol:`/`Signature:` lines under `#<rank> <symbol> score=<n>`. The
extension never passes `--preview detail`; keep it that way unless the
parser grows a grouped-output branch.

## Multi-query output (`-- query i/n:` dividers)

`query-output-multi.txt` — two explicit `--hybrid` queries:

```
-- query 1/2: loadTheme --

#1 hello.ts:2-4
symbol: [function] loadTheme
  2: function loadTheme(): string {
  …
-- query 2/2: restore user theme at startup --
…
```

A trailing `--`. Blank lines separate the divider from the first hit and
one group from the next. No `query groups (N):` header (0.2.x), no
`Q<N> [role]:` line; `parseQueryOutput` keeps the groups in order.

## `--rg` output (ripgrep-shaped)

`query-output-rg.txt`:

```
hello.ts
  1: // Theme preference hydration happens at startup in loadTheme().
  2: export function loadTheme(): string {
```

One bare path line per file, blank line between files, then two-space
indented `<line>: <text>` matches (colon here, unlike `--preview none`).
No ranks, metadata, or headers.

## `No matches.`

A miss prints exactly `No matches.` (`query-no-matches.txt`) and still exits
`0`, on `--rg` and the indexed routes alike. An empty result set is not an
error; a non-zero exit is real and the tool surfaces stderr (`src/index.ts:1237-1248`).

## Four routes — what works

| argv                                                     | Exit | Hits | Shape |
|----------------------------------------------------------|------|------|-------|
| `--hybrid "where is the theme restored" --preview short` | 0 | 1 | `#1 hello.ts:2-4` + `symbol:` + indented preview |
| `--fts loadTheme --preview none`                         | 0 | 1 | `#1 …` + TAB preview |
| `--vector "restore user theme" --preview none`           | 0 | 1 | `#1 …` + TAB preview |
| `--rg loadTheme`                                         | 0 | 2 | bare path + indented `N: …` |

All captures pass `--color never` and `--limit 5` on top of the argv shown
(pipes are plain by default; pinning the flags keeps the bytes stable).
Leading-dash patterns on `--rg` need `-e`: `zg --rg -e "-x" --limit 1`
runs, while `zg --rg "-x" --limit 1` exits 1 with
`Error: zg --rg requires a pattern`.

## Exit codes observed

- `--status` → `0` whether or not the index is ready
- `--status --check-ready` → `1` not ready (stderr line above), `0` ready
- `--index` → `0` (progress on stderr)
- any query route, including a miss (`No matches.`) → `0`
- bad arguments, e.g. `--rg` without a pattern → `1` with `Error: …` on
  stderr

## Environment notes

Only `sample-project/hello.ts` is committed; every capture above ran
against a copy of it in a `mktemp -d "$TMPDIR/…"` scratch directory, so the
worktree never gains `.zvec-grep/` state. A first non-interactive
`--index` must name a model (`--embedding
local/potion-code-16m-v2`), or the next query is refused with
`[ZG.ENGINE.NOT_FOUND]` — see `test/ensure.test.ts`.

## Findings against the real 0.3.0 binary (2026-11-03)

- **A parent index still answers for a repo below it.** Index a folder, then
  `git init` a child with one file and query from the child: `zg --status`
  reports the parent's `Coverage` (`1 / 2 files (needs update)`) and a hybrid
  query returns the parent's file — 0.3.0 still walks past the `.git` boundary,
  so `src/workspace.ts` (a `.git` between cwd and the ancestor index means
  "build our own") is the only thing keeping a repo's results its own. Such a
  stale-index query also appends a trailer after the hits (`status:
  possibly_stale`, `results: served_from_current_index`, `background_refresh:
  idle (n/m)`), which a fresh index does not print.
- **`query-output-outline.txt` is the real symbol-hit shape.** `zg --hybrid
  "where is the theme returned" --color never --limit 3` against a scratch
  `src/theme.ts` (function, class, method) reproduces the block grammar byte for
  byte: `#<rank> <path>:<start>-<end>` at column 0, `symbol: [<kind>] <name>`, a
  `scope: <Class>` token on method hits, and two-space-indented `<line>:
  <text>` previews. No `outline:`/`calls:` block appears outside `--preview
  detail`. The one drift was the method's type annotation, blanked to
  `[redacted]` by hand in the committed capture while a real run prints the
  source line verbatim (`validate(token: string): boolean {`); the fixture was
  re-captured from that run and `test/parse.test.ts` now expects the real text.

