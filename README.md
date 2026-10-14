# pi-zgrep

Semantic code search for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent. One tool, four routes (hybrid, BM25, vector, ripgrep), auto-indexed.

[![npm version](https://img.shields.io/npm/v/pi-zgrep)](https://www.npmjs.com/package/pi-zgrep)
[![npm downloads](https://img.shields.io/npm/dm/pi-zgrep)](https://www.npmjs.com/package/pi-zgrep)
[![CI](https://img.shields.io/github/actions/workflow/status/carvalab/pi-zgrep/ci.yml)](https://github.com/carvalab/pi-zgrep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/pi-zgrep)](./LICENSE)
[![Node >= 22.18](https://img.shields.io/node/v/pi-zgrep)](https://nodejs.org)

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

## What's new in 0.4

- Print mode works. `pi -p "..."` used to exit 1 with a crash dump, because background work (the session warmup, an index build, an install) outlived the short session and then touched a context pi had already invalidated. It now stops reporting when the session is gone instead of taking the process down. Scripts and agent harnesses that shell out to pi were hitting this on every run.
- `/zg-status` tells you it started. It used to sit silent until its probes finished, so it looked like nothing happened.
- `/zg-server on|off|status` controls the daemon from inside pi, and the daemon now starts with the session and is shared across sessions instead of waiting for the first build.
- `/zg-index` suggests `--device`, `--model-cache`, and `--allow-remote` as you type. The command always forwarded them; they were just undiscoverable.

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

Results come back as ranked `file:line` lines. The tool result `details` carry the parsed JSON, kept for future TUI rendering.

## Commands

- `/zg-index [args...]` passes arguments through to `zg index` (for example `--rebuild`). Progress streams in the status line, and the handler notifies you when the build starts and finishes. The palette suggests the common flags, including `--device`, `--model-cache`, and `--allow-remote`.
- `/zg-status` shows the resolved binary and version, index readiness and freshness, and the daemon state. It notifies you when it starts and shows progress in the status line while its probes run.
- `/zg-server [on|off|status]` starts, stops, or inspects the daemon. The daemon starts on its own; this is the manual override.

## How it behaves

### The index is ready before the first question

When a session starts, the extension checks for the binary and, in the background, makes sure the index exists: a missing or stale index builds before you ask anything, with progress on the status line. On a warm repo this costs two cheap spawns (a version probe and a readiness check), and the daemon from your previous session is still running, so nothing new starts. Esc cannot abort a session-start build because it runs in the background; `/zg-index` is the manual control. On bare dev checkouts (`pi -e .` without `npm install`) the binary is not there yet, so startup does nothing and the first tool use installs it.

### The first query builds the index if it has to

A `zg` call that needs the index and does not have one runs `zg index` for you. Build progress streams in the tool output, and Esc aborts the build (the child receives SIGKILL). Partial builds resume incrementally on the next attempt. A failed build surfaces a memoized error on later calls in the same session; start a new session or run `/zg-index`, which bypasses the memo. `mode=rg` queries skip the index entirely.

### A daemon keeps the index fresh

The extension starts zg's background daemon at session start (`zg server on`, loopback-only, detached), and zg allows one daemon per machine, so a running one is reused and a dead one comes back. The daemon watches the workspace, reconciles the index hourly, and reuses the embedding model across runs. `/zg-server` starts, stops, or inspects it. Set `PI_ZG_SERVER` to any non-empty value to opt out and manage the daemon yourself.

### The agent is nudged toward the right route

On every agent turn, the extension appends a short system-prompt note telling the model to prefer `zg` over `grep`/`find`, with mode guidance: `hybrid` for intent, `fts` for symbols, `vector` for paraphrases, `rg` for exact matches. It also says when to fall back: zero results, a tool error, or a `possibly_stale` flag on content the agent just edited. Set `PI_ZG_GUIDANCE` to any non-empty value to disable the nudge.

## Configuration

All env vars are read from the pi process environment (set them before launching pi). The "any non-empty value" convention means setting `PI_ZG_AUTO_INSTALL=1` is the same as `PI_ZG_AUTO_INSTALL=please-stop`.

| Variable              | Effect when set to any non-empty value                                                     |
|-----------------------|---------------------------------------------------------------------------------------------|
| `PI_ZG_BIN`           | Path to the `zg` binary. Skips packaged-dependency and PATH lookup. If set but the binary is not executable there, the extension errors out (no fallback). |
| `PI_ZG_AUTO_INSTALL`  | Never auto-install. Error surfaces the exact manual command.                                |
| `PI_ZG_GUIDANCE`      | Do not append the system-prompt nudge.                                                      |
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

**Windows is supported**, thanks to [Rodrigo Jäger (@rodrigojager)](https://github.com/rodrigojager). The launcher resolves npm's `.cmd` shims, runs packaged `.js`, `.mjs`, and `.cjs` entries through Node, and hides background consoles. Quoted index paths and flag values are preserved, and results keep filenames with spaces, Unicode, and drive letters.

## Benchmarks

The retrieval and answer-quality numbers that matter come from upstream's own benchmark suite, which is bigger and better instrumented than anything we would run here: agent-based A/B runs (zg on and off) with judge scoring on [SWE-QA-Bench](https://github.com/zvec-ai/zvec-grep/blob/main/benchmarks/swe-qa-bench/README.md) (code, Claude Opus 5) and [BrowseComp-Plus](https://github.com/zvec-ai/zvec-grep/blob/main/benchmarks/browse-comp-plus/README.md) (general text, Codex gpt-5.6-sol), plus real-repo case studies on Pylint, Matplotlib, and Django. Method, environments, and results: [upstream benchmark docs](https://github.com/zvec-ai/zvec-grep/blob/main/benchmarks/README.md).

As a local reference we also keep a small latency and hit-rate comparison of zg against ripgrep and GNU grep on this repo's own code. The method and the numbers live in [doc/benchmark.md](doc/benchmark.md); rerun it yourself with `./doc/bench.sh` (130-line script, no dependencies).

## Skill

The package ships a `pi-zgrep-search` skill, written by [Rodrigo Jäger (@rodrigojager)](https://github.com/rodrigojager). pi loads it with the extension, and it tells the agent which route to pick, how to keep retrieval small, and when to fall back to native search.

## Out of scope

No override of pi's native `grep`/`find`, no MCP-client mode, no custom TUI rendering, no `@`-mention autocomplete, no remote embeddings.

## Development

```bash
git clone https://github.com/carvalab/pi-zgrep.git
cd pi-zgrep
npm install
npm run test            # unit tests (parser, arg builder, ensure chain, guidance)
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
