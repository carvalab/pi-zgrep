import assert from "node:assert/strict";
import { test } from "node:test";

import {
  formatBinaryLine,
  formatDaemonLine,
  guidanceText,
  shouldInjectGuidance,
} from "../src/index.ts";

test("guidance names the four routes and the fallback rule", () => {
  const t = guidanceText();
  assert.match(t, /hybrid/u);
  assert.match(t, /fts/u);
  assert.match(t, /vector/u);
  assert.match(t, /rg/u);
  assert.match(t, /zero results/u);
  assert.match(t, /possibly_stale/u);
  // models must not probe for a CLI
  assert.match(t, /no `zg` binary/u);
});
test("opt-out: any non-empty value disables, unset/empty enables", () => {
  assert.equal(shouldInjectGuidance({}), true);
  assert.equal(shouldInjectGuidance({ PI_ZG_GUIDANCE: "" }), true);
  assert.equal(shouldInjectGuidance({ PI_ZG_GUIDANCE: "1" }), false);
  assert.equal(shouldInjectGuidance({ PI_ZG_GUIDANCE: "0" }), false);
});
test("formatBinaryLine: bin + version renders full line", () => {
  assert.equal(
    formatBinaryLine("/usr/bin/zg", "zg 0.2.1"),
    "binary: /usr/bin/zg (zg 0.2.1)"
  );
});
test("formatBinaryLine: null bin falls back to not-found line", () => {
  assert.equal(
    formatBinaryLine(null, "zg 0.2.1"),
    "binary: not found (install on next zg tool use)"
  );
});
test("formatBinaryLine: empty version falls back to not-found line", () => {
  assert.equal(
    formatBinaryLine("/usr/bin/zg", ""),
    "binary: not found (install on next zg tool use)"
  );
});
test("formatBinaryLine: null version falls back to not-found line", () => {
  assert.equal(
    formatBinaryLine("/usr/bin/zg", null),
    "binary: not found (install on next zg tool use)"
  );
});
test("formatDaemonLine: ready probe renders state and pid", () => {
  assert.equal(
    formatDaemonLine({
      code: 0,
      stdout: "Server: ready\nPID: 4012956\nURL: http://127.0.0.1:7999/mcp",
    }),
    "daemon: ready (pid 4012956) — manage with 'zg server on' / 'zg server off'"
  );
});
test("formatDaemonLine: missing or failed probe degrades to not-ready hint", () => {
  assert.match(formatDaemonLine(null), /not ready/u);
  assert.match(formatDaemonLine({ code: 1, stdout: "boom" }), /not ready/u);
});
