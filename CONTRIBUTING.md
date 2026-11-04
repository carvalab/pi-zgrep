# Contributing

PRs welcome.

## Workflow

Branch off `main`. Open a pull request and let CI run. Reviewers will leave comments; squash or rebase to taste.

## Commit messages

Imperative subject, short body when needed. Run them through the `humanizer` skill per `~/.pi/agent/AGENTS.md` before pushing so the message reads like a person wrote it.

## Required verification

All four commands must pass before you open a PR:

```bash
npm run lint && npm run format:check && npm run typecheck && npm run test
```

CI runs the same set on Ubuntu and Windows, Node 22, 24, and 26, then the embedding-model load test (`test/model-load.test.ts`, gated on `ZG_TEST_MODEL=1`). A separate job runs `npm run test:pi`, a real pi session against `openrouter/free`, and skips it when `OPENROUTER_API_KEY` is unset.

## Tests

- Unit tests run by default: `npm run test`.
- End-to-end tests need the bundled 0.3.0 platform package (`npm install` brings it; the binary is `node_modules/@zvec/zvec-grep-<os>-<arch>[-<libc>]/bin/zg`, so nothing needs to be on PATH) and opt in via env var: `ZG_TEST_E2E=1 npm run test:e2e`. They index `test/fixtures/sample-project/` in a scratch dir and exercise all four query routes.
- `test/model-load.test.ts` checks that `zg --index` loads the local embedding model (issue #6). It opts in via `ZG_TEST_MODEL=1` and downloads the model on a cold cache, so it stays out of the default run. CI runs it on every job.
- `npm run test:pi` drives a real pi session (`tools/pi-integration.mjs`) and checks the session log for a zg tool call that returns the fixture file. It needs `OPENROUTER_API_KEY`, read from the environment or a gitignored `.env`, and exits cleanly without one.

## Fixture regeneration

`test/fixtures/` holds captured output from real `zg` 0.3.0 runs (help text, status before/after index, query output per route, index output). They are the compat tripwire for both the arg builder and the parser; `test/fixtures/NOTES.md` records the argv behind each file.

To regenerate one, delete the file and re-run the argv in the `test/fixtures/NOTES.md:11-25` table (0.3.0 flags). Alternatively, copy from a fresh `zg` run against `test/fixtures/sample-project/`. The Task 3 capture commands in `doc/plans/2026-09-02-pi-zg-extension.md` predate 0.3.0 (`zg query --help`, `zg status`, `zg index`) and yield the old shapes. Commit the regenerated fixtures in the same PR as any parser or arg-builder change they support.
