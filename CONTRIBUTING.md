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

CI runs the same set on Ubuntu and Windows, Node 22, 24, and 26, then the embedding-model load test (`test/model-load.test.ts`, gated on `ZG_TEST_MODEL=1`). A separate job runs `npm run test:pi`, a real pi session against a pinned free OpenRouter model (`PI_ZG_IT_MODEL` overrides it), and skips it when `OPENROUTER_API_KEY` is unset.

## Tests

- Unit tests run by default: `npm run test`.
- End-to-end tests need the bundled 0.3.0 platform package (`npm install` brings it; the binary is `node_modules/@zvec/zvec-grep-<os>-<arch>[-<libc>]/bin/zg`, so nothing needs to be on PATH) and opt in via env var: `ZG_TEST_E2E=1 npm run test:e2e`. They index `test/fixtures/sample-project/` in a scratch dir and exercise all four query routes.
- `test/model-load.test.ts` checks that `zg --index` loads the local embedding model (issue #6). It opts in via `ZG_TEST_MODEL=1` and downloads the model on a cold cache, so it stays out of the default run. CI runs it on every job.
- `npm run test:pi` tests the package a user installs (`tools/pi-integration.mjs`): it `npm pack`s the repo, installs that tarball with `pi install npm:<tgz>` into a scratch agent dir, asserts the installed `node_modules/@zvec/zvec-grep-<platform>/bin/zg` reports 0.3.x, then runs one real pi session that loads the installed package (no `-e`) and parses the session JSONL for the zg toolResult — it must not be an error and its structured `details.results` must hit `hello.ts`. It needs `OPENROUTER_API_KEY`, read from the environment or a gitignored `.env`, and exits cleanly without one, self-checking the assertions and the failure classification against handcrafted session files instead. `PI_ZG_IT_NEGATIVE=1` runs the same session with `PI_ZG_BIN` pointing at a missing path, which must fail; run it by hand to prove the assertions bite. It uses the backup model, since a throttled free endpoint would fail before zg is called and mask the engine (`PI_ZG_IT_NEGATIVE_MODEL` overrides that). A session that fails on the provider side (HTTP 4xx/5xx, 429, a model that demands reasoning, no assistant message, a model that called no tool) is retried once on the backup model and then ends as `INCONCLUSIVE: <reason>` with exit 0 and a `$GITHUB_STEP_SUMMARY` line, because it never exercised the package; anything extension-side (a zg tool error, no fixture hit, a failed install or version check, no zg tool in the prompt) exits 1 and is never retried. `PI_ZG_IT_MODEL`, `PI_ZG_IT_BACKUP_MODEL`, and `PI_ZG_IT_THINKING` override the pins.

## Fixture regeneration

`test/fixtures/` holds captured output from real `zg` 0.3.0 runs (help text, status before/after index, query output per route, index output). They are the compat tripwire for both the arg builder and the parser; `test/fixtures/NOTES.md` records the argv behind each file.

To regenerate one, delete the file and re-run the argv in the `test/fixtures/NOTES.md:11-25` table (0.3.0 flags). Alternatively, copy from a fresh `zg` run against `test/fixtures/sample-project/`. The Task 3 capture commands in `doc/plans/2026-09-02-pi-zg-extension.md` predate 0.3.0 (`zg query --help`, `zg status`, `zg index`) and yield the old shapes. Commit the regenerated fixtures in the same PR as any parser or arg-builder change they support.
