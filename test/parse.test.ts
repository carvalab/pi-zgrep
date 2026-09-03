import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parseQueryOutput,
  parseStatusOutput,
  renderResults,
} from "../src/parse.ts";

const q = () =>
  readFileSync(new URL("fixtures/query-output.txt", import.meta.url), "utf-8");
const sReady = () =>
  readFileSync(new URL("fixtures/status-ready.txt", import.meta.url), "utf-8");
const sNotReady = () =>
  readFileSync(
    new URL("fixtures/status-notready.txt", import.meta.url),
    "utf-8"
  );

test("parses captured hybrid output into results", () => {
  const r = parseQueryOutput(q());
  assert.equal(
    "results" in r,
    true,
    `parse missed; got ${JSON.stringify(r).slice(0, 200)}`
  );
  if ("results" in r) {
    assert.ok(r.results.length > 0);
    assert.ok(
      r.results[0].file.includes("hello.ts"),
      `first hit should be the sample file: ${JSON.stringify(r.results[0])}`
    );
    assert.ok(typeof r.results[0].lineStart === "number");
  }
});

test("parse miss returns raw, never fabricates", () => {
  const r = parseQueryOutput("total garbage\nnot a zg listing\n");
  assert.deepEqual(r, { raw: "total garbage\nnot a zg listing\n" });
});

test("status parser extracts ready/freshness, miss returns raw", () => {
  // input shape comes from the captured `zg status` fixture
  const ready = parseStatusOutput(sReady());
  assert.equal("raw" in ready, false);
  if ("raw" in ready) {
    throw new Error("expected parsed");
  }
  assert.equal(ready.ready, true);
  assert.equal(ready.freshness, "fresh");
  const miss = parseStatusOutput("??");
  assert.equal("raw" in miss, true);
  if ("raw" in miss) {
    assert.equal(miss.raw, "??");
  }
});

test("status parser on not-ready fixture returns ready=false, possibly_stale", () => {
  const r = parseStatusOutput(sNotReady());
  assert.equal("raw" in r, false);
  if ("raw" in r) {
    throw new Error("expected parsed");
  }
  assert.equal(r.ready, false);
  assert.equal(r.freshness, "possibly_stale");
});

test("rendering is ripgrep-style lines per result", () => {
  const out = renderResults({
    results: [
      {
        file: "src/a.ts",
        lineEnd: 7,
        lineStart: 3,
        score: 0.9,
        snippet: "export function loadTheme",
      },
    ],
  });
  assert.match(out, /src\/a\.ts:3-7\s+0\.9\s+export function loadTheme/u);
});
