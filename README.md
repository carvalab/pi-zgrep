# pi-zgrep

Semantic code search for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent. One tool, four routes (hybrid, BM25, vector, ripgrep), auto-indexed.

[![npm version](https://img.shields.io/npm/v/pi-zgrep)](https://www.npmjs.com/package/pi-zgrep)
[![npm downloads](https://img.shields.io/npm/dm/pi-zgrep)](https://www.npmjs.com/package/pi-zgrep)
[![CI](https://img.shields.io/github/actions/workflow/status/carvalab/pi-zgrep/ci.yml)](https://github.com/carvalab/pi-zgrep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/pi-zgrep)](./LICENSE)
[![Node >= 22.18](https://img.shields.io/node/v/pi-zgrep)](https://nodejs.org)

![pi-zgrep: grep finds 0 matches for "stdout into structured", zg finds src/parse.ts:138 parseQueryOutput](https://raw.githubusercontent.com/carvalab/pi-zgrep/main/doc/assets/gallery.png)

## What your agent gets

- It finds code by meaning. "Where do we parse the upstream output format?" works before anyone knows the symbol names, which is exactly an agent's situation in an unfamiliar repo.
- No setup and no daemon babysitting. The search engine installs as a dependency, the index builds in the background at session start, and a daemon keeps it fresh.
- Exact matching keeps an escape route: `mode=rg` passes the query to managed ripgrep and skips the index.

This is what that looks like on this repository. The agent makes one tool call:

```
zg({ query: "where does the extension parse zg output into results", mode: "hybrid" })
```

and gets ranked `file:line` hits back (real output):

```
doc/specs/2026-09-02-pi-zg-extension.md:55-68    heading: Components
doc/specs/2026-09-02-pi-zg-extension.md:69-76    heading: Data flow
doc/plans/2026-09-02-pi-zg-extension.md:353-426  heading: Task 5: Output parser (src/parse.ts)
```

Nothing in that query is a literal identifier in the codebase. Ripgrep scores zero on questions like this one; see [Benchmarks](#benchmarks) for where the numbers live.

## What's new in 0.6

- Each repository searches its own index. zg looks for an index in the current folder and then in each parent folder, so an index left in a parent folder (say `~/Dev`) used to capture every repo below it: the status said ready and semantic queries returned the parent's files. Now a repo inside an indexed parent gets its own index on first use.
- Session start no longer builds an index of your home directory or the filesystem root. Use `mode=rg` there, or `/zg-index` if you really want one.
- The tool appears in pi's "Available tools" list, and its routing advice rides on pi's tool guidelines. The old hook that replaced the whole system prompt each turn is gone.
- Function hits no longer break parsing. zg 0.2.2 prints an `outline:` section (with a blank line and a `calls:` list) for code symbols, and the parser used to give up and return the whole result as raw text. It now reads each hit up to the next one.
- Results render in the TUI: the call shows mode and query, the result shows the hit count and `file:line` list, with snippets when expanded.
- Large output follows pi's convention: capped at 2000 lines / 50KB, long lines cut to 500 characters, and the full text saved to a temp file the model can read.
- Zero results say "No matches" with a next step instead of an empty string, and a full page says the limit was reached.
- Common argument slips no longer cost a retry: `limit: "5"`, `mode: "semantic"` or `"grep"`, `null` optionals, `pattern` instead of `query`.
- The tool is marked read-only, so permission extensions don't ask before every search, and it returns `structuredContent` for codemode scripts.

## Install

```bash
pi install npm:pi-zgrep
```

Try it without installing first:

```bash
pi -e npm:pi-zgrep
```

The engine, [zvec-grep](https://github.com/zvec-ai/zvec-grep) (Apache-2.0, npm `@zvec/zvec-grep`), ships as a regular npm dependency, so one install brings both. No lifecycle scripts run: npm 12 blocks dependency postinstalls by default, and upstream ships prebuilt native bindings as optional dependencies instead. At runtime the extension resolves the binary in order: `PI_ZG_BIN` (explicit override), the packaged dependency, `zg` on PATH, then a global install on first use (`npm install -g @zvec/zvec-grep`, `bun add -g` fallback, one `--ignore-scripts` retry). pi-zgrep itself is an integrator: the search logic lives upstream, and this package translates a pi tool call into `zg` argv and parses the output.

## The `zg` tool

Local-first semantic + BM25 + hybrid + ripgrep search over the current workspace.

| Parameter  | Type                                  | Default    | Notes                                                                    |
|------------|---------------------------------------|------------|--------------------------------------------------------------------------|
| `query`    | string                                | (required) | Natural language, symbol, or regex (for `mode=rg`).                      |
| `mode`     | `hybrid` \| `fts` \| `vector` \| `rg` | `hybrid`   | Search route. `rg` skips the index entirely.                             |
| `limit`    | number (1-50)                         | `10`       | Max results to return.                                                   |
| `glob`     | string                                |            | File filter, e.g. `*.ts`.                                                |
| `type`     | string                                |            | File-type filter.                                                        |
| `refresh`  | `auto` \| `wait`                      | `auto`     | `wait` forces `--refresh wait` after editing a file in the same session. |
| `preview`  | `short` \| `none`                     | `short`    | Include a one-line code preview per result.                              |

Results come back as ranked `file:line  score  first-preview-line` lines. Zero results return `No matches (mode=…)` with a suggested next route, and a page that fills `limit` says so. Output is capped the way pi's own tools cap it (2000 lines or 50KB, 500 characters per line); when anything is cut, the full text is saved to a temp file and the result names it.

Before validation the tool repairs common argument slips: numeric strings and out-of-range values for `limit` (clamped to 1-50), mode synonyms such as `semantic` → `vector`, `bm25` → `fts`, `grep`/`ripgrep` → `rg`, `null` or empty optionals, and `pattern` or `q` in place of `query`.

For programs, the result carries `structuredContent` (`{ results: [{ file, lineStart, lineEnd?, score?, snippet? }], truncated, raw? }`, declared as the tool's `outputSchema`), and `details` holds the same results for the TUI renderer. The tool is annotated `readOnlyHint: true`, `openWorldHint: false`: it never changes your files (the gitignored `.zvec-grep/` index aside) and embeds locally.

## Commands

- `/zg-index [args...]` passes arguments through to `zg index` (for example `--rebuild`). Progress streams in the status line, and the handler notifies you when the build starts and finishes. The palette suggests the common flags, including `--device`, `--model-cache`, and `--allow-remote`.
- `/zg-status` shows the resolved binary and version, index readiness and freshness, and the daemon state. It notifies you when it starts and shows progress in the status line while its probes run.
- `/zg-server [on|off|status]` starts, stops, or inspects the daemon. The daemon starts on its own; this is the manual override.

## How it behaves

### The index is ready before the first question

When a session starts, the extension checks for the binary and, in the background, makes sure the index exists: a missing or stale index builds before you ask anything, with progress on the status line. On a warm repo this costs two cheap spawns (a version probe and a readiness check), and the daemon from your previous session is still running, so nothing new starts. Esc cannot abort a session-start build because it runs in the background; `/zg-index` is the manual control. On bare dev checkouts (`pi -e .` without `npm install`) the binary is not there yet, so startup does nothing and the first tool use installs it.

### The first query builds the index if it has to

A `zg` call that needs the index and does not have one runs `zg index` for you. Build progress streams in the tool output, and Esc aborts the build (the child receives SIGKILL). Partial builds resume incrementally on the next attempt. A failed build surfaces a memoized error on later calls in the same session; start a new session or run `/zg-index`, which bypasses the memo. `mode=rg` queries skip the index entirely.

### Each repository gets its own index

zg finds an index by looking in the current folder and then in each parent folder, and it does not stop at a repository. Its builds skip nested git repos. So an index in a parent folder (for example one built when pi was started in `~/Dev`) used to answer for every repo below it, with the parent's files. The extension now treats a `.git` (folder or file) between the current folder and that parent index as a boundary. A repo inside an indexed folder gets its own index on first use, built with an explicit root. A subfolder of an indexed project with no repo boundary in between keeps using the project's index, as before.

Automatic builds never index your home directory or the filesystem root, since that index would cover everything below it. The tool returns an error that suggests `mode=rg` instead. `/zg-index` can still build one on purpose.

### A daemon keeps the index fresh

The extension starts zg's background daemon at session start (`zg server on`, loopback-only, detached), and zg allows one daemon per machine, so a running one is reused and a dead one comes back. The daemon watches the workspace, reconciles the index hourly, and reuses the embedding model across runs. `/zg-server` starts, stops, or inspects it. Set `PI_ZG_SERVER` to any non-empty value to opt out and manage the daemon yourself.

### The agent is nudged toward the right route

The tool registers a one-line `promptSnippet`, so pi lists it under "Available tools", and three `promptGuidelines` that pi adds to the system prompt's guidelines while the tool is active: prefer `zg` over `grep`/`find`; `hybrid` for intent, `fts` for symbols, `vector` for paraphrases, `rg` for exact matches; and when to fall back (zero results, a tool error, or a `possibly_stale` flag on content the agent just edited). Set `PI_ZG_GUIDANCE` to any non-empty value to drop the guidelines; the snippet stays.

## Configuration

All env vars are read from the pi process environment (set them before launching pi). The "any non-empty value" convention means setting `PI_ZG_AUTO_INSTALL=1` is the same as `PI_ZG_AUTO_INSTALL=please-stop`.

| Variable              | Effect when set to any non-empty value                                                     |
|-----------------------|---------------------------------------------------------------------------------------------|
| `PI_ZG_BIN`           | Path to the `zg` binary. Skips packaged-dependency and PATH lookup. If set but the binary is not executable there, the extension errors out (no fallback). |
| `PI_ZG_AUTO_INSTALL`  | Never auto-install. Error surfaces the exact manual command.                                |
| `PI_ZG_GUIDANCE`      | Do not add the routing guidelines to the system prompt.                                     |
| `PI_ZG_SERVER`        | Do not start the zg daemon after the first build.                                           |

## Troubleshooting

**Install fails.** Run the manual command the extension surfaces:

```bash
npm install -g @zvec/zvec-grep
```

On hosts without node-gyp the first attempt can fail on sharp's optional postinstall. The extension retries once with `--ignore-scripts`; sharp ships a prebuilt binary so the retry works. If both attempts fail, the manual command above still works.

**Offline first index.** The first `zg index` run downloads a local embedding model. If the download fails, the error surfaces verbatim in the tool output. Reconnect, or pre-stage the model cache, and retry.

**`mode=rg` works without an index.** Use it when the index is broken or you want to skip the build step entirely.

**Parse miss.** If upstream changes its output shape, the tool falls back to raw text passthrough prefixed with a hint to run `/zg-status` and file an issue at [carvalab/pi-zgrep](https://github.com/carvalab/pi-zgrep/issues). The fixtures under `test/fixtures/` are the compat tripwire for the parser.

**Semantic results come from another project.** An older version may have left an index in a parent folder. Upgrading fixes the lookup; to remove the stray index, run `/zg-status` from that folder to confirm its root, then delete its `.zvec-grep/` directory.

**Another extension also registers `zg`.** `pi-zvec-grep-ext` and `@krosskinetic/pi-zg` use the same tool name, and pi keeps whichever extension loads first. Install only one. The same goes for upstream's own pi integration (`zg --install --target pi`, merged after zg 0.2.2), which adds zg's MCP tools and its own prompt block: use either it or this extension.

**Windows is supported**, thanks to [Rodrigo Jäger (@rodrigojager)](https://github.com/rodrigojager). The launcher resolves npm's `.cmd` shims, runs packaged `.js`, `.mjs`, and `.cjs` entries through Node, and hides background consoles. Quoted index paths and flag values are preserved, and results keep filenames with spaces, Unicode, and drive letters.

## Benchmarks

The retrieval and answer-quality numbers that matter come from upstream's own benchmark suite, which is bigger and better instrumented than anything we would run here: agent-based A/B runs (zg on and off) with judge scoring on [SWE-QA-Bench](https://github.com/zvec-ai/zvec-grep/blob/main/benchmarks/swe-qa-bench/README.md) (code, Claude Opus 5) and [BrowseComp-Plus](https://github.com/zvec-ai/zvec-grep/blob/main/benchmarks/browse-comp-plus/README.md) (general text, Codex gpt-5.6-sol), plus real-repo case studies on Pylint, Matplotlib, and Django. Method, environments, and results: [upstream benchmark docs](https://github.com/zvec-ai/zvec-grep/blob/main/benchmarks/README.md).

As a local reference we also keep a small latency and hit-rate comparison of zg against ripgrep and GNU grep on this repo's own code. The method and the numbers live in [doc/benchmark.md](doc/benchmark.md); rerun it yourself with `./doc/bench.sh` (130-line script, no dependencies).

## Skill

The package ships a `pi-zgrep-search` skill, written by [Rodrigo Jäger (@rodrigojager)](https://github.com/rodrigojager). pi loads it with the extension, and it tells the agent which route to pick, how to keep retrieval small, and when to fall back to native search.

## Out of scope

No override of pi's native `grep`/`find`, no MCP-client mode, no `@`-mention autocomplete, no remote embeddings.

## Development

```bash
git clone https://github.com/carvalab/pi-zgrep.git
cd pi-zgrep
npm install
npm run test            # unit tests (parser, arg builder, ensure chain, workspace plan, tool surface)
ZG_TEST_E2E=1 npm run test:e2e   # real zg engine required on PATH
npm run test:pi          # real pi session against openrouter/free; needs OPENROUTER_API_KEY
```

Fixtures under `test/fixtures/` are captured from real `zg` 0.2.1 runs and act as the compat tripwire for both the arg builder and the parser. To regenerate a fixture, delete it and re-run the capture commands in `doc/plans/2026-09-02-pi-zg-extension.md` (Task 3), or copy from a fresh `zg` run against `test/fixtures/sample-project/`.

Lint and format are wired through ultracite (oxlint + oxfmt):

```bash
npm run lint
npm run format          # writes changes
npm run format:check    # CI gate
```

## License

MIT. See [LICENSE](./LICENSE).

## Changelog

Release notes live in [CHANGELOG.md](./CHANGELOG.md); each section is curated before the tag lands.
