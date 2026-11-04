// Lean spawn-backed runner tests. The existing suite mocks the Runner
// contract; this file exercises the real spawn path with a deliberately
// missing binary so the ENOENT wiring (awaitChild rejection + probe's
// isEnoent guard) is pinned against regressions.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

import { awaitChild, makeRunner } from "../src/index.ts";

// PI_ZG_BIN is exclusive (src/zg.ts:110-117): when it is set, the bundled
// platform package and `zg` on PATH must never be tried, even though this
// repo really does ship a working 0.3.0 engine in node_modules. A silent
// fallback would let the user believe their explicit path is in use.
test("PI_ZG_BIN is exclusive: a bundled engine is never used as a fallback", async () => {
  const runner = makeRunner({
    cwd: process.cwd(),
    env: { PI_ZG_BIN: "/nonexistent/zg-binary-xyz" },
  });
  const bin = await runner.probe();
  assert.equal(bin, null);
  assert.match(runner.probeIssue?.() ?? "", /\/nonexistent\/zg-binary-xyz/u);
});

// (b) F7: install with npm missing → bun fallback stays synthetic: proving it
// end-to-end needs either PATH mutation for this process (fragile across
// parallel tests) or monkey-patching spawn (banned here). ensure.test.ts
// ("install lock: parallel resolves install once") pins that shape instead.

// F4: regression test for `awaitChild` lost-race. The function races
// `close` and `error`; whichever resolves first wins. The losing
// promise still has a registered event listener — when its event
// fires later, an uncaught rejection would bubble to
// `unhandledRejection` and kill the host pi process. Promise.race
// attaching handlers to both is what keeps the loser quiet.
//
// We exercise the production `awaitChild` (exported from src/index.ts)
// against a synthetic EventEmitter so we control the timing: emit
// `close` first to win the race, then emit `error` later — without
// the fix, that late error surfaces as unhandledRejection.
test("awaitChild does not emit unhandledRejection on late error", async () => {
  const rejections: unknown[] = [];
  const handler = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", handler);
  try {
    /*
     * awaitChild uses `once()` from node:events, which requires the
     * EventEmitter interface (EventTarget's listener model doesn't
     * compose with `once()` cleanly).
     */
    // oxlint-disable-next-line unicorn/prefer-event-target
    const fakeChild = new EventEmitter() as unknown as Parameters<
      typeof awaitChild
    >[0];
    const codePromise = awaitChild(fakeChild);
    // Win the race with `close`, then emit a late `error` — this is
    // the path that surfaces as unhandledRejection if the loser
    // isn't caught.
    fakeChild.emit("close", 0, null);
    const code = await codePromise;
    assert.equal(code, 0);
    fakeChild.emit("error", new Error("late error after close"));
    // Give any pending microtasks a tick to surface. `await Promise.resolve()`
    // drains the microtask queue which is enough for Node's unhandledRejection
    // detector (it fires on the next microtask after the rejection).
    await Promise.resolve();
    assert.equal(
      rejections.length,
      0,
      `expected no unhandled rejection; got ${rejections.length}: ${String(rejections[0] ?? "")}`
    );
  } finally {
    process.off("unhandledRejection", handler);
  }
});

// F7: probe() captures the version line so createZg's probeAndVersion
// doesn't have to re-spawn `zg --version`. Two paths to pin:
//   (a) successful probe → version() returns the captured first line.
//   (b) failed probe (ENOENT) → version() is undefined (cache miss;
//       createZg must fall back to runner.run(["--version"])).
// The contract uses an optional method on Runner, so existing test
// runners without `version()` keep working.
test("runner.version() returns captured line after successful probe", async () => {
  // PI_ZG_BIN points at a script that reports a supported version: since
  // 0.3.0 every candidate must answer `--version` with >= 0.3.0 (a plain
  // /bin/true no longer qualifies — that binary is exactly the 0.2.x hazard
  // the gate exists for).
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-probe-`);
  const fake = path.join(dir, "zg");
  writeFileSync(
    fake,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.3.0"; fi\nexit 0\n'
  );
  chmodSync(fake, 0o755);
  try {
    const runner = makeRunner({
      cwd: process.cwd(),
      env: { PI_ZG_BIN: fake },
      resolveEngine: () => null,
    });
    const bin = await runner.probe();
    assert.equal(bin, fake);
    assert.equal(runner.version?.(), "0.3.0");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("runner.version() is undefined when probe fails (no cache poisoning)", async () => {
  const runner = makeRunner({
    cwd: process.cwd(),
    env: { PI_ZG_BIN: "/nonexistent/zg-binary-xyz" },
    resolveEngine: () => null,
  });
  const bin = await runner.probe();
  assert.equal(bin, null);
  assert.equal(runner.version?.(), undefined);
});

// probe() caches its winner in probedBin, and the comment on resolveBin
// (src/index.ts:502-505) says every later spawn reuses it — so a second
// probe() must not pay another `--version` spawn. The fake binary appends one
// line to its own `.log` per invocation, so the line count is the spawn count.
// The tool path builds a per-call runner (it owns that call's abort signal) and
// seeds it with the binary the shared chain's probe accepted. A fresh runner
// that fell back to resolveBin() would skip the version gate and hand 0.3.0
// flags to whichever candidate the preference order names first — e.g. a
// packaged engine older than the floor while PATH has a newer one.
test("a seeded runner executes the accepted binary, not resolveBin()", async () => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-seeded-`);
  const fake = path.join(dir, "zg");
  writeFileSync(fake, '#!/bin/sh\necho seeded >> "$0.log"\nexit 0\n');
  chmodSync(fake, 0o755);
  try {
    const runner = makeRunner({
      bin: fake,
      cwd: process.cwd(),
      env: {},
      resolveEngine: () => ({
        cli: path.join(dir, "never-runs"),
        problems: [],
      }),
    });
    assert.equal(runner.binary?.(), fake);
    const res = await runner.run(["--hybrid", "parse stdout"]);
    assert.equal(res.code, 0);
    assert.match(readFileSync(`${fake}.log`, "utf-8"), /seeded/u);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("probe() short-circuits on the cached binary (one --version spawn)", async () => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-probe-cache-`);
  const fake = path.join(dir, "zg");
  writeFileSync(
    fake,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "0.3.0"; echo probe >> "$0.log"; fi\nexit 0\n'
  );
  chmodSync(fake, 0o755);
  try {
    const runner = makeRunner({
      cwd: process.cwd(),
      env: { PI_ZG_BIN: fake },
      resolveEngine: () => null,
    });
    assert.equal(await runner.probe(), fake);
    assert.equal(await runner.probe(), fake);
    assert.equal(
      readFileSync(`${fake}.log`, "utf-8").trim().split("\n").length,
      1,
      "a second probe() must not spawn --version again"
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
