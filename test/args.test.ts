import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildQueryArgs,
  buildIndexArgs,
  buildStatusArgs,
  validateQueryInput,
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

// F3 (b/d): hybrid positional route has no flag separator; a query
// beginning with "-" would be parsed as a flag and zg would reject it
// with "missing: <whatever>". Reject up-front so the agent gets a
// clear message instead of an upstream parse error. glob/type go
// through `-g`/`-t` (separate flag pair) but upstream treats
// `-g -x` as a glob of "-x" with no error — the agent almost
// certainly meant an exclusion (e.g. `!node_modules`) instead, so
// reject to force them to be explicit.
test("validateQueryInput: empty query rejected", () => {
  assert.throws(
    () =>
      validateQueryInput({
        limit: 10,
        mode: "hybrid",
        preview: "none",
        query: "",
      }),
    /query must not be empty/u
  );
});

test("validateQueryInput: hybrid query starting with - rejected", () => {
  assert.throws(
    () =>
      validateQueryInput({
        limit: 10,
        mode: "hybrid",
        preview: "none",
        query: "-x",
      }),
    /leading "-" queries must use mode=rg/u
  );
});

test("validateQueryInput: glob starting with - rejected", () => {
  assert.throws(
    () =>
      validateQueryInput({
        glob: "-x",
        limit: 10,
        mode: "hybrid",
        preview: "none",
        query: "q",
      }),
    /glob must not start with "-"/u
  );
});

test("validateQueryInput: type starting with - rejected", () => {
  assert.throws(
    () =>
      validateQueryInput({
        limit: 10,
        mode: "hybrid",
        preview: "none",
        query: "q",
        type: "-x",
      }),
    /type must not start with "-"/u
  );
});

test("validateQueryInput: rg mode accepts leading-dash query (uses -e)", () => {
  // rg route handles leading-dash queries via the -e flag pair in
  // buildQueryArgs, so validateQueryInput must NOT reject them.
  assert.doesNotThrow(() =>
    validateQueryInput({
      limit: 10,
      mode: "rg",
      preview: "none",
      query: "-x",
    })
  );
});

test("validateQueryInput: hybrid happy path", () => {
  assert.doesNotThrow(() =>
    validateQueryInput({
      limit: 10,
      mode: "hybrid",
      preview: "none",
      query: "where is theme restored",
    })
  );
});

// F3 (a): query starting with "-" on the rg route is appended as
// `-e <query>` so upstream treats it as a pattern, not a flag. Verified
// against real `zg` v0.2.1: `zg query --rg -e "-x" --limit 1` works;
// the bare `zg query --rg "-x" --limit 1` form fails ("missing:
// --limit, 1"). help-query.txt explicitly recommends `-e` for leading-
// dash patterns.
test("rg route emits -e flag pair when query starts with -", () => {
  assert.deepEqual(
    buildQueryArgs({
      limit: 1,
      mode: "rg",
      preview: "none",
      query: "-x",
    }),
    ["query", "--rg", "-e", "-x", "--limit", "1"]
  );
});

test("rg route emits bare query when query does not start with -", () => {
  // Sanity guard: the -e branch must not be taken for ordinary
  // queries, so the help tripwire stays clean.
  assert.deepEqual(
    buildQueryArgs({
      limit: 1,
      mode: "rg",
      preview: "none",
      query: "loadTheme",
    }),
    ["query", "--rg", "loadTheme", "--limit", "1"]
  );
});
