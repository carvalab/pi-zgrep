// The `zg` tool's pi-facing surface: argument repair, model text, pi's
// truncation convention, structured output, TUI renderers, how the tool
// registers (snippet, guidelines, annotations), and execute() end to end
// against a fake engine. The fake is a .mjs file, which the runner spawns
// with the current node, so these run on every OS.
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Value } from "typebox/value";

import piZgExtension, { guidanceLines, resetZgCache } from "../src/index.ts";
import { parseQueryOutput } from "../src/parse.ts";
import {
  ZgOutputSchema,
  formatQueryText,
  prepareZgArguments,
  renderCallText,
  renderResultText,
  toStructured,
  truncateForModel,
} from "../src/tool.ts";
import type { RenderTheme } from "../src/tool.ts";

const fixture = (name: string): string =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf-8");

const scratch = (t: { after: (fn: () => void) => void }): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-zg-tool-"));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  return dir;
};

// --- prepareArguments ----------------------------------------------------------

test("prepareArguments: numeric-string limit becomes a number, clamped to 1..50", () => {
  assert.deepEqual(prepareZgArguments({ limit: "5", query: "x" }), {
    limit: 5,
    query: "x",
  });
  assert.equal(
    (prepareZgArguments({ limit: 500, query: "x" }) as { limit: number }).limit,
    50
  );
  assert.equal(
    (prepareZgArguments({ limit: 0, query: "x" }) as { limit: number }).limit,
    1
  );
  assert.equal(
    (prepareZgArguments({ limit: "7.9", query: "x" }) as { limit: number })
      .limit,
    7
  );
});

const mode = (m: string): unknown =>
  (prepareZgArguments({ mode: m, query: "x" }) as { mode: unknown }).mode;

test("prepareArguments: mode synonyms and casing map to the four routes", () => {
  assert.equal(mode("semantic"), "vector");
  assert.equal(mode("BM25"), "fts");
  assert.equal(mode(" grep "), "rg");
  assert.equal(mode("ripgrep"), "rg");
  assert.equal(mode("Hybrid"), "hybrid");
  // Unknown words pass through for the schema to reject.
  assert.equal(mode("telepathy"), "telepathy");
});

test("prepareArguments: null/empty optionals are dropped, pattern/q alias query", () => {
  assert.deepEqual(
    prepareZgArguments({
      glob: "",
      limit: null,
      mode: null,
      pattern: "loadTheme",
      type: null,
    }),
    { query: "loadTheme" }
  );
  assert.deepEqual(prepareZgArguments({ q: "x" }), { query: "x" });
  // An explicit query wins; the alias is left alone.
  assert.deepEqual(prepareZgArguments({ pattern: "p", query: "x" }), {
    pattern: "p",
    query: "x",
  });
  assert.deepEqual(prepareZgArguments({ preview: "NONE", query: "x" }), {
    preview: "none",
    query: "x",
  });
});

test("prepareArguments: non-objects pass through untouched", () => {
  assert.equal(prepareZgArguments(null), null);
  assert.equal(prepareZgArguments("x"), "x");
  assert.deepEqual(prepareZgArguments(["x"]), ["x"]);
});

// --- Model text ------------------------------------------------------------------

test("zero results say so with a next step instead of empty text", () => {
  assert.match(
    formatQueryText({ results: [] }, { limit: 10, mode: "hybrid" }),
    /^No matches \(mode=hybrid\)\. Try mode=rg/u
  );
  assert.match(
    formatQueryText({ results: [] }, { limit: 10, mode: "rg" }),
    /Try mode=hybrid/u
  );
});

test("a full page says the limit was reached", () => {
  const parsed = parseQueryOutput(fixture("query-output.txt"));
  assert.ok("results" in parsed);
  const text = formatQueryText(parsed, { limit: 1, mode: "hybrid" });
  assert.match(text, /^hello\.ts:2-4/u);
  assert.match(text, /limit 1 reached\. Raise limit \(max 50\)/u);
  assert.doesNotMatch(
    formatQueryText(parsed, { limit: 10, mode: "hybrid" }),
    /limit/u
  );
  assert.match(
    formatQueryText(
      {
        results: Array.from({ length: 50 }, () => ({
          file: "a",
          lineStart: 1,
        })),
      },
      { limit: 50, mode: "fts" }
    ),
    /limit 50 reached\. Narrow the query/u
  );
});

test("unparsed output keeps the raw passthrough with the issue hint", () => {
  assert.match(
    formatQueryText({ raw: "weird" }, { limit: 10, mode: "hybrid" }),
    /unparsed.*carvalab\/pi-zgrep\):\nweird$/su
  );
});

// --- Truncation --------------------------------------------------------------------

test("small output passes through without a temp file", async (t) => {
  const dir = scratch(t);
  const out = await truncateForModel("a.ts:1  x", dir);
  assert.deepEqual(out, { text: "a.ts:1  x", truncated: false });
});

test("over 2000 lines: head kept, full output saved, notice names the file", async (t) => {
  const dir = scratch(t);
  const full = Array.from({ length: 2500 }, (_, i) => `f.ts:${i + 1}`).join(
    "\n"
  );
  const out = await truncateForModel(full, dir);
  assert.equal(out.truncated, true);
  assert.equal(out.fullOutputPath, path.join(dir, "output.txt"));
  assert.equal(readFileSync(path.join(dir, "output.txt"), "utf-8"), full);
  assert.match(out.text, /^f\.ts:1\n/u);
  assert.match(
    out.text,
    /\[Output truncated: showing 2000 of 2500 lines .*Full output saved to: /u
  );
  assert.doesNotMatch(out.text, /f\.ts:2001\n/u);
});

test("a minified mega-line is cut to 500 chars and saved in full", async (t) => {
  const dir = scratch(t);
  const line = `bundle.js:1  0  ${"x".repeat(5000)}`;
  const out = await truncateForModel(line, dir);
  assert.equal(out.truncated, true);
  assert.ok(out.text.length < 1000, "long line was cut");
  assert.match(out.text, /long lines cut to 500 characters/u);
  assert.equal(readFileSync(path.join(dir, "output.txt"), "utf-8"), line);
});

test("default temp dir is created when none is given", async () => {
  const out = await truncateForModel("y".repeat(60 * 1024));
  assert.equal(out.truncated, true);
  assert.ok(out.fullOutputPath);
  rmSync(path.dirname(out.fullOutputPath), { force: true, recursive: true });
});

// --- Structured output -----------------------------------------------------------

test("structuredContent matches outputSchema for results and raw", () => {
  const parsed = parseQueryOutput(fixture("query-output.txt"));
  const ok = toStructured(parsed, false);
  assert.ok(Value.Check(ZgOutputSchema, ok), "results shape");
  assert.equal(ok.results[0]?.file, "hello.ts");
  const raw = toStructured({ raw: "?" }, true);
  assert.ok(Value.Check(ZgOutputSchema, raw), "raw shape");
  const json = JSON.stringify(ok);
  assert.deepEqual(JSON.parse(json), ok, "JSON round-trips");
});

// --- Renderers -------------------------------------------------------------------

const theme: RenderTheme = {
  bold: (s) => `*${s}*`,
  fg: (c, s) => `<${c}>${s}</${c}>`,
};

test("renderCall shows mode, query and filters", () => {
  assert.equal(
    renderCallText(
      { glob: "src/**", limit: 3, mode: "fts", query: "loadTheme" },
      theme
    ),
    '<toolTitle>*zg *</toolTitle><muted>fts </muted><accent>"loadTheme"</accent><dim> (glob src/**, limit 3)</dim>'
  );
  assert.match(renderCallText({ query: "q" }, theme), /hybrid/u);
});

test("renderResult: partial, error, raw, empty, collapsed and expanded hits", () => {
  const collapsed = { expanded: false, isPartial: false };
  const expanded = { expanded: true, isPartial: false };
  assert.match(
    renderResultText(
      { content: [], details: { progress: "embedding 3/9" } },
      { expanded: false, isPartial: true },
      theme
    ),
    /<warning>searching… embedding 3\/9<\/warning>/u
  );
  const err = {
    content: [{ text: "zg error: boom\ndetail line", type: "text" }],
    details: { isError: true as const },
    isError: true,
  };
  assert.equal(
    renderResultText(err, collapsed, theme),
    "<error>zg error: boom</error>"
  );
  assert.match(renderResultText(err, expanded, theme), /detail line/u);
  assert.match(
    renderResultText({ content: [], details: { raw: "x" } }, collapsed, theme),
    /unparsed zg output/u
  );
  assert.match(
    renderResultText(
      { content: [], details: { results: [] } },
      collapsed,
      theme
    ),
    /No matches/u
  );
  const results = Array.from({ length: 8 }, (_, i) => ({
    file: `f${i}.ts`,
    lineEnd: i + 2,
    lineStart: i + 1,
    snippet: `snippet ${i}`,
  }));
  const c = renderResultText(
    { content: [], details: { results, truncated: true } },
    collapsed,
    theme
  );
  assert.match(c, /<success>8 hits<\/success><warning> \(output truncated\)/u);
  assert.match(c, /f0\.ts:1-2/u);
  assert.match(c, /… 3 more \(expand to see all\)/u);
  assert.doesNotMatch(c, /snippet/u);
  const e = renderResultText(
    { content: [], details: { fullOutputPath: "/tmp/o.txt", results } },
    expanded,
    theme
  );
  assert.match(e, /f7\.ts:8-9 {4}snippet 7/u);
  assert.match(e, /Full output: \/tmp\/o\.txt/u);
  assert.match(
    renderResultText(
      { content: [], details: { results: results.slice(0, 1) } },
      collapsed,
      theme
    ),
    /1 hit</u
  );
});

// --- Registration ----------------------------------------------------------------

interface Captured {
  commands: string[];
  events: string[];
  tools: Record<string, unknown>[];
}

const register = (): Captured => {
  const cap: Captured = { commands: [], events: [], tools: [] };
  const fakePi = {
    on: (event: string): void => {
      cap.events.push(event);
    },
    registerCommand: (name: string): void => {
      cap.commands.push(name);
    },
    registerTool: (def: Record<string, unknown>): void => {
      cap.tools.push(def);
    },
  };
  piZgExtension(fakePi as unknown as Parameters<typeof piZgExtension>[0]);
  return cap;
};

test("registers one zg tool with snippet, guidelines, annotations and renderers", () => {
  const cap = register();
  assert.equal(cap.tools.length, 1);
  const tool = cap.tools[0] ?? {};
  assert.equal(tool.name, "zg");
  assert.equal(typeof tool.promptSnippet, "string");
  assert.deepEqual(tool.promptGuidelines, guidanceLines());
  assert.deepEqual(tool.annotations, {
    openWorldHint: false,
    readOnlyHint: true,
  });
  assert.equal(typeof tool.prepareArguments, "function");
  assert.ok(tool.outputSchema);
  for (const fn of ["renderCall", "renderResult", "execute"]) {
    assert.equal(typeof tool[fn], "function", fn);
  }
  assert.deepEqual(cap.commands.toSorted(), [
    "zg-index",
    "zg-server",
    "zg-status",
  ]);
  // Guidance now rides on promptGuidelines; no whole-prompt replacement.
  assert.deepEqual(cap.events, ["session_start"]);
});

test("every guideline names zg (pi lists them among all tools' rules)", () => {
  for (const line of guidanceLines()) {
    assert.match(line, /\bzg\b/u);
  }
});

test("PI_ZG_GUIDANCE opts out of the guidelines but keeps the snippet", (t) => {
  process.env.PI_ZG_GUIDANCE = "1";
  t.after(() => {
    delete process.env.PI_ZG_GUIDANCE;
  });
  const tool = register().tools[0] ?? {};
  assert.equal(tool.promptGuidelines, undefined);
  assert.equal(typeof tool.promptSnippet, "string");
});

test("prepareArguments output passes the tool's own schema", () => {
  const tool = register().tools[0] as {
    parameters: Parameters<typeof Value.Check>[0];
    prepareArguments: (a: unknown) => unknown;
  };
  const fixed = tool.prepareArguments({
    glob: null,
    limit: "3",
    mode: "semantic",
    query: "where is the theme restored",
  });
  assert.ok(Value.Check(tool.parameters, fixed));
  assert.ok(
    !Value.Check(tool.parameters, { limit: "3", mode: "semantic", query: "x" })
  );
});

test("renderers return pi-tui components that render to lines", () => {
  const tool = register().tools[0] as {
    renderCall: (
      a: unknown,
      th: RenderTheme
    ) => { render: (w: number) => string[] };
    renderResult: (
      r: unknown,
      o: unknown,
      th: RenderTheme
    ) => { render: (w: number) => string[] };
  };
  const call = tool.renderCall({ mode: "rg", query: "loadTheme" }, theme);
  assert.ok(call.render(80).join("\n").includes("loadTheme"));
  const res = tool.renderResult(
    { content: [], details: { results: [{ file: "a.ts", lineStart: 1 }] } },
    { expanded: false, isPartial: false },
    theme
  );
  assert.ok(res.render(80).join("\n").includes("a.ts:1"));
});

// --- execute() against a fake engine ---------------------------------------------

// Fake `zg`: --version, status (ready), and `query` printing $FAKE_ZG_OUT with
// exit $FAKE_ZG_CODE. Every argv is appended to $FAKE_ZG_LOG.
const makeFakeZg = (dir: string): string => {
  const p = path.join(dir, "fake-zg.mjs");
  writeFileSync(
    p,
    `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_ZG_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "--version") { console.log("0.2.2"); process.exit(0); }
if (args[0] === "status") { console.log("✓ Workspace index is ready"); process.exit(0); }
if (args[0] === "query") {
  process.stdout.write(readFileSync(process.env.FAKE_ZG_OUT, "utf-8"));
  process.stderr.write(process.env.FAKE_ZG_ERR ?? "");
  process.exit(Number(process.env.FAKE_ZG_CODE ?? 0));
}
process.exit(0);
`
  );
  return p;
};

interface ToolResult {
  content: { text: string; type: string }[];
  details: Record<string, unknown>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const runTool = async (
  t: { after: (fn: () => void) => void },
  params: Record<string, unknown>,
  engine: { code?: number; err?: string; out: string }
): Promise<{ log: string[][]; result: ToolResult }> => {
  const dir = scratch(t);
  const cwd = path.join(dir, "work");
  mkdirSync(cwd);
  const out = path.join(dir, "out.txt");
  const log = path.join(dir, "log.jsonl");
  writeFileSync(out, engine.out);
  writeFileSync(log, "");
  const env: Record<string, string> = {
    FAKE_ZG_CODE: String(engine.code ?? 0),
    FAKE_ZG_ERR: engine.err ?? "",
    FAKE_ZG_LOG: log,
    FAKE_ZG_OUT: out,
    PI_ZG_BIN: makeFakeZg(dir),
    PI_ZG_SERVER: "1",
  };
  const saved = new Map(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  resetZgCache();
  t.after(() => {
    for (const [k, v] of saved) {
      if (v === undefined) {
        Reflect.deleteProperty(process.env, k);
      } else {
        process.env[k] = v;
      }
    }
    resetZgCache();
  });
  const tool = register().tools[0] as {
    execute: (...a: unknown[]) => Promise<ToolResult>;
    prepareArguments: (a: unknown) => unknown;
  };
  const ui = { notify: (): void => {}, setStatus: (): void => {} };
  const result = await tool.execute(
    "call-1",
    tool.prepareArguments(params),
    undefined,
    undefined,
    { cwd, ui }
  );
  const lines = readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
  return { log: lines.map((l) => JSON.parse(l) as string[]), result };
};

test("execute: hybrid query returns text, details and structuredContent", async (t) => {
  const { log, result } = await runTool(
    t,
    { limit: "3", query: "where is the theme restored" },
    { out: fixture("query-output.txt") }
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.text ?? "", /^hello\.ts:2-4/u);
  assert.equal(result.details.mode, "hybrid");
  assert.equal(result.details.truncated, false);
  const structured = result.structuredContent?.results as unknown[] | undefined;
  assert.equal(structured?.length, 1);
  assert.ok(Value.Check(ZgOutputSchema, result.structuredContent));
  const query = log.find((a) => a[0] === "query");
  assert.deepEqual(query, [
    "query",
    "where is the theme restored",
    "--limit",
    "3",
    "--preview",
    "short",
    "--mode",
    "auto",
  ]);
});

test("execute: rg with no matches gives a readable empty result", async (t) => {
  const { log, result } = await runTool(
    t,
    { mode: "grep", query: "nothingHere" },
    { out: "No matches.\n" }
  );
  assert.match(result.content[0]?.text ?? "", /^No matches \(mode=rg\)/u);
  assert.deepEqual(result.structuredContent?.results, []);
  assert.ok(!log.some((a) => a[0] === "status"), "rg skips the index check");
});

test("execute: engine failure is an error result with stderr", async (t) => {
  const { result } = await runTool(
    t,
    { mode: "fts", query: "x" },
    { code: 2, err: "bad things", out: "" }
  );
  assert.equal(result.isError, true);
  assert.equal(result.content[0]?.text, "zg error (exit 2): bad things");
});

test("execute: invalid input is rejected before any engine spawn", async (t) => {
  const { log, result } = await runTool(t, { query: "-flag" }, { out: "" });
  assert.equal(result.isError, true);
  assert.match(
    result.content[0]?.text ?? "",
    /leading "-" queries must use mode=rg/u
  );
  assert.deepEqual(log, [], "no probe, install, status or build");
});

test("execute: huge output is truncated with the full text on disk", async (t) => {
  const big = [
    "hello.ts",
    ...Array.from({ length: 3000 }, (_, i) => `  ${i + 1}:\tline ${i + 1}`),
    "",
  ].join("\n");
  const { result } = await runTool(
    t,
    { limit: 50, mode: "rg", query: "line" },
    { out: big }
  );
  assert.equal(result.details.truncated, true);
  const saved = result.details.fullOutputPath as string;
  assert.match(result.content[0]?.text ?? "", /Full output saved to: /u);
  assert.match(readFileSync(saved, "utf-8"), /hello\.ts:3000 {4}line 3000/u);
  assert.equal(result.structuredContent?.truncated, true);
  rmSync(path.dirname(saved), { force: true, recursive: true });
});
