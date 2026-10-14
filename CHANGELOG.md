# Changelog

All notable changes to pi-zgrep. Release sections are curated before tagging
(user-facing notes, not commit subjects); `git-cliff` with `cliff.toml` drafts
the raw commit list to rewrite from.

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
