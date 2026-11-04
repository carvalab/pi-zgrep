# Changelog (pi)

The changelog pi shows under "Extension Updates" on the first launch after an
update, read from `pi.changelogPath` in `package.json`. Heading format matters:
pi's parser matches `## <major>.<minor>.<patch>` (`## [0.7.0]` or
`## 0.7.0 - 2026-11-03`, no `v` prefix), so `CHANGELOG.md` — whose `## [v0.7.0]`
headings the release job matches against the `v0.7.0` tag — cannot serve as this
file. `test/changelog.test.ts` enforces both halves.

## 0.7.0 - 2026-11-03

- Needs zg 0.3.0, the native Rust engine. An older binary is refused by name,
  with its path and version, instead of being handed flags it would read as
  search text.
- Installs that block lifecycle scripts keep working: the per-platform package
  carries the verified binary, and `PI_ZG_BIN` is now exclusive and
  self-diagnosing.
- Hits the engine marks `possibly_stale` are flagged to the model, and the
  first index of a workspace names its embedding model, so a cold start no
  longer fails with `ZG.ENGINE.NOT_FOUND`.

## 0.6.0 - 2026-10-16

- Each repository searches its own index; an index in a parent folder no longer
  answers for every repo below it.
- Session start never indexes your home directory or the filesystem root.
- Results render in the TUI, large output follows pi's truncation convention,
  and the tool is marked read-only.
