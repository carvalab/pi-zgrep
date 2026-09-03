// Lean spawn-backed runner tests. The existing suite mocks the Runner
// contract; this file exercises the real spawn path with a deliberately
// missing binary so the ENOENT wiring (awaitChild rejection + probe's
// isEnoent guard) is pinned against regressions.

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeRunner } from "../src/index.ts";

// (a) F7: probe() on a runner built with PI_ZG_BIN pointing at a missing
// file. spawn emits 'error' async → awaitChild rejects → probe's
// isEnoent branch returns null. This is the exact path the bun fallback
// relies on for the install case.
test("probe resolves null via real spawn when PI_ZG_BIN points to nothing", async () => {
  const runner = makeRunner({
    cwd: process.cwd(),
    env: { PI_ZG_BIN: "/nonexistent/zg-binary-xyz" },
  });
  const bin = await runner.probe();
  assert.equal(bin, null);
});

// (b) F7: install with npm missing → bun fallback. Skipped: proving this
// end-to-end requires either (i) deleting npm from PATH for this
// process (env mutation across parallel tests is fragile and may leak
// into the rest of the suite) or (ii) monkey-patching spawn, which the
// ultracite rule against promise chaining / heavy mocking makes
// undesirable here. The synthetic fakeRunner coverage in
// ensure.test.ts ("install lock: parallel resolves install once") pins
// the install fallback shape on the contract side.
test("install routes from missing npm to bun fallback", { skip: true }, () => {
  assert.fail(
    "covered synthetically in ensure.test.ts; real spawn test skipped"
  );
});

// F4: regression test for `awaitChild` lost-race. The function races
// `close` and `error`; whichever resolves first wins. The losing
// promise still has a registered event listener — when its event
// fires later, the rejection has no .catch attached and bubbles to
// `unhandledRejection`, killing the host pi process. The fix is to
// .catch the loser after the race settles.
//
// We exercise the production `awaitChild` (exported from src/index.ts)
// against a synthetic EventEmitter so we control the timing: emit
// `close` first to win the race, then emit `error` later — without
// the fix, that late error surfaces as unhandledRejection.
test("awaitChild does not emit unhandledRejection on late error", async () => {
  const { EventEmitter } = await import("node:events");
  const { awaitChild } = await import("../src/index.ts");
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
  // PI_ZG_BIN points to /bin/true so probe's spawn exits 0; we don't
  // get a real zg version string back, but we get the cache-write
  // path exercised (any stdout triggers the version cache).
  const runner = makeRunner({
    cwd: process.cwd(),
    env: { PI_ZG_BIN: "/bin/true" },
  });
  const bin = await runner.probe();
  assert.equal(bin, "/bin/true");
  // /bin/true prints nothing; cache captures an empty string. The
  // contract is "captured line is returned verbatim", not "non-empty".
  assert.equal(typeof runner.version?.(), "string");
});

test("runner.version() is undefined when probe fails (no cache poisoning)", async () => {
  const runner = makeRunner({
    cwd: process.cwd(),
    env: { PI_ZG_BIN: "/nonexistent/zg-binary-xyz" },
  });
  const bin = await runner.probe();
  assert.equal(bin, null);
  assert.equal(runner.version?.(), undefined);
});
