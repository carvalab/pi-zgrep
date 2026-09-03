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

CI runs the same set on Node 24.

## Tests

- Unit tests run by default: `npm run test`.
- End-to-end tests need a real `zg` binary on PATH and opt in via env var: `ZG_TEST_E2E=1 npm run test:e2e`. They index `test/fixtures/sample-project/` in a scratch dir and exercise all four query routes.

## Fixture regeneration

`test/fixtures/` holds captured output from real `zg` 0.2.1 runs (help text, status before/after index, a query stanza). They are the compat tripwire for both the arg builder and the parser.

To regenerate one, delete the file and re-run the capture commands in `doc/plans/2026-09-02-pi-zg-extension.md` (Task 3). Alternatively, copy from a fresh `zg` run against `test/fixtures/sample-project/`. Commit the regenerated fixtures in the same PR as any parser or arg-builder change they support.
