# Changelog

All notable changes to pi-zgrep. Release sections are curated before tagging (user-facing notes, not commit subjects); `git-cliff` with `cliff.toml` drafts the raw commit list to rewrite from.

## [v0.7.0] - 2026-11-03

**Breaking**

- Requires zg ≥ 0.3.0. zg 0.3.0 is a native Rust rewrite with an rg-style CLI, so the extension emits `zg --hybrid|--fts|--vector <query>`, `zg --rg <pattern>`, `zg --index`, `zg --status` and `zg --server on|off|status` only; the 0.2.x subcommand forms are gone. An older binary is now rejected by name instead of being handed flags it would read as search text.
- `PI_ZG_BIN` is exclusive and self-diagnosing. When set it is the only candidate: missing, non-executable, the unmaterialized install stub, or older than 0.3.0 all produce one error naming the variable, the path and the version found — never a silent fallback to the bundled engine or PATH.

**Added**

- Bundled-engine resolution for the native package: read `platforms.json`, locate `@zvec/zvec-grep-<os>-<arch>[-<libc>]`, verify `bin/<binary>` against the shipped `checksums.json` (byte length plus sha256), then fall back to a materialized `bin/zg.exe` that passes an ELF/PE/Mach-O magic check. The resolver is injectable, so unit tests never reach a real `node_modules`.
- `/zg-status` now reports every rejected candidate with its path, version and reason; `/zg-server on` replaces a leftover 0.2.x daemon in place instead of failing on the protocol mismatch.
- Upgrade path from 0.2.x needs no user action: an unreadable legacy index shows up as `rebuild required` and is rebuilt exactly once with `--index --rebuild`, and the first session's `--server on` performs the daemon migration.
- Hits the engine marks `status: possibly_stale` are flagged to the model. zg writes that line on each hit while its index catches up with an edit, and it is the only stale signal on stdout (the `results:`/`background_refresh:` run trailer goes to stderr, which the tool does not read). The result text now carries one `Note: index is refreshing; N result(s) marked possibly_stale may be outdated. Re-run or use mode=rg for exact current text.` line, and `results[]` in `structuredContent` gains `stale: true`, so the `possibly_stale` fallback the tool description asks for is finally actionable.

**Changed**

- Installs that block lifecycle scripts keep working (npm 12 / RFC 0054 defaults, `--ignore-scripts`) because the per-platform package already ships the binary; the sharp/node-gyp workaround and the retry dance are gone. Only `--omit=optional` breaks search, and the error now says to reinstall without it or set `PI_ZG_BIN`.
- The runner spawns the native binary directly (never through `node`) and prefers the bundled engine over PATH; a PATH copy is used only when no platform package resolves.
- The parser reads 0.3.0 output — `#1 <path>:<start>-<end>` result blocks, `No matches.` as an empty result set, and the Coverage note `Unavailable (rebuild required)` as freshness — and returns raw passthrough for any structural miss instead of fabricating fields. On a stale index, each hit is stamped `status: possibly_stale` on stdout while the index catches up and still parses into a hit with `stale: true`; the run trailer (`results: …`, `background_refresh: …`) goes to stderr and is not parsed.
- `/zg-index` forwards a bare word only when it exists on disk (upstream rejects an unknown root with `Error[ZG.ENGINE.NOT_FOUND]: resolve directory …`, exit 1); anything else gets a usage line instead of a doomed build.

**Fixed**

- The install-scenario matrix — bundled engine, rejected 0.2.1, omitted optional deps — is pinned by tests, so a resolution regression fails CI instead of shipping.
- The first index on a fresh repo no longer fails with `ZG.ENGINE.NOT_FOUND`: a build that starts from nothing passes `--embedding` explicitly, resolved from `ZVEC_GREP_EMBEDDING`, then `PI_ZG_EMBEDDING`, then the local default `local/potion-code-16m-v2`.
- Session warmup has a lifecycle. A reload (`/new`, resume) or a shutdown now cancels the warmup it replaces instead of leaving the previous `zg --index` running and pushing progress into a dead session, and a cancelled build is no longer memoized as a failed index — that memo made every later call in the new session answer `previous build attempt failed` and never index again. Thanks to Rodrigo Jäger (@rodrigojager).
- A usable but stale index is served instead of rebuilt. `zg --status --check-ready` exits nonzero with `(needs update)` as soon as files wait for a refresh, which used to mean a blocking rebuild at session start; zg 0.3.0 answers every indexed query from that index anyway, stamping each hit `status: possibly_stale`, so the daemon refreshes it in the background instead. `refresh: "wait"` forces the refresh for one query and `/zg-index` still rebuilds on demand. Thanks to Rodrigo Jäger (@rodrigojager).
- A failed `zg --index` always reports zg's own output. The last progress lines were buffered only when the caller passed a progress callback, so the one build that has no such callback — the session warmup — failed with a bare exit code. Thanks to Rodrigo Jäger (@rodrigojager).

## [v0.6.0] - 2026-10-16

- Each repository now searches its own index. zg resolves the index by looking in the current folder and then in each parent folder, with no stop at a repository, and its builds skip nested git repos. One index left in a parent folder (seen live in `~/Dev`) answered for every repo below it: the status said ready and every semantic query returned the parent's files. A `.git` between the current folder and that parent index is now a boundary, and the repo gets its own index on first use. The first such build runs in direct mode, because the zg 0.2.2 daemon resolves the requested root back to the parent and rebuilds that instead.
- Function and symbol hits parse again. zg 0.2.2 adds an `outline:` section to those hits, containing a blank line and a `calls:` list. The parser stopped at the blank line, hit `calls:`, and returned the entire result as unparsed raw text. It now reads each hit's block up to the next hit, and a captured fixture pins the shape.
- Automatic builds never index the home directory or the filesystem root; the tool suggests `mode=rg` there. `/zg-index` still can.
- Every build passes an explicit root to `zg index`.
- The tool now uses pi's tool-prompt API. A `promptSnippet` lists it under "Available tools" (pi left it out before), and the routing advice is `promptGuidelines` instead of a `before_agent_start` hook that replaced the whole system prompt every turn. `PI_ZG_GUIDANCE` still opts out.
- Custom TUI rendering: the call shows mode, query, and filters; the result shows the hit count and paths, with snippets and the full-output path when expanded, and build progress while it runs.
- Output follows pi's truncation convention (2000 lines / 50KB, 500 characters per line), with the full text saved to a temp file the result names.
- Zero results say `No matches (mode=…)` with a next route to try, instead of an empty string. A page that fills `limit` says so.
- `prepareArguments` repairs common argument slips before validation: string or out-of-range `limit`, mode synonyms (`semantic`, `bm25`, `grep`), `null` optionals, and `pattern`/`q` for `query`.
- The tool declares `readOnlyHint`/`openWorldHint` annotations and an `outputSchema`, and returns `structuredContent` for codemode scripts.
- Invalid input (a leading `-` query outside `mode=rg`) is rejected before any install, probe, or build.
- New gallery image for pi.dev and the README, built from real output on this repo (`doc/assets/gallery.html` is the source).
- Tested against pi 1.3.0, now a dev dependency. `@earendil-works/pi-tui` is a declared peer dependency.

## [v0.5.0] - 2026-10-14

- Windows support, contributed by Rodrigo Jäger (@rodrigojager). The launcher resolves npm `.cmd` shims and runs packaged `.js`, `.mjs`, and `.cjs` entries through Node, result paths keep spaces, Unicode, and drive letters, and `/zg-index` preserves quoted roots and flag values. CI now runs on Windows across Node 22, 24, and 26.
- His review also fixed bugs that affect every platform: a query uses the current call's cancellation instead of the first call's cached runner, a nonzero `zg` exit comes back as a tool error, index errors on stderr reach the progress output, an empty result set parses as no hits, and an already-aborted signal kills the child.
- The package now ships his `pi-zgrep-search` skill, so pi loads it alongside the extension.
- CI runs a real pi session against `openrouter/free` and checks that the model calls the zg tool and gets the fixture file back. It skips when no `OPENROUTER_API_KEY` is configured.

## [v0.4.2] - 2026-10-14

- The README leads with what 0.4 fixed: the print-mode crash, `/zg-status` announcing itself, `/zg-server`, and the `/zg-index` flag suggestions. The pi.dev package page renders the README, so none of that was visible there.

## [v0.4.1] - 2026-10-14

- The README now documents `/zg-server`, the `/zg-index` flag suggestions, and that the daemon starts at session start and is shared across sessions. It also fixes a stray character that broke the `/zg-status` line on the pi.dev package page.

## [v0.4.0] - 2026-10-14

- Print-mode runs (`pi -p "…"`) no longer crash with a stale-ctx dump and exit 1. Session warmup is background work that can outlive a short session, and pi invalidates the event ctx when the session ends; the trailing status update then threw an uncaught "This extension ctx is stale" that killed the process. Any non-interactive run of a script or agent harness that shelled out to pi hit this, every time. Fixed for session warmup and for every other path that runs work in the background (the `/zg-index`, `/zg-status`, and `/zg-server` commands, and the tool's install progress) — a background task that outlives its session now simply stops reporting instead of taking the process down.
- `/zg-status` now says it started, like `/zg-index` does, and shows a status line while it probes. It previously looked like a no-op until the result appeared.
- `/zg-index` now suggests `--device`, `--model-cache`, and `--allow-remote` in its argument completions. The command already forwarded every flag to `zg index`; these three just never appeared in the palette, which made them hard to discover as workarounds when embedding-model loading misbehaves.
- CI now runs the embedding-model load test on every job. The reported failure (`MODEL2VEC_LOAD_FAILED`, masked by a `uv_cwd` error) had no coverage.
- Installs and publishes are pinned to `registry.npmjs.org` via a repo `.npmrc`. Previously the registry followed whatever the machine had configured.

## [v0.3.0] - 2026-09-03

- New `/zg-server` command: start, stop, or inspect the daemon (`on|off|status`) without leaving pi. The daemon still starts on its own, and session warmup now revives it if it died between sessions, so one daemon serves all sessions (upstream enforces a single instance per home). `/zg-status` shows its real state instead of telling you to go run `zg server status` yourself.
- `/zg-index` no longer spawns doomed builds: flags pass straight through to `zg index`, a bare word forwards only when it is an existing workspace path, and anything else gets a usage line pointing at `/zg-status`.
- `/zg-index` and `/zg-server` suggest their arguments in the command palette as you type.
- The zg tool description now leads with "call this tool directly", states the index scope boundary (node_modules, .git, build outputs, and anything outside the workspace are not indexed), gives a concrete example per search mode, and lists all four legit reasons to fall back to grep.
- AGENTS.md documents why the packaged engine outranks any global binary, and the daemon lifecycle.

## [v0.2.2] - 2026-09-03

- npm metadata tune-up for the pi.dev package gallery and npm search: added the author field, broadened keywords (search, grep, hybrid-search, embeddings, rag, coding-agent), and sharpened the description so filters surface the package for the terms people actually type. No code changes.

## [v0.2.1] - 2026-09-03

- The `zg` tool description and the session-start guidance now say outright that `zg` is a tool to call directly, not a binary to run from a shell. This fixes agents that ran `which zg`, saw it fail, and quietly fell back to grep instead of using the tool.
- A regression test pins the no-binary wording in the guidance text so a future reword can't drop it.

## [v0.2.0] - 2026-09-03

- The zg engine now installs as a regular npm dependency: `pi install npm:pi-zgrep` brings everything with it, no lifecycle scripts involved, safe under npm 12's default script blocking.
- The index builds in the background at session start, so the first search of a session hits a ready index. One build runs per process, and the daemon from a previous session is reused instead of started twice.
- Binary resolution order: `PI_ZG_BIN`, then the packaged engine, then `zg` on PATH, then a global install on first use.
- README rewritten: payoff-first structure with a real output example, and benchmarks that point at upstream's suite (SWE-QA-Bench, BrowseComp-Plus) while ours stays as a local reference.
- Upstream-version safety nets: Dependabot bumps the engine range, and a weekly canary runs unit plus e2e against `@zvec/zvec-grep@latest`, managing a `canary`-labeled tracking issue automatically.

## [v0.1.1] - 2026-09-03

- Add benchmark vs ripgrep and grep with replication script ([76703f9](https://github.com/carvalab/pi-zgrep/commit/76703f9fc2c53cde87844a7f95ba239240d31523))
- Add gallery preview image and release 0.1.1 ([2ae789b](https://github.com/carvalab/pi-zgrep/commit/2ae789b197def015def7b3a359e7c92cc69fe8e2))

## [v0.1.0] - 2026-09-03

- Add zg tool, /zg-index and /zg-status commands, and spawn runner ([45edb0f](https://github.com/carvalab/pi-zgrep/commit/45edb0f94766e45ebb9414a7ba6789c590acb6c2))
- Add binary resolver and index ensure chain with concurrency locks ([4114d99](https://github.com/carvalab/pi-zgrep/commit/4114d99cb8f2310f6133a3dbe26b32d2233e3961))
- Add fixture-driven output parser with raw-passthrough fallback ([49dbdc1](https://github.com/carvalab/pi-zgrep/commit/49dbdc1aa5859208b5b4ba4b322278b6e270d35b))
- Add zg arg builder with help-fixture tripwire (rg route omits flags upstream rejects) ([152c4bc](https://github.com/carvalab/pi-zgrep/commit/152c4bc47c36fe65a720275dc2eba703ba3d9ba))
- Capture zg compat fixtures from the real engine (zg 0.2.1) ([022d721](https://github.com/carvalab/pi-zgrep/commit/022d7215534ed83db312f17d076f1c536efe0b6a))
- Add gated e2e tests driving buildQueryArgs against the real engine ([26f2955](https://github.com/carvalab/pi-zgrep/commit/26f2955b105c1d4a7b725786f68652188bf980bb))
- Add README, contributing guide, spec, and implementation plan ([a16fa47](https://github.com/carvalab/pi-zgrep/commit/a16fa478a559cfa78cbf591d1ec998b94f58ed5f))
- Scaffold package, toolchain, CI, and release workflow ([a59e2dc](https://github.com/carvalab/pi-zgrep/commit/a59e2dc264d0ef4ab46cc288d9213899662da6a1))

<!-- generated by git-cliff, curated by hand from 0.2.0 onward -->
