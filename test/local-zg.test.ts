// Local engine resolution for zg 0.3.0. The 0.3.0 package is a shell around a
// native executable that lives in a per-platform optional dependency: no
// `main`, no `exports`, no JS entry, and nothing may run it through `node`. So
// resolution walks node_modules for @zvec/zvec-grep, reads platforms.json, and
// verifies the platform payload against checksums.json; the runner then spawns
// that executable directly. Each candidate is gated on `--version` >= 0.3.0,
// because 0.2.x had subcommands and would misread the new flag shape.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { makeRunner, resolveLocalEngine } from "../src/index.ts";

const PLATFORM_PACKAGE = `@zvec/zvec-grep-${process.platform}-${process.arch}`;

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

// A platform package shaped like the published one: an executable payload plus
// the checksums.json the resolver verifies. The payload is a shell script
// (an ELF header cannot be executed in a test), but it is native-style: exec
// bit set, spawned directly through its shebang — never `node <file>.js`.
const installFakeEngine = (dir: string, version: string): string => {
  const scopeDir = path.join(dir, "node_modules", "@zvec");
  const metaDir = path.join(scopeDir, "zvec-grep");
  const platformDir = path.join(
    scopeDir,
    `zvec-grep-${process.platform}-${process.arch}`
  );
  mkdirSync(metaDir, { recursive: true });
  mkdirSync(path.join(platformDir, "bin"), { recursive: true });
  // findPackageDir only accepts a directory that carries a package.json.
  writeFileSync(
    path.join(platformDir, "package.json"),
    JSON.stringify({ name: PLATFORM_PACKAGE, version: "0.3.0" })
  );
  writeFileSync(
    path.join(metaDir, "package.json"),
    JSON.stringify({ name: "@zvec/zvec-grep", version: "0.3.0" })
  );
  // No libc tag: matches both glibc and musl hosts.
  writeFileSync(
    path.join(metaDir, "platforms.json"),
    JSON.stringify([
      {
        binary: "zg",
        cpu: process.arch,
        os: process.platform,
        package: PLATFORM_PACKAGE,
        target: `${process.platform}-${process.arch}`,
      },
    ])
  );
  // What npm 12 leaves behind when the postinstall is blocked (RFC 0054):
  // bin/zg.exe is this stub, not a binary, so it must never be chosen.
  mkdirSync(path.join(metaDir, "bin"), { recursive: true });
  writeFileSync(
    path.join(metaDir, "bin", "zg.exe"),
    '#!/bin/sh\necho "zvec-grep native binary was not materialized during npm install." >&2\nexit 1\n'
  );
  const cli = path.join(platformDir, "bin", "zg");
  writeFileSync(
    cli,
    `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\nesac\nexit 0\n`
  );
  chmodSync(cli, 0o755);
  const payload = readFileSync(cli);
  writeFileSync(
    path.join(platformDir, "checksums.json"),
    JSON.stringify({
      files: {
        "bin/zg": {
          bytes: statSync(cli).size,
          sha256: createHash("sha256").update(payload).digest("hex"),
        },
      },
    })
  );
  return cli;
};

test("resolveLocalEngine verifies and returns the platform payload", async () => {
  await withTempDir((dir) => {
    const cli = installFakeEngine(dir, "0.3.0");
    assert.deepEqual(resolveLocalEngine(dir), { cli, problems: [] });
  });
});

test("resolveLocalEngine reports the stub and returns null without a platform package", async () => {
  await withTempDir((dir) => {
    const metaDir = path.join(dir, "node_modules", "@zvec", "zvec-grep");
    mkdirSync(path.join(metaDir, "bin"), { recursive: true });
    writeFileSync(
      path.join(metaDir, "package.json"),
      JSON.stringify({ name: "@zvec/zvec-grep", version: "0.3.0" })
    );
    writeFileSync(
      path.join(metaDir, "bin", "zg.exe"),
      '#!/bin/sh\necho "zvec-grep native binary was not materialized during npm install." >&2\nexit 1\n'
    );
    const engine = resolveLocalEngine(dir);
    assert.equal(engine.cli, null);
    assert.ok(
      engine.problems.some((p) => p.includes("placeholder")),
      `expected a placeholder problem; got ${JSON.stringify(engine.problems)}`
    );
  });
});

test("resolveLocalEngine returns null when the dependency is absent", async () => {
  await withTempDir((dir) => {
    assert.deepEqual(resolveLocalEngine(dir), { cli: null, problems: [] });
  });
});

// A runner env with a PATH that resolves nothing. "zg" is always probe()'s
// last candidate, so an empty/absent PATH lets the spawn fall back to this
// host's real zg (a globally installed 0.3.x would be accepted) and the test
// would silently stop pinning the bundled path. Every probe test that means
// "no zg on PATH" must say so explicitly.
const NO_PATH = { PATH: "/nonexistent" };

// The runner's bundled candidate comes from the injected resolver, so this
// pins the whole 0.3.0 path: resolve → verify checksums → spawn the executable
// directly → gate on `--version` → cache the version line.
test("probe runs the bundled 0.3.0 engine and caches its version", async () => {
  await withTempDir(async (dir) => {
    const cli = installFakeEngine(dir, "0.3.0");
    const runner = makeRunner({
      cwd: dir,
      env: { ...NO_PATH },
      resolveEngine: () => resolveLocalEngine(dir),
    });
    assert.equal(await runner.probe(), cli);
    assert.equal(runner.version?.(), "0.3.0");
  });
});

// A packaged 0.2.x engine is not usable (0.2.x had subcommands): probe refuses
// it and the diagnosis names the binary, its version, and the floor. PATH is
// sealed so the rejection is terminal: otherwise probe would fall through to a
// real zg on this host's PATH and the 0.2.1 candidate would stop being named.
test("a bundled 0.2.1 engine is rejected with a clear message", async () => {
  await withTempDir(async (dir) => {
    const cli = installFakeEngine(dir, "0.2.1");
    const runner = makeRunner({
      cwd: dir,
      env: { ...NO_PATH },
      resolveEngine: () => resolveLocalEngine(dir),
    });
    assert.equal(await runner.probe(), null);
    const issue = runner.probeIssue?.() ?? "";
    assert.ok(issue.includes(cli), `issue must name the binary: ${issue}`);
    assert.match(issue, /0\.2\.1/u);
    assert.match(issue, /0\.3\.0 or newer is required/u);
  });
});
