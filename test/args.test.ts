import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  buildQueryArgs,
  buildIndexArgs,
  buildStatusArgs,
  DEFAULT_NEW_INDEX_EMBEDDING,
  isNewIndexState,
  parseIndexCommandArgs,
  resolveNewIndexEmbedding,
  validateQueryInput,
} from "../src/args.ts";

// Captured from `zg --help search` on 0.3.0 (test/fixtures/help-query.txt).
const help = readFileSync(
  new URL("fixtures/help-query.txt", import.meta.url),
  "utf-8"
);

test("hybrid route is an explicit --hybrid query group", () => {
  assert.deepEqual(
    buildQueryArgs({
      limit: 10,
      mode: "hybrid",
      preview: "short",
      query: "where is the theme restored",
    }),
    [
      "--hybrid",
      "where is the theme restored",
      "--limit",
      "10",
      "--preview",
      "short",
      "--color",
      "never",
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
      "--fts",
      "loadTheme",
      "--limit",
      "5",
      "--preview",
      "none",
      "--color",
      "never",
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
  // rg route must not emit --preview/--refresh: real `zg` 0.3.0 rejects them
  // ("--rg cannot be combined with indexed preview, trace, refresh, or symbol
  // options"), so the rg argv is pattern + --limit + filters only.
  assert.deepEqual(
    buildQueryArgs({
      limit: 1,
      mode: "rg",
      preview: "none",
      query: "q",
      refresh: "wait",
    }),
    ["--rg", "q", "--color", "never", "--limit", "1"]
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
test("every emitted flag exists in the captured 0.3.0 search help (input tripwire)", () => {
  const known = new Set([
    "-e",
    "-g",
    "-t",
    "--color",
    "--fts",
    "--hybrid",
    "--limit",
    "--mode",
    "--preview",
    "--refresh",
    "--rg",
    "--vector",
  ]);
  // Loop the maximal QueryInput shape across all four modes. Emitted flag
  // tokens (anything starting with "-") must be in the known set AND in the
  // captured help fixture. Non-flag tokens (the query string, --limit's
  // number, --refresh's value) are not flags.
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
test("index/status builders use the 0.3.0 management flags", () => {
  assert.deepEqual(buildIndexArgs(["--rebuild"]), ["--index", "--rebuild"]);
  assert.deepEqual(buildIndexArgs(), ["--index"]);
  assert.deepEqual(buildStatusArgs(), ["--status", "--check-ready"]);
});

// A workspace's first index has to name its embedding model: upstream's
// precedence is --embedding > ZVEC_GREP_EMBEDDING > global config >
// local/potion-code-16m-v2 (zsrc crates/zg-cli/src/render.rs:566-567). The
// extension never relies on that last resort, because on a bare repo the build
// used to fail instead of indexing.
test("first index names a model; env wins over the built-in default", () => {
  assert.equal(DEFAULT_NEW_INDEX_EMBEDDING, "local/potion-code-16m-v2");
  assert.deepEqual(buildIndexArgs([], { env: {}, newIndex: true }), [
    "--index",
    "--embedding",
    "local/potion-code-16m-v2",
  ]);
  // ZVEC_GREP_EMBEDDING is the variable upstream itself reads, so it outranks
  // the extension-level PI_ZG_EMBEDDING.
  assert.deepEqual(
    buildIndexArgs([], {
      env: {
        PI_ZG_EMBEDDING: "local/pi-choice",
        ZVEC_GREP_EMBEDDING: "local/zvec-choice",
      },
      newIndex: true,
    }),
    ["--index", "--embedding", "local/zvec-choice"]
  );
  assert.deepEqual(
    buildIndexArgs([], {
      env: { PI_ZG_EMBEDDING: "  local/pi  " },
      newIndex: true,
    }),
    ["--index", "--embedding", "local/pi"]
  );
  // Blank counts as unset, both variables.
  assert.equal(
    resolveNewIndexEmbedding({
      PI_ZG_EMBEDDING: "   ",
      ZVEC_GREP_EMBEDDING: "",
    }),
    DEFAULT_NEW_INDEX_EMBEDDING
  );
  assert.equal(resolveNewIndexEmbedding({}), DEFAULT_NEW_INDEX_EMBEDDING);
});

test("user-supplied --embedding is never duplicated", () => {
  for (const extra of [
    ["--embedding", "local/mine"],
    ["--embedding=local/mine"],
    ["--debug", "--embedding", "local/mine"],
  ]) {
    const args = buildIndexArgs(extra, { env: {}, newIndex: true });
    assert.deepEqual(args, ["--index", ...extra]);
    assert.equal(
      args.filter((a) => a === "--embedding" || a.startsWith("--embedding="))
        .length,
      1,
      `exactly one --embedding in ${JSON.stringify(args)}`
    );
  }
});

// Refresh and --rebuild keep the model the index already stores: naming a
// different one makes an existing compatible index fail with "Rebuild the index
// with `zg --index --rebuild`" (zsrc crates/zg-engine/src/pipelines/indexing/
// service.rs:131-141). --drop rejects every index option outright
// (crates/zg-cli/src/lib.rs:1535-1551).
test("refresh, --rebuild and --drop never get an injected --embedding", () => {
  for (const extra of [
    [],
    ["--debug"],
    ["--rebuild"],
    ["--drop"],
    ["--rebuild", "--debug"],
  ]) {
    const args = buildIndexArgs(extra, {
      env: { ZVEC_GREP_EMBEDDING: "local/zvec-choice" },
      newIndex: false,
    });
    assert.deepEqual(args, ["--index", ...extra]);
  }
  for (const extra of [["--rebuild"], ["--drop"], ["--rebuild", "--debug"]]) {
    assert.deepEqual(buildIndexArgs(extra, { env: {}, newIndex: true }), [
      "--index",
      ...extra,
    ]);
  }
});

test("isNewIndexState: only the no-index notes start a first build", () => {
  for (const note of ["index not created", "index not configured"]) {
    assert.equal(isNewIndexState(note), true, note);
  }
  for (const note of [
    undefined,
    "needs update",
    "failed files",
    "indexing disabled",
    "status unknown",
    "rebuild required",
  ]) {
    assert.equal(isNewIndexState(note), false, String(note));
  }
});

// Input guard: empty queries and dash-leading glob/type values are the two
// shapes that reach upstream as something other than what the agent meant.
// A dash-leading *query* is legal now: explicit route flags carry it as a
// flag value (`zg --hybrid -x` matches) and the rg route uses `-e`.
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

test("validateQueryInput: hybrid query starting with - is allowed (explicit route flag)", () => {
  assert.doesNotThrow(() =>
    validateQueryInput({
      limit: 10,
      mode: "hybrid",
      preview: "none",
      query: "-x",
    })
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
// against the 0.3.0 binary: `zg --rg -e "-x" --limit 1` runs (exit 0,
// `No matches.`); the bare `zg --rg "-x" --limit 1` form exits 1 with
// `Error: zg --rg requires a pattern`. help-query.txt recommends `-e`
// for leading-dash patterns.
test("rg route emits -e flag pair when query starts with -", () => {
  assert.deepEqual(
    buildQueryArgs({
      limit: 1,
      mode: "rg",
      preview: "none",
      query: "-x",
    }),
    ["--rg", "-e", "-x", "--color", "never", "--limit", "1"]
  );
});

// Indexed routes have no `-e` equivalent: the query rides *attached* to the
// route flag so clap cannot read it as an option. Verified against the 0.3.0
// binary — `zg --hybrid -v` works by luck (hyphen values on the positional),
// but `--hybrid --trace`, `--hybrid --refresh` and `--hybrid -L` all exit 2
// with "a value is required for '--hybrid <QUERY>'", while `--hybrid=-v`,
// `--hybrid=--trace`, `--fts=--trace` and `--vector=-v` search normally.
test("indexed routes attach a leading-dash query to the route flag", () => {
  assert.deepEqual(
    buildQueryArgs({ limit: 1, mode: "hybrid", preview: "none", query: "-v" }),
    [
      "--hybrid=-v",
      "--limit",
      "1",
      "--preview",
      "none",
      "--color",
      "never",
      "--mode",
      "auto",
    ]
  );
  for (const mode of ["fts", "vector"] as const) {
    const [first] = buildQueryArgs({
      limit: 1,
      mode,
      preview: "none",
      query: "--trace",
    });
    assert.equal(first, `--${mode}=--trace`);
  }
  // Ordinary queries keep the separated form (clap option + value).
  assert.deepEqual(
    buildQueryArgs({
      limit: 1,
      mode: "hybrid",
      preview: "none",
      query: "q",
    }).slice(0, 2),
    ["--hybrid", "q"]
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
    ["--rg", "loadTheme", "--color", "never", "--limit", "1"]
  );
});

test("parseIndexCommandArgs forwards flags untouched", () => {
  assert.deepEqual(parseIndexCommandArgs("--rebuild --debug"), {
    args: ["--rebuild", "--debug"],
    ok: true,
  });
});
test("parseIndexCommandArgs forwards a bare word only when it exists on disk", () => {
  assert.deepEqual(
    parseIndexCommandArgs("/tmp --rebuild", (p) => p === "/tmp"),
    { args: ["/tmp", "--rebuild"], ok: true }
  );
  assert.deepEqual(
    parseIndexCommandArgs("status", () => false),
    {
      ok: false,
    }
  );
});
test("parseIndexCommandArgs empty or blank input is ok with no args", () => {
  assert.deepEqual(parseIndexCommandArgs(), { args: [], ok: true });
  assert.deepEqual(parseIndexCommandArgs("   "), { args: [], ok: true });
});
