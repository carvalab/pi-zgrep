// Session-start warmup: spawn-backed, hermetic via a fake `zg` shell script.
// Pins the two branches that matter: (1) binary present → probe + status run
// and the footer status clears (no build on a ready index, no error notify),
// (2) binary missing → bail with zero spawns, no background install.

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { sessionWarmup } from "../src/index.ts";

const makeFakeZg = (dir: string, log: string): string => {
  const p = path.join(dir, "zg");
  // Log every argv[0]; --version prints a version so probe caches it, the
  // `status --check-ready` route falls through to exit 0 (index ready).
  writeFileSync(
    p,
    `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\ncase "$1" in\n  --version) echo "0.2.1" ;;\nesac\nexit 0\n`
  );
  chmodSync(p, 0o755);
  return p;
};

const makeUi = (): {
  calls: string[];
  ui: Parameters<typeof sessionWarmup>[0]["ui"];
} => {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      notify: (message: string): void => {
        calls.push(`notify:${message}`);
      },
      setStatus: (_key: string, text: string | undefined): void => {
        calls.push(`status:${text ?? "cleared"}`);
      },
    },
  };
};

const withTempDir = async (
  fn: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-warmup-`);
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

test("warmup with ready index: probes + status-checks, no build, clears status", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const { calls, ui } = makeUi();
    await sessionWarmup({ cwd: dir, ui }, { PI_ZG_BIN: makeFakeZg(dir, log) });
    const argv0 = new Set(
      readFileSync(log, "utf-8").split("\n").filter(Boolean)
    );
    assert.ok(argv0.has("--version"), "probe must run zg --version");
    assert.ok(argv0.has("status"), "ensureIndex must run zg status");
    assert.ok(!argv0.has("index"), "ready index must not trigger a build");
    assert.equal(calls.filter((c) => c.startsWith("notify:")).length, 0);
    assert.equal(calls.at(-1), "status:cleared");
  });
});

test("warmup with missing binary: bails with no spawns and no install", async () => {
  await withTempDir(async (dir) => {
    const { calls, ui } = makeUi();
    await sessionWarmup(
      { cwd: dir, ui },
      { PI_ZG_BIN: "/nonexistent/zg-binary-xyz" }
    );
    assert.deepEqual(calls, ["status:cleared"]);
  });
});
