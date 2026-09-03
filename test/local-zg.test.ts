// Local engine resolution + .js-bin spawning. Pins the npm-12-safe install
// story: the engine is a declared dependency found through node_modules (no
// lifecycle scripts involved), and packaged JS entries are spawned with the
// current node rather than relying on exec bits.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeRunner, resolveLocalZgCli } from "../src/index.ts";

const withTempDir = async (
  fn: (dir: string) => Promise<void> | void
): Promise<void> => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-local-`);
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

const installFakeEngine = (dir: string, version: string): string => {
  const pkgDir = path.join(dir, "node_modules", "@zvec", "zvec-grep");
  mkdirSync(path.join(pkgDir, "dist", "cli"), { recursive: true });
  writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      bin: { zg: "dist/cli/index.js" },
      main: "dist/index.js",
      name: "@zvec/zvec-grep",
    })
  );
  // Main entry, like the real package (resolved via `main` since we don't
  // declare `exports` in the fixture).
  writeFileSync(path.join(pkgDir, "dist", "index.js"), "export {};\n");
  // Mimics the real CLI: prints the version for --version, exits 0 otherwise.
  writeFileSync(
    path.join(pkgDir, "dist", "cli", "index.js"),
    `if (process.argv[2] === "--version") console.log(${JSON.stringify(version)});\nprocess.exit(0);\n`
  );
  return path.join(pkgDir, "dist", "cli", "index.js");
};

test("resolveLocalZgCli finds the engine CLI through node_modules", () => {
  withTempDir((dir) => {
    const cli = installFakeEngine(dir, "0.2.1");
    assert.equal(resolveLocalZgCli(dir), cli);
  });
});

test("resolveLocalZgCli returns null when the dependency is absent", () => {
  withTempDir((dir) => {
    assert.equal(resolveLocalZgCli(dir), null);
  });
});

// The .js branch of startProcess runs through the public probe() with a real
// spawn: PI_ZG_BIN pointing at a JS entry must be executed via `node` and
// still feed the version cache (F7).
test("runner spawns .js bins with node and caches the version", async () => {
  await withTempDir(async (dir) => {
    const cli = installFakeEngine(dir, "0.2.1-local");
    const runner = makeRunner({ cwd: dir, env: { PI_ZG_BIN: cli } });
    assert.equal(await runner.probe(), cli);
    assert.equal(runner.version?.(), "0.2.1-local");
  });
});
