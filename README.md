# pi-zgrep

zg semantic search for the pi coding agent. One tool, four routes (hybrid, BM25, vector, ripgrep), auto-indexed.

[![npm version](https://img.shields.io/npm/v/pi-zgrep)](https://www.npmjs.com/package/pi-zgrep)
[![CI](https://img.shields.io/github/actions/workflow/status/carvalab/pi-zgrep/ci.yml)](https://github.com/carvalab/pi-zgrep/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/pi-zgrep)](./LICENSE)
[![Node >= 22.18](https://img.shields.io/node/v/pi-zgrep)](https://nodejs.org)

## What is zg?

zg is [zvec-grep](https://github.com/zvec-ai/zvec-grep) (Apache-2.0), a local-first search engine that unifies ripgrep, BM25, and vector search with on-device embeddings. This package exposes it to pi as one tool. pi-zgrep is an integrator, not the engine: the heavy lifting happens in the upstream `zg` CLI (npm `@zvec/zvec-grep`).

## Install

```bash
pi install npm:pi-zgrep
```

Try it without installing first:

```bash
pi -e npm:pi-zgrep
```

The extension auto-installs the `zg` engine globally on first use (`npm install -g @zvec/zvec-grep`, with a `bun add -g` fallback when npm is missing). If the install fails on a host without node-gyp, the extension retries once with `--ignore-scripts`; sharp ships a prebuilt binary in the tree so the retry is safe. Already have `zg`? Set `PI_ZG_BIN` to its path and the extension skips PATH lookup entirely.

## Agent-facing tools

### `zg`

Local-first semantic + BM25 + hybrid + ripgrep search over the current workspace.

| Parameter  | Type                                  | Default    | Notes                                                                                          |
|------------|---------------------------------------|------------|------------------------------------------------------------------------------------------------|
| `query`    | string                                | (required) | Natural language, symbol, or regex (for `mode=rg`).                                            |
| `mode`     | `hybrid` \| `fts` \| `vector` \| `rg` | `hybrid`   | Search route. `rg` skips the index entirely.                                                    |
| `limit`    | number (1-50)                         | `10`       | Max results to return.                                                                         |
| `glob`     | string                                |            | File filter, e.g. `*.ts`.                                                                      |
| `type`     | string                                |            | File-type filter.                                                                              |
| `refresh`  | `auto` \| `wait`                      | `auto`     | `wait` forces `--refresh wait` after editing a file in the same session.                       |
| `preview`  | `short` \| `none`                     | `short`    | Include a one-line code preview per result.                                                    |

Returns ranked `file:line` results in ripgrep-style format. Details carry parsed JSON for future TUI rendering.

## Commands

- `/zg-index [args...]` is a pass-through to `zg index` (e.g. `--rebuild`). Progress streams in the status line; the handler notifies on start and finish.
- `/zg-status` shows the resolved binary and version, index readiness and freshness, and the daemon pointer. Run this when something looks off; the output tells you whether the index is missing, possibly stale, or fresh.

## How it behaves

**Auto-index on first non-rg query.** The first `zg` call that needs the index runs `zg index` for you. Build progress streams in the tool output (the status line carries install progress and `/zg-index` instead); Esc aborts (the child receives SIGKILL); partial builds resume incrementally on the next attempt — a failed build in this session surfaces a memoized error on later calls, and you resume by starting a new session or running `/zg-index` (which bypasses the memo). `mode=rg` is the documented escape hatch when you want an indexless query.

**Background daemon after the first build.** Once the first index build succeeds, the extension asks zg to start its background daemon (`zg server on`, loopback-only, detached). The daemon keeps the index fresh through a watcher and an hourly reconciliation pass and reuses the embedding model across runs. Set `PI_ZG_SERVER` to any non-empty value to opt out and manage the daemon yourself.

**System-prompt nudge.** On every agent turn, the extension appends a short note telling the model to prefer `zg` over `grep`/`find`, with concrete mode guidance (`hybrid` for intent, `fts` for symbols, `vector` for paraphrases, `rg` for exact matches). The note also spells out when to fall back: zero results, a tool error, or a `possibly_stale` flag on content the agent just edited. Set `PI_ZG_GUIDANCE` to any non-empty value to disable the nudge.

## Configuration

All env vars are read from the pi process environment (set them before launching pi). The "any non-empty value" convention means setting `PI_ZG_AUTO_INSTALL=1` is the same as `PI_ZG_AUTO_INSTALL=please-stop`.

| Variable              | Effect when set to any non-empty value                                                    |
|-----------------------|-------------------------------------------------------------------------------------------|
| `PI_ZG_BIN`           | Path to the `zg` binary. Skips PATH lookup. If set but the binary is not executable there, the extension errors out (no fallback). |
| `PI_ZG_AUTO_INSTALL`  | Never auto-install. Error surfaces the exact manual command.                              |
| `PI_ZG_GUIDANCE`      | Do not append the system-prompt nudge.                                                    |
| `PI_ZG_SERVER`        | Do not start the zg daemon after the first build.                                         |

## Troubleshooting

**Install fails.** Run the manual command the extension surfaces:

```bash
npm install -g @zvec/zvec-grep
```

On hosts without node-gyp the first attempt can fail on sharp's optional postinstall. The extension retries once with `--ignore-scripts`; sharp ships a prebuilt binary so the retry works. If both attempts fail, the same manual command above always works.

**Offline first index.** The first `zg index` run downloads a local embedding model. If the download fails, the error surfaces verbatim in the tool output. Reconnect, or pre-stage the model cache, and retry.

**`mode=rg` works without an index.** Use it when the index is broken or you want to skip the build step entirely.

**Parse miss.** If upstream changes its output shape, the tool falls back to raw text passthrough prefixed with a hint to run `/zg-status` and file an issue at [carvalab/pi-zgrep](https://github.com/carvalab/pi-zgrep/issues). The fixtures under `test/fixtures/` are the compat tripwire for the parser.

**Windows: not supported in 0.1.0.** The resolver spawns `zg` directly with `shell: false`, which cannot launch npm's `.cmd` shims. macOS and Linux only.

## Out of scope in 0.1.0

No override of pi's native `grep`/`find`, no MCP-client mode, no custom TUI rendering, no `@`-mention autocomplete, no bundled skills, no remote embeddings.

## Development

```bash
git clone https://github.com/carvalab/pi-zgrep.git
cd pi-zgrep
npm install
npm run test            # unit tests (parser, arg builder, ensure chain, guidance)
ZG_TEST_E2E=1 npm run test:e2e   # real zg engine required on PATH
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
