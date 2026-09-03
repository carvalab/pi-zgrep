# AGENTS.md

## What this repo is

`pi-zgrep` (npm: `pi-zgrep`, repo: `carvalab/pi-zgrep`) is a [pi](https://github.com/earendil-works/pi-coding-agent)
extension that exposes the upstream **zg** engine as **one pi tool**: semantic,
BM25, hybrid, and ripgrep search with automatic indexing.

The engine is [zvec-ai/zvec-grep](https://github.com/zvec-ai/zvec-grep)
(npm `@zvec/zvec-grep`, binary `zg`). This package is an **integrator, not the
engine** — it ships `@zvec/zvec-grep` as a real npm dependency and resolves the
binary (dependency → PATH → global install fallback), translates a tool call
into `zg` argv, parses stdout back into a structured result.

## Philosophy

- **Thin integrator.** No search logic here. All heavy lifting happens in the
  upstream binary; if a feature needs engine work, it belongs upstream.
- **Fixtures are the compat tripwire.** `test/fixtures/` holds captured output
  from real `zg` runs. The arg builder and parser are pinned against them.
  Upstream changing its CLI/output shape fails our tests before it fails users.
- **Degrade, don't crash.** A parse miss falls through to raw passthrough
  prefixed with a hint (`/zg-status` + issues link). Never throw at the user
  over a shape change.
- **No MCP in pi.** Upstream ships an MCP server; pi has no MCP host. This
  extension's tool functions are the reference mapping of upstream's MCP tool
  surface onto a native pi tool. When upstream adds or changes MCP tools,
  mirror them here (see `src/index.ts` tool registration).
- **Zero build.** Ships plain TypeScript (`src/*.ts`); pi loads `.ts`
  extensions directly. No compile step, no dist.

## Upstream tracking & version compatibility

- **Where to check for updates:** GitHub releases at
  `zvec-ai/zvec-grep` (npm publishes in lockstep as `@zvec/zvec-grep`,
  historically every 1–2 weeks).
- **Current compat baseline: zg 0.2.1** (2026-09-01). Fixtures, arg-builder
  expectations, and the e2e notes in `test/e2e.test.ts` capture that version.
- **Update procedure when upstream releases:**
  1. `npm install -g @zvec/zvec-grep@latest` (or set `PI_ZG_BIN`), and bump
     the `@zvec/zvec-grep` range in `package.json` in the same release.
  2. `npm run test:e2e` — unit fixtures pin old behavior, so also watch for
     new upstream flags/tools announced in the release notes or its MCP docs.
  3. If fixtures fail: re-capture per README §Fixtures, update the version
     notes in `test/e2e.test.ts`, bump this package's version, release.

## How to check (verification ladder)

```bash
npm run lint           # oxlint
npm run format:check   # oxfmt
npm run typecheck      # tsc --noEmit
npm test               # 48 hermetic unit tests — no zg binary needed
ZG_TEST_E2E=1 npm run test:e2e   # real zg binary, hermetic (scratch dir, cached model)
```

CI runs the first four on every push/PR; run e2e locally before releases or
whenever fixtures/upstream versions change. The e2e suite exercises the real
spawn path: index → semantic / fts / vector / hybrid / rg queries against
`test/fixtures/sample-project/`.

Upstream-version safety nets: Dependabot opens a range-bump PR when upstream
releases outside `^0.2.1` (CI runs the fixture tripwires on that PR), and the
weekly [canary](.github/workflows/canary.yml) overlays
`@zvec/zvec-grep@latest` and runs unit + e2e, opening or closing a `canary`
labeled issue on the result. Patch releases inside the range are caught by
the canary, not Dependabot.

### Manual smoke (live pi run, log-checked)

Interactive: `pi -e .` in this repo (or `pi install npm:pi-zgrep`), then run
the tool and `/zg-status`. The engine resolves from the packaged dependency
first; `PI_ZG_BIN` overrides binary lookup; without either (and without `zg`
on PATH) the extension auto-installs `@zvec/zvec-grep` globally on first use.

Non-interactive (what an agent should run — real model, real spawn path,
session log to inspect):

```bash
# 1. Run pi with the extension loaded; -p processes the prompt and exits.
#    Requires one authed provider (pi auth check --provider <p>).
timeout 240 pi -e . -p --session-dir /tmp/pi-zgrep-smoke -n zg-smoke \
  "Use the zg tool (only this tool) with query 'parse stdout' mode hybrid \
  limit 3 on this workspace. Reply with just the top 3 file paths."

# 2. Check the log: the session must contain a "zg" tool call, and the
#    printed paths must be real files in this repo (e.g. src/index.ts).
grep -o '"name":"zg"' /tmp/pi-zgrep-smoke/*.jsonl   # expect ≥1 hit
```

Pass = the command prints real file paths and the log shows the `zg` tool
call. Fail = pi loads but the model says it has no `zg` tool (extension
didn't register — check for a load error at startup), or the tool errors
(check `zg --version` works and `PI_ZG_BIN` isn't pointing at junk).

Without `--session-dir`, pi writes session logs to
`~/.pi/agent/sessions/<flattened-cwd>/<timestamp>_<uuid>.jsonl`; the
`toolCall`/`toolResult` records with `"name":"zg"` are what to grep.

Known failure mode (hit 2026-09-03): tool returns `zg index failed … zvec
file metadata storage does not exist`. That is a stale/broken gitignored
`.zvec-grep/` index in the workspace (interrupted build), not an extension
bug — the e2e suite still passes. Fix: `rm -rf .zvec-grep && zg index`, then
re-run the smoke.

## Repo map

- `src/index.ts` — extension entry: tool registration, Runner, spawn plumbing
  (`awaitChild` races close/error; never await the loser — `once(child,
  "error")` never settles on clean exits)
- `src/args.ts` — tool args → `zg` argv (rg routes drop `--preview`/`--mode`)
- `src/parse.ts` — `zg` stdout → structured result; raw passthrough on miss
- `src/zg.ts` — global install (npm -g, bun fallback, `--ignore-scripts`
  retry), PATH probe, version capture
- `test/` — fixture contract tests + `e2e.test.ts` (gated by `ZG_TEST_E2E=1`)

## Release

Tag `v*` → `.github/workflows/release.yml` publishes via npm **Trusted
Publishing (OIDC)** — no stored tokens. Workflow: lint + typecheck + tests,
tag/version match check, `npm publish --provenance`, then a `release` job that
extracts the tag's section from `CHANGELOG.md` and creates or updates the
GitHub release. The changelog is curated, not generated: before tagging, run
`git-cliff` (config in `cliff.toml`) for a raw commit draft, rewrite the
section as user-facing notes, and commit `CHANGELOG.md`. A missing section
fails the release job loudly rather than shipping empty notes. The npmjs.com Trusted
Publisher must name repo `carvalab/pi-zgrep`, workflow `release.yml`,
environment `npm`, action `npm publish`. Package record bootstrapped locally
(`pi-zgrep@0.0.0`) because OIDC cannot create a package (npm/cli#8544).

### pi.dev visibility

The pi package catalog (https://pi.dev/packages) lists npm packages tagged
`pi-package`. This repo already qualifies: the keyword is set, the `pi`
manifest declares `pi.extensions`, and peerDeps match the documented core set
(`@earendil-works/pi-coding-agent`, `typebox`, `"*"` ranges). The engine is a
real `dependencies` entry — pi's installer runs plain `npm install`, so it
lands at package-install time with zero lifecycle scripts. That is deliberate:
npm 12 blocks dependency postinstalls by default (RFC 0054) and pi's installer
doesn't opt in, so any install-script-based bootstrapping would silently
never run. Upstream supports this: prebuilt `@zvec/bindings-*` platform
packages arrive as optional deps, no build step. The runtime `npm -g` install
survives only as a fallback for dev checkouts (`pi -e .`). Binary resolution
order: `PI_ZG_BIN` → packaged dependency → PATH → global install. Do not move
runtime deps into `devDependencies` — pi installs packages with `--omit=dev`.
Publishing a real version (tag `v*`) is still pending: the 0.0.0 record on npm
is the bootstrap placeholder and carries the pre-rename repo URL
(`carvalab/pi-zg`); the next publish fixes the URL and makes the listing real.
