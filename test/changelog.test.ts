// The package must ship a changelog pi can read after an update. pi 1.5 shows
// entries newer than the last seen version under "Extension Updates", reading
// `pi.changelogPath` (or CHANGELOG.md in the package root) from the installed
// tarball, and only versions whose heading matches
// /##\s+\[?(\d+)\.(\d+)\.(\d+)\]?/ (pi-coding-agent dist/utils/changelog.js,
// parseChangelog). CHANGELOG.md cannot be that file: its headings carry the
// tag's `v` prefix, which the release job greps for, and pi's parser stops at
// the `v` and finds no entries at all.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));

// pi's own heading parser, copied from its changelog util.
const PI_HEADING = /##\s+\[?(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)\]?/u;

const versionOf = (line: string): string | undefined => {
  const { major, minor, patch } = PI_HEADING.exec(line)?.groups ?? {};
  return major === undefined || minor === undefined || patch === undefined
    ? undefined
    : [major, minor, patch].join(".");
};

const headings = (file: string): string[] =>
  readFileSync(file, "utf-8")
    .split("\n")
    .filter((line) => line.startsWith("## "));

test("the pi changelog is declared, shipped and parseable by pi", () => {
  const declared = pkg.pi?.changelogPath;
  assert.equal(
    typeof declared,
    "string",
    "package.json pi.changelogPath is not set, so pi falls back to CHANGELOG.md"
  );
  assert.ok(
    !path.isAbsolute(declared),
    "changelogPath must be package-relative"
  );
  const file = path.join(root, declared);
  assert.ok(existsSync(file), `pi.changelogPath ${declared} does not exist`);

  // `files` decides the tarball; a changelog left out of it is never installed.
  const shipped = pkg.files ?? [];
  assert.ok(
    shipped.includes(declared.replace(/^\.\//u, "")),
    `${declared} is not in package.json "files", so npm pack leaves it out`
  );

  const found = headings(file);
  assert.ok(found.length > 0, `${declared} has no "## <version>" headings`);
  for (const line of found) {
    assert.match(
      line,
      PI_HEADING,
      `pi's changelog parser skips "${line}"; use "## 0.7.0 - <date>", not "## [v0.7.0]"`
    );
  }
});

test("every shipped changelog version is a real release", () => {
  const releases = new Set(
    headings(path.join(root, "CHANGELOG.md")).map(
      (line) =>
        /##\s+\[?v?(?<version>\d+\.\d+\.\d+)/u.exec(line)?.groups?.version
    )
  );
  for (const line of headings(path.join(root, pkg.pi.changelogPath))) {
    const version = versionOf(line);
    assert.ok(
      version !== undefined && releases.has(version),
      `${version ?? line} is not a release in CHANGELOG.md`
    );
  }
});

test("the release job can still find CHANGELOG.md sections by tag", () => {
  // .github/workflows/release.yml greps `## [$GITHUB_REF_NAME]`, and the tag is
  // v-prefixed, so the canonical changelog keeps its `v` headings.
  const first = headings(path.join(root, "CHANGELOG.md"))[0] ?? "";
  assert.match(first, /^## \[v\d+\.\d+\.\d+\]/u);
});

test("package.json pi manifest keeps resource fields explicit", () => {
  // Changing devDependencies must not silently drop the extension or skill
  // entry points pi discovers from `pi`.
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.deepEqual(pkg.pi.skills, ["./skills"]);
});
