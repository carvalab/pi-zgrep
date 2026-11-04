import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  parseQueryOutput,
  parseStatusOutput,
  renderResults,
} from "../src/parse.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

// Every fixture here was captured from the real `zg` 0.3.0 binary against
// test/fixtures/sample-project; see fixtures/NOTES.md for the exact argv.

test("parses captured hybrid output (--preview short) into results", () => {
  const r = parseQueryOutput(fixture("query-output.txt"));
  assert.equal(
    "results" in r,
    true,
    `parse missed; got ${JSON.stringify(r).slice(0, 200)}`
  );
  if ("results" in r) {
    assert.equal(r.results.length, 1);
    assert.deepEqual(r.results[0], {
      file: "hello.ts",
      lineEnd: 4,
      lineStart: 2,
      snippet: 'function loadTheme(): string {\n  return "dark";\n}',
    });
  }
});

test("parses captured multi-query output (`-- query i/n:` dividers)", () => {
  const r = parseQueryOutput(fixture("query-output-multi.txt"));
  assert.equal("results" in r, true);
  if ("results" in r) {
    // One hit per query group, both pointing at the same function.
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].file, "hello.ts");
    assert.equal(r.results[1].lineStart, 2);
  }
});

test("parses captured --preview none output (tab-prefixed source)", () => {
  const r = parseQueryOutput(fixture("query-output-none.txt"));
  assert.equal("results" in r, true);
  if ("results" in r) {
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].snippet, "function loadTheme(): string {");
  }
});

test("`No matches.` parses to an empty result list", () => {
  assert.deepEqual(parseQueryOutput(fixture("query-no-matches.txt")), {
    results: [],
  });
});

test("parse miss returns raw, never fabricates", () => {
  const r = parseQueryOutput("total garbage\nnot a zg listing\n");
  assert.deepEqual(r, { raw: "total garbage\nnot a zg listing\n" });
});

test("parses captured --rg output into results (ripgrep-shaped)", () => {
  // --rg prints a bare path line, a blank line between path groups, then
  // two-space indented `<line>: <text>` matches — a different shape from the
  // indexed `#<rank> <path>:<range>` blocks. The parser must detect it and
  // return structured results with line numbers.
  const r = parseQueryOutput(fixture("query-output-rg.txt"));
  assert.equal(
    "results" in r,
    true,
    `rg parse missed; got ${JSON.stringify(r).slice(0, 200)}`
  );
  if ("results" in r) {
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].file, "hello.ts");
    assert.equal(r.results[0].lineStart, 1);
    assert.match(String(r.results[0].snippet ?? ""), /loadTheme/u);
    assert.equal(r.results[1].lineStart, 2);
  }
});

test("garbage rg-shaped input still returns {raw}", () => {
  // Looks superficially like rg output (path-ish line, then a line that is
  // neither a path nor a match) → bail to raw, do not fabricate.
  const r = parseQueryOutput("notreallyapath\nfoo bar baz\n");
  assert.deepEqual(r, { raw: "notreallyapath\nfoo bar baz\n" });
});

test("indexed header without a line range returns {raw}", () => {
  // 0.3.0 prints `#1 <path>` (no `:<line>`) for path-lookup results; the
  // extension forces an explicit route flag so it never sees those, and the
  // parser refuses to invent a line number.
  assert.deepEqual(parseQueryOutput("#1 auth.ts\n"), {
    raw: "#1 auth.ts\n",
  });
});

test("status parser: ready fixture → ready/fresh", () => {
  const ready = parseStatusOutput(fixture("status-ready.txt"));
  assert.equal("raw" in ready, false);
  if ("raw" in ready) {
    throw new Error("expected parsed");
  }
  assert.equal(ready.ready, true);
  assert.equal(ready.freshness, "fresh");
});

test("status parser: not-ready fixture forwards the upstream readiness note", () => {
  const r = parseStatusOutput(fixture("status-notready.txt"));
  assert.equal("raw" in r, false);
  if ("raw" in r) {
    throw new Error("expected parsed");
  }
  assert.equal(r.ready, false);
  assert.equal(r.freshness, "rebuild required");
});

test("status parser returns raw for input it cannot recognize", () => {
  const miss = parseStatusOutput("??");
  assert.equal("raw" in miss, true);
  if ("raw" in miss) {
    assert.equal(miss.raw, "??");
  }
});

// 0.3.0 appends a stale-index trailer when the index is behind the worktree:
// `status: possibly_stale` on each hit, then a run-level block
// (`results: served_from_current_index`, `background_refresh: idle (n/m)`).
// Those keys are trailer metadata, not hits, so the parser must consume them
// instead of bailing the whole listing to {raw}.
test("stale-index trailer lines parse instead of falling back to raw", () => {
  const parsed = parseQueryOutput(fixture("query-output-stale.txt"));
  assert.equal(
    "results" in parsed,
    true,
    `parse fell back to raw: ${JSON.stringify(parsed).slice(0, 200)}`
  );
  if ("results" in parsed) {
    assert.equal(parsed.results.length, 1);
    assert.deepEqual(parsed.results[0], {
      file: "hello.ts",
      lineEnd: 4,
      lineStart: 2,
      snippet: 'function loadTheme(): string {\n  return "dark";\n}',
    });
  }
});

test("rendering is one ripgrep-style line per result", () => {
  const out = renderResults({
    results: [
      {
        file: "src/a.ts",
        lineEnd: 7,
        lineStart: 3,
        snippet: "export function loadTheme",
      },
    ],
  });
  // The score column is empty for a 0.3.0 short preview (no score is printed),
  // exactly as the renderer in src/parse.ts lays it out.
  assert.equal(out, "src/a.ts:3-7    export function loadTheme");
});

// zg 0.3.0 function/symbol hits: the header is `#<rank> <path>:<range>`, then a
// `symbol:` / `scope:` metadata line, then the numbered source lines. There is no
// `outline:`/`calls:`/`matched:` block any more (0.2.2 printed one; 0.3.0 only
// does inside `--preview detail`, which the extension never requests). Captured
// from `zg --hybrid "where is the theme returned" --color never --limit 3`.
test("symbol hits with metadata lines parse instead of falling to raw", () => {
  const parsed = parseQueryOutput(fixture("query-output-outline.txt"));
  assert.ok("results" in parsed, "must not fall back to raw");
  assert.deepEqual(
    parsed.results.map((r) => `${r.file}:${r.lineStart}-${r.lineEnd}`),
    ["src/theme.ts:1-3", "src/theme.ts:5-9", "src/theme.ts:6-8"]
  );
  const [first, second, third] = parsed.results;
  assert.equal(
    first?.snippet?.split("\n")[0],
    "function loadTheme(): string {"
  );
  assert.equal(second?.snippet?.split("\n")[0], "class AuthService {");
  assert.equal(
    third?.snippet?.split("\n")[0],
    "validate(token: string): boolean {"
  );
  // `symbol:`/`scope:` frame the hit; they are not source text.
  assert.doesNotMatch(first?.snippet ?? "", /^symbol:/mu);
  assert.doesNotMatch(third?.snippet ?? "", /^symbol:|scope:/mu);
});
