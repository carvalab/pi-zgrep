import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildQueryArgs,
  buildIndexArgs,
  buildStatusArgs,
} from "../src/args.ts";

const help = readFileSync(
  new URL("fixtures/help-query.txt", import.meta.url),
  "utf-8"
);

test("hybrid route uses positional query", () => {
  assert.deepEqual(
    buildQueryArgs({
      limit: 10,
      mode: "hybrid",
      preview: "short",
      query: "where is the theme restored",
    }),
    [
      "query",
      "where is the theme restored",
      "--limit",
      "10",
      "--preview",
      "short",
      "--mode",
      "auto",
    ]
  );
});
test("fts/vector/rg routes use their flags", () => {
  assert.deepEqual(
    buildQueryArgs({
      limit: 5,
      mode: "fts",
      preview: "none",
      query: "loadTheme",
    }),
    [
      "query",
      "--fts",
      "loadTheme",
      "--limit",
      "5",
      "--preview",
      "none",
      "--mode",
      "auto",
    ]
  );
  assert.ok(
    buildQueryArgs({
      limit: 1,
      mode: "vector",
      preview: "short",
      query: "q",
    }).includes("--vector")
  );
  // rg route must not emit --preview/--mode/--refresh: real `zg` v0.2.1
  // rejects them ("--preview is not supported with --rg; use -A/-B/-C
  // for rg context"; same upstream error shape for --mode/--refresh).
  // See the e2e test's captured-behavior comment.
  assert.deepEqual(
    buildQueryArgs({
      limit: 1,
      mode: "rg",
      preview: "none",
      query: "q",
      refresh: "wait",
    }),
    ["query", "--rg", "q", "--limit", "1"]
  );
});
test("refresh wait and filters append", () => {
  const args = buildQueryArgs({
    glob: "*.ts",
    limit: 5,
    mode: "hybrid",
    preview: "short",
    query: "q",
    refresh: "wait",
    type: "ts",
  });
  assert.ok(args.includes("--refresh") && args.includes("wait"));
  assert.deepEqual(args.slice(args.indexOf("-g"), args.indexOf("-g") + 2), [
    "-g",
    "*.ts",
  ]);
  assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), [
    "-t",
    "ts",
  ]);
});
test("every emitted flag exists in the captured zg query help (input tripwire)", () => {
  const known = new Set([
    "query",
    "--fts",
    "--vector",
    "--rg",
    "--hybrid",
    "--limit",
    "--preview",
    "--mode",
    "--refresh",
    "-g",
    "--iglob",
    "-t",
    "-T",
    "--fuse",
  ]);
  // Loop the maximal QueryInput shape across all four modes. Emitted
  // flag tokens (anything starting with "-") must be in the known set
  // AND in the captured help fixture. Non-flag tokens (the query
  // string, --limit's number, --refresh's value) are not flags.
  for (const mode of ["hybrid", "fts", "vector", "rg"] as const) {
    for (const a of buildQueryArgs({
      glob: "*.ts",
      limit: 3,
      mode,
      preview: "short",
      query: "q",
      refresh: "wait",
      type: "ts",
    })) {
      if (a.startsWith("-")) {
        assert.ok(
          known.has(a) && help.includes(a),
          `flag ${a} not in captured help (mode ${mode})`
        );
      }
    }
  }
});
test("index/status builders", () => {
  assert.deepEqual(buildIndexArgs(["--rebuild"]), ["index", "--rebuild"]);
  assert.deepEqual(buildStatusArgs(), ["status", "--check-ready"]);
});
