// Model- and TUI-facing shape of the `zg` tool: argument repair before schema
// validation, the text the model reads (empty-result and limit hints, pi's
// standard truncation), structured output for programmatic callers, and the
// call/result renderers. Spawning stays in index.ts.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { QueryMode } from "./args.ts";
import { renderResults } from "./parse.ts";
import type { QueryParse, ZgResult } from "./parse.ts";

export const MAX_LIMIT = 50;
export const DEFAULT_LIMIT = 10;
// pi's grep tool uses the same per-line cap for match lines.
const MAX_LINE_CHARS = 500;

export interface ZgToolDetails {
  fullOutputPath?: string;
  isError?: true;
  mode?: QueryMode;
  progress?: string;
  query?: string;
  raw?: string;
  results?: ZgResult[];
  truncated?: boolean;
}

// --- prepareArguments --------------------------------------------------------

// Words models reach for instead of the four mode literals.
const MODE_ALIASES: Record<string, QueryMode> = {
  bm25: "fts",
  embedding: "vector",
  embeddings: "vector",
  fts: "fts",
  "full-text": "fts",
  fulltext: "fts",
  grep: "rg",
  hybrid: "hybrid",
  keyword: "fts",
  literal: "rg",
  regex: "rg",
  rg: "rg",
  ripgrep: "rg",
  semantic: "vector",
  text: "fts",
  vector: "vector",
};

const OPTIONAL_KEYS = new Set([
  "glob",
  "limit",
  "mode",
  "preview",
  "refresh",
  "type",
]);

// Repairs the argument shapes models commonly send, so they pass schema
// validation instead of costing a retry: numeric strings for `limit`, limits
// outside 1..50, mode synonyms ("semantic", "grep") and casing, `null` or ""
// for omitted optionals, and `pattern`/`q` in place of `query`. Anything it
// does not recognize passes through for the schema to reject.
export const prepareZgArguments = (args: unknown): unknown => {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return args;
  }
  // Rebuilt without the omitted optionals rather than mutated in place.
  const a: Record<string, unknown> = Object.fromEntries(
    Object.entries(args as Record<string, unknown>).filter(
      ([k, v]) => !(OPTIONAL_KEYS.has(k) && (v === null || v === ""))
    )
  );
  if (a.query === undefined) {
    const { pattern, q, ...rest } = a;
    const alias = pattern ?? q;
    if (typeof alias === "string") {
      return prepareZgArguments({ ...rest, query: alias });
    }
  }
  if (typeof a.limit === "string" && a.limit.trim() !== "") {
    const n = Number(a.limit.trim());
    if (Number.isFinite(n)) {
      a.limit = n;
    }
  }
  if (typeof a.limit === "number" && Number.isFinite(a.limit)) {
    a.limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(a.limit)));
  }
  if (typeof a.mode === "string") {
    a.mode = MODE_ALIASES[a.mode.trim().toLowerCase()] ?? a.mode;
  }
  for (const key of ["preview", "refresh"]) {
    const v = a[key];
    if (typeof v === "string") {
      a[key] = v.trim().toLowerCase();
    }
  }
  return a;
};

// --- Result text ---------------------------------------------------------------

const emptyHint = (mode: QueryMode): string =>
  mode === "rg"
    ? "Try mode=hybrid for intent-based search, or loosen the pattern."
    : "Try mode=rg for exact text, a different mode, or a broader query.";

// The text the model reads for a parsed query. Zero results say so instead
// of returning an empty string; a full page says more may exist.
export const formatQueryText = (
  parsed: QueryParse,
  o: { limit: number; mode: QueryMode }
): string => {
  if ("raw" in parsed) {
    return `zg output (unparsed — upstream format may have changed; run /zg-status and file an issue at carvalab/pi-zgrep):\n${parsed.raw}`;
  }
  if (parsed.results.length === 0) {
    return `No matches (mode=${o.mode}). ${emptyHint(o.mode)}`;
  }
  const body = renderResults(parsed);
  if (parsed.results.length >= o.limit) {
    const how =
      o.limit < MAX_LIMIT
        ? `Raise limit (max ${MAX_LIMIT}) or narrow glob/type for more.`
        : "Narrow the query or glob/type for more.";
    return `${body}\n\n[${parsed.results.length} results, limit ${o.limit} reached. ${how}]`;
  }
  return body;
};

export interface Truncated {
  fullOutputPath?: string;
  text: string;
  truncated: boolean;
}

// pi's convention for tool output: cap each line, keep the head within
// DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES, and when anything was cut, save the
// full text to a temp file and say where. `saveDir` is injectable for tests.
export const truncateForModel = async (
  text: string,
  saveDir?: string
): Promise<Truncated> => {
  let linesCut = false;
  const capped = text
    .split("\n")
    .map((line) => {
      const t = truncateLine(line, MAX_LINE_CHARS);
      linesCut ||= t.wasTruncated;
      return t.text;
    })
    .join("\n");
  const head = truncateHead(capped, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!head.truncated && !linesCut) {
    return { text, truncated: false };
  }
  const dir = saveDir ?? (await mkdtemp(path.join(tmpdir(), "pi-zgrep-")));
  const fullOutputPath = path.join(dir, "output.txt");
  await writeFile(fullOutputPath, text, "utf-8");
  const what = head.truncated
    ? `showing ${head.outputLines} of ${head.totalLines} lines (${formatSize(head.outputBytes)} of ${formatSize(head.totalBytes)})`
    : `long lines cut to ${MAX_LINE_CHARS} characters`;
  return {
    fullOutputPath,
    text: `${head.content}\n\n[Output truncated: ${what}. Full output saved to: ${fullOutputPath}]`,
    truncated: true,
  };
};

// --- Structured output ---------------------------------------------------------

export const ZgOutputSchema = Type.Object({
  raw: Type.Optional(
    Type.String({ description: "Unparsed engine output, when parsing failed" })
  ),
  results: Type.Array(
    Type.Object({
      file: Type.String(),
      lineEnd: Type.Optional(Type.Number()),
      lineStart: Type.Number(),
      score: Type.Optional(Type.Number()),
      snippet: Type.Optional(Type.String()),
    })
  ),
  truncated: Type.Boolean(),
});

// JSON-shaped copy for pi's structuredContent (JsonValue needs index
// signatures, which the ZgResult interface does not declare).
type JsonResult = Record<string, string | number>;
export const toStructured = (
  parsed: QueryParse,
  truncated: boolean
): { raw?: string; results: JsonResult[]; truncated: boolean } =>
  "raw" in parsed
    ? { raw: parsed.raw, results: [], truncated }
    : {
        results: parsed.results.map((r): JsonResult => ({ ...r })),
        truncated,
      };

// --- Renderers -----------------------------------------------------------------

// The slice of pi's Theme the renderers use; tests pass a fake.
export interface RenderTheme {
  bold: (text: string) => string;
  fg: (
    color:
      | "accent"
      | "dim"
      | "error"
      | "muted"
      | "success"
      | "toolTitle"
      | "warning",
    text: string
  ) => string;
}

export interface ZgCallArgs {
  glob?: string;
  limit?: number;
  mode?: string;
  query?: string;
  type?: string;
}

export const renderCallText = (
  args: ZgCallArgs,
  theme: RenderTheme
): string => {
  let text = theme.fg("toolTitle", theme.bold("zg "));
  text += theme.fg("muted", `${args.mode ?? "hybrid"} `);
  text += theme.fg("accent", JSON.stringify(args.query ?? ""));
  const filters = [
    args.glob ? `glob ${args.glob}` : "",
    args.type ? `type ${args.type}` : "",
    args.limit ? `limit ${args.limit}` : "",
  ].filter((s) => s.length > 0);
  if (filters.length > 0) {
    text += theme.fg("dim", ` (${filters.join(", ")})`);
  }
  return text;
};

const COLLAPSED_LINES = 5;
const EXPANDED_LINES = 50;

export interface RenderableResult {
  content: { text?: string; type: string }[];
  details?: ZgToolDetails;
  isError?: boolean;
}

const firstText = (r: RenderableResult): string =>
  r.content.find((c) => c.type === "text")?.text ?? "";

const listLines = (
  lines: string[],
  max: number,
  theme: RenderTheme
): string => {
  let out = "";
  for (const line of lines.slice(0, max)) {
    out += `\n${theme.fg("dim", line)}`;
  }
  if (lines.length > max) {
    out += `\n${theme.fg("muted", `… ${lines.length - max} more (expand to see all)`)}`;
  }
  return out;
};

const renderError = (
  result: RenderableResult,
  expanded: boolean,
  theme: RenderTheme
): string => {
  const [first = "zg error", ...rest] = firstText(result).split("\n");
  const text = theme.fg("error", first);
  return expanded ? text + listLines(rest, EXPANDED_LINES, theme) : text;
};

const renderRaw = (
  raw: string,
  expanded: boolean,
  theme: RenderTheme
): string => {
  const text = theme.fg("warning", "unparsed zg output; run /zg-status");
  return expanded
    ? text + listLines(raw.split("\n"), EXPANDED_LINES, theme)
    : text;
};

const renderHits = (
  d: ZgToolDetails | undefined,
  expanded: boolean,
  theme: RenderTheme
): string => {
  const results = d?.results ?? [];
  if (results.length === 0) {
    return theme.fg("dim", "No matches");
  }
  let text = theme.fg(
    "success",
    `${results.length} ${results.length === 1 ? "hit" : "hits"}`
  );
  if (d?.truncated) {
    text += theme.fg("warning", " (output truncated)");
  }
  const lines = expanded
    ? renderResults({ results }).split("\n")
    : results.map((r) =>
        r.lineEnd === undefined
          ? `${r.file}:${r.lineStart}`
          : `${r.file}:${r.lineStart}-${r.lineEnd}`
      );
  text += listLines(lines, expanded ? EXPANDED_LINES : COLLAPSED_LINES, theme);
  if (expanded && d?.fullOutputPath) {
    text += `\n${theme.fg("dim", `Full output: ${d.fullOutputPath}`)}`;
  }
  return text;
};

export const renderResultText = (
  result: RenderableResult,
  o: { expanded: boolean; isPartial: boolean },
  theme: RenderTheme
): string => {
  const d = result.details;
  if (o.isPartial) {
    const progress = d?.progress ? ` ${d.progress.slice(0, 80)}` : "";
    return theme.fg("warning", `searching…${progress}`);
  }
  if (result.isError || d?.isError) {
    return renderError(result, o.expanded, theme);
  }
  if (d?.raw !== undefined) {
    return renderRaw(d.raw, o.expanded, theme);
  }
  return renderHits(d, o.expanded, theme);
};
