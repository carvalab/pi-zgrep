# pi-zg — zg (zvec-grep) semantic search as a pi extension, v0.1.0

Date: 2026-09-02 · Status: draft for review · Repo (to create): `carvalab/pi-zg` (public) · npm: `pi-zg@0.1.0`

## Problem

pi agents search code with lexical tools only (grep/find/ffgrep). zg (`zvec-ai/zvec-grep`, npm `@zvec/zvec-grep`) adds local-first semantic + BM25 + hybrid search with relevance ranking and exact-ripgrep verification, and its benchmarks show ~half the tool calls and tokens for retrieval-heavy tasks. pi has no zg integration. pi-zg is the pi package that gives the agent one `zg` tool, keeps the engine and index healthy without user involvement, and tells the agent to prefer zg over grep/find.

## Locked decisions (from questionary)

1. **Engine**: global `zg` CLI on PATH. If absent, pi-zg auto-installs it (`npm install -g @zvec/zvec-grep`, bun fallback). User rule: never make the user leave pi to install.
2. **Index**: never wait for the user to index. pi-zg probes and builds the index on first use; zg maintains it afterwards.
3. **Guidance**: system-prompt note appended via `before_agent_start` (the mechanism graphify's pi extensions use) + strong tool description telling the agent to prefer zg before grep/find (user request; ponytail's skills use the same steer-the-agent idea).
4. **License/publish**: MIT. CI on every push; releases via GitHub Actions.
5. **Tool surface**: one `zg` tool (mode param) + `/zg-index` + `/zg-status`. No override of native grep/find in 0.1.0.
6. **Transport**: spawn the `zg` CLI per call (`--mode auto`). No MCP client, no daemon ownership in 0.1.0.
7. **Version**: 0.1.0. Name reserved on npm as `pi-zg@0.0.0` placeholder (in progress; needs user's 2FA publish).

## Architecture

Thin TypeScript pi package, **no build step** (pi loads TS via jiti). One extension factory registers the tool, commands, and guidance, and shells out to `zg` with array args (`shell: false`).

```
agent ──calls──▶ zg tool ──ensure──▶ [zg binary?] ──▶ [index ready?] ──▶ spawn `zg query …`
                    │                                        │ first build only
                    └─ /zg-index, /zg-status                 └─ after first build: fire `zg server on` (detached, best-effort)
guidance: before_agent_start appends 3-line preference note to system prompt
```

Files (whole repo):

```
pi-zg/
├── package.json          # pi manifest, keywords ["pi-package"], peerDeps, engines node>=22
├── README.md             # badges, one-line pitch, install, agent-facing tools, commands, env vars, troubleshooting
├── LICENSE               # MIT
├── CONTRIBUTING.md
├── .gitignore
├── tsconfig.json         # typecheck only (no emit)
├── ultracite config      # oxlint + oxfmt via `npx ultracite init`
├── src/
│   ├── index.ts          # extension factory: registerTool, registerCommand ×2, before_agent_start guidance
│   ├── zg.ts             # binary resolve + auto-install + spawn helpers (promise-locked install)
│   └── parse.ts          # parse `zg query` default output → structured results
├── test/
│   ├── parse.test.ts     # fixtures captured from real `zg query` runs
│   ├── args.test.ts      # query arg builder (routes, limits, globs, refresh)
│   ├── ensure.test.ts    # ensure-chain state machine (mocked spawn)
│   └── guidance.test.ts  # guidance text + opt-out
└── .github/workflows/
    ├── ci.yml            # ultracite lint + format check + typecheck + unit tests
    └── release.yml       # tag v* → npm publish (0.1.0 via NPM_TOKEN secret; OIDC afterwards)
```

### Components

**Binary resolver + auto-install (`src/zg.ts`)** — resolution order: `PI_ZG_BIN` env → `zg` on PATH (probe `zg --version`, 10s timeout). Semantics: `PI_ZG_BIN` set but missing/not executable → error naming the env var (no fallback); probe timeout with zg expected on PATH → error (no reinstall fallthrough — a slow binary must not trigger a global reinstall); binary absent (ENOENT) → auto-install path. If `PI_ZG_AUTO_INSTALL` is set to any non-empty value (convention: `=1`), skip install and error with the exact manual command; else run `npm install -g @zvec/zvec-grep` (bun `add -g` fallback when npm absent), streaming progress via `ctx.ui.setStatus("pi-zg", …)`; concurrent callers share one in-flight install promise. Version below 0.2 → warning only (upstream is pre-1.0).

**Index ensure** — `zg status --check-ready` (exit code is the API: 0 = ready, non-zero = not ready; the status *text* carries the reason). Shared in-flight locks (module-level promises, same pattern as install) for index build and for daemon start, so parallel tool calls on a cold index spawn exactly one build and one `zg server on`. Non-zero probe → run `zg index` in `ctx.cwd` unless this session already attempted a build for this root and it failed (session-scoped attempt memo prevents silent rebuild loops on genuine failures — second probe failure surfaces `zg status` text verbatim as a tool error instead). Build progress streams through the tool's `onUpdate`; abort signal (Esc) kills the child; incremental rebuilds make a killed build cheap to resume. First build on a machine also downloads the local embedding model (tens of MiB) — routed through the same progress stream; offline machines fail here and the error surfaces verbatim. Typical first build ≈ seconds-to-minutes (Django ≈ 30s on M4 Pro per upstream docs). After a successful first build, fire `zg server on` once, detached, ignore failure (opt-out: `PI_ZG_SERVER` set to any non-empty value) — zg's daemon then handles background refresh, watcher-driven updates, hourly drift reconciliation, and embedding-model reuse (verified: upstream `docs/06-server.md` § Refresh behavior); `# ponytail: fire-and-forget daemon start; add health surfacing in /zg-status if users report issues`.

**`zg` tool** — parameters (typebox): `query` (string, required); `mode`: `hybrid` (default) | `fts` | `vector` | `rg`; `limit` (number, default 10, max 50); `glob`, `type` (optional string filters); `refresh`: `auto` (default) | `wait` (forces `--refresh wait` when the agent needs post-edit freshness); `preview`: `short` (default) | `none`. Mapping: hybrid → positional query; fts → `--fts`; vector → `--vector`; rg → `--rg` (indexless); indexed (hybrid/fts/vector) routes additionally pass `--limit`, `--preview`, `--mode auto`, and `-g`/`-t` filters; `rg` passes only `--limit` plus `-g`/`-t` because real `zg` v0.2.1 rejects `--preview`/`--mode`/`--refresh` alongside `--rg` (captured in the fixture notes and the gated e2e test). Two orthogonal axes, never conflated: `--mode auto` is **client transport routing** (use the server daemon when ready, else direct) and is passed on every indexed call; the tool's `mode` param is the **search route** (`--fts`/`--vector`/`--rg`/positional). The arg builder is fixture-checked at implement start against captured `zg query --help` / `zg status --help` output (compat tripwire for the input surface, mirroring the output-parser tripwire). Execute = ensure binary → ensure index (skipped for `rg`) → spawn → parse. Details carry parsed JSON (file, line range, score, snippet) for future TUI use; content is the rendered text, one line per result in the form `path:line-start-line-end  score  first-snippet-line` (ripgrep-style), grouped under a one-line freshness note.

**Output parsing (`src/parse.ts`)** — zg has **no JSON flag**; parser targets the default (non-`--human`) listing format. Fixtures are captured from real runs on this machine at implement time (TDD: fixture first, then parser); `zg status` output gets the same fixture + raw-fallback contract. Parse miss → return raw `zg` stdout as text, clearly prefixed; **never fabricate structure**. Upstream is pre-1.0 and documents that commands may change — the fixture suites are the compat tripwire.

**Commands** — `/zg-index [args…]` (pass-through, e.g. `--rebuild`): commands have no `onUpdate` stream, so progress surfaces as `ctx.ui.setStatus("pi-zg", …)` updated per progress line, `ctx.ui.notify` at start/finish milestones, and the handler's return as the final summary (files indexed, duration, or verbatim error). `/zg-status` renders: binary path + version, index ready/not + freshness, daemon on/off (one line each; raw `zg status` text appended on parse miss).

**Guidance** — `before_agent_start` (an extension hook that can append to `event.systemPrompt` for the turn) appends the note when the tool is registered, unless `PI_ZG_GUIDANCE` is set to any non-empty value (unset or empty = guidance on). Text (≈3 lines): prefer `zg` for code/content search — `hybrid` for intent/natural-language questions, `fts` for known symbols/identifiers, `rg` for exact literal/regex; fall back to grep/find only when (1) `zg` returns zero results, (2) the tool errors, or (3) results report `possibly_stale` for content just edited this session. The tool description repeats the preference in one line (models weight descriptions).

## Data flow

1. Agent calls `zg { query: "where is theme restored", mode: "hybrid", limit: 10 }`.
2. Resolver finds (or installs) the binary.
3. `status --check-ready` → if not ready, `zg index` streams progress, then continues.
4. `zg query "where is theme restored" --limit 10 --preview short --mode auto` in `ctx.cwd`.
5. Parser returns ranked `file:line` results; the agent reads files with pi's native read tool.

## Error handling and edge cases

- **Install failure / no package manager** → tool error containing the exact manual command.
- **First index on a huge repo** → progress streamed; agent or user can abort (Esc); incremental resume on retry. `mode=rg` documented as the indexless escape hatch.
- **Stale index** → `--mode auto` + daemon reconciliation covers routine drift; `refresh: "wait"` for the rare need-latest case; results may report `possibly_stale` — surfaced, not hidden.
- **Parse miss (upstream format change)** → raw text passthrough + `/zg-status` hint to file an issue.
- **Abort mid-spawn** → child killed via `signal`; no orphaned installs (promise lock releases on failure).
- **Non-workspace dirs / empty repos** → zg's own errors surfaced verbatim.
- **Offline machine, first index** → embedding-model download fails; zg's error surfaces verbatim (see Index ensure).

## Testing approach

`node:test`, no framework. Unit: parser against captured fixtures (query **and** status output), arg builder against captured `--help` output, ensure-chain with mocked spawn across its named states (`unresolved → probing → installing → indexing → ready`, plus error exits and the session build-attempt memo), installer selection, guidance opt-out. Integration (`ZG_TEST_E2E=1`, skipped in CI by default): index a tiny fixture dir, run a real query in **all four modes**, assert the fixture file appears. CI runs lint + format check + typecheck + unit tests on Node 24.

## Repo, tooling, publish

- `gh repo create carvalab/pi-zg --public` at implementation start; this spec is the first commit on the work branch.
- Tooling from minute zero: `npx ultracite init` → **Oxlint + Oxfmt** provider (user requirement: oxc via ultracite; ultracite v7 is multi-provider — verify the chosen provider at init; if the version landing doesn't offer oxlint/oxfmt, depend on `oxlint` + `oxfmt` directly). Scripts `lint` / `format` / `typecheck` / `test`.
- Commit messages and release PR descriptions run through the `humanizer` skill per `~/.pi/agent/AGENTS.md`.
- package.json: `name: pi-zg`, `version: 0.1.0`, `keywords: ["pi-package","pi","zg","zvec-grep","semantic-search","ai-agent"]`, `pi.extensions: ["./src/index.ts"]`, peerDeps `@earendil-works/pi-coding-agent` + `typebox` (`"*"`), `engines.node >=22`, no runtime dependencies.
- npm: as of spec time the `pi-zg@0.0.0` reservation publish is pending the owner's 2FA OTP; whether or not it completes, the first 0.1.0 publish creates/claims the record. 0.1.0 publishes with `NPM_TOKEN` secret (first publish cannot use OIDC — npm/cli#8544); after attaching the GitHub trusted publisher on npmjs.com, release.yml switches to OIDC (`id-token: write`, npm ≥ 11.5.1) and the token is removed.

## Documentation impact

- Feature / user-facing docs introduced: `README.md` (install, tools, commands, env vars, troubleshooting, guidance explanation); `CONTRIBUTING.md` (brief).
- Materially amended existing docs: none (greenfield).
- Derived / memory docs invalidated: none.

## Out of scope (v0.1.0)

Overriding native grep/find; MCP-client mode; daemon lifecycle management beyond fire-and-forget start; custom TUI rendering; `@`-mention autocomplete; bundled skills; remote-embedding configuration; **Windows support** (the resolver spawns `zg` directly with `shell: false`, which cannot launch npm's `.cmd` shims — README troubleshooting states Windows is unsupported in 0.1.0); Windows CI. CI runs on ubuntu.

## Open questions

None blocking. Guidance wording is finalized during review of the spec's proposed text.
