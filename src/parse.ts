// Output parser for `zg` (zvec-grep). Targets the default (agent markdown)
// stanza format captured in test/fixtures/query-output.txt. Any structural
// mismatch returns { raw: text } — upstream is pre-1.0 and may change, so the
// parser must never fabricate structure it didn't see.

export interface ZgResult {
  file: string;
  lineStart: number;
  lineEnd?: number;
  score?: number;
  snippet?: string;
}

export type QueryParse = { results: ZgResult[] } | { raw: string };

export type StatusParse =
  | { ready: boolean; freshness?: string }
  | { raw: string };

const HIT_LINE =
  /^#(?<idx>\d+)\s+(?:(?<attrs>.+?)\s+)?(?<file>\S+):(?<start>\d+)(?:-(?<end>\d+))?\s*$/u;
const GROUP_HEADER = /^Q\d+\s+\[\w+\]:\s*/u;
const HITS_LINE = /^hits:\s*\d+\s*$/u;
const PREVIEW_LINE = /^(?<num>\d+)\t(?<text>.*)$/u;
const STATUS_MARKER = /^(?<marker>[✓?])\s+Workspace\s+index\s+is\s+/u;
const QUERY_HEADER = /^query groups \(\d+\):\s*$/u;
const HIT_LINE_FRONT = /^#\d+\s/u;
const SCORE_ATTR = /\bscore=(?<val>[\d.]+)/u;

const collectPreview = (
  lines: string[],
  start: number
): {
  snippet: string | undefined;
  next: number;
} => {
  let j = start;
  if (j < lines.length && lines[j] === "source:") {
    j += 1;
  }
  const previewLines: string[] = [];
  while (j < lines.length) {
    const pl = lines[j] ?? "";
    if (pl === "") {
      break;
    }
    if (GROUP_HEADER.test(pl)) {
      break;
    }
    if (HIT_LINE_FRONT.test(pl)) {
      break;
    }
    const pm = PREVIEW_LINE.exec(pl);
    const snippetLine = pm?.groups?.text ?? pl;
    previewLines.push(snippetLine);
    j += 1;
  }
  const snippet = previewLines.length > 0 ? previewLines.join("\n") : undefined;
  return { next: j, snippet };
};

const parseScore = (attrs: string): number | undefined => {
  const m = SCORE_ATTR.exec(attrs);
  if (m === null) {
    return undefined;
  }
  const raw = Number(m.groups?.val);
  return Number.isNaN(raw) ? undefined : raw;
};

export const parseQueryOutput = (text: string): QueryParse => {
  const lines = text.split(/\r?\n/u);
  const [firstLine] = lines;
  if (firstLine === undefined) {
    return { raw: text };
  }

  // Header gate: must start with `query groups (N):`.
  if (!QUERY_HEADER.test(firstLine)) {
    return { raw: text };
  }

  const results: ZgResult[] = [];
  let i = 1;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line === "") {
      i += 1;
      continue;
    }

    if (GROUP_HEADER.test(line)) {
      i += 1;
      continue;
    }

    if (HITS_LINE.test(line)) {
      i += 1;
      continue;
    }

    const m = HIT_LINE.exec(line);
    if (m) {
      const groups = m.groups ?? {};
      const file = groups.file ?? "";
      const lineStart = Number(groups.start);
      const endStr = groups.end;
      const lineEnd = endStr ? Number(endStr) : undefined;
      const score = parseScore(groups.attrs ?? "");
      const { snippet, next } = collectPreview(lines, i + 1);

      const result: ZgResult = { file, lineStart };
      if (lineEnd !== undefined) {
        result.lineEnd = lineEnd;
      }
      if (score !== undefined) {
        result.score = score;
      }
      if (snippet !== undefined) {
        result.snippet = snippet;
      }

      results.push(result);
      i = next;
      continue;
    }

    // Unknown line: bail out rather than guess. The upstream format may have
    // changed; surfacing raw is the safer compat behavior.
    return { raw: text };
  }

  return { results };
};

export const parseStatusOutput = (text: string): StatusParse => {
  const firstNonEmpty = text.split(/\r?\n/u).find((l) => l.length > 0);
  if (firstNonEmpty === undefined) {
    return { raw: text };
  }

  const m = STATUS_MARKER.exec(firstNonEmpty);
  if (m === null) {
    return { raw: text };
  }

  const marker = m.groups?.marker ?? "";
  if (marker === "✓") {
    return { freshness: "fresh", ready: true };
  }
  if (marker === "?") {
    return { freshness: "possibly_stale", ready: false };
  }
  return { raw: text };
};

export const renderResults = (
  p: Exclude<QueryParse, { raw: string }>
): string => {
  const lines: string[] = [];
  for (const r of p.results) {
    const range =
      r.lineEnd === undefined
        ? `${r.lineStart}`
        : `${r.lineStart}-${r.lineEnd}`;
    const score = r.score ?? "";
    const firstSnippetLine =
      r.snippet === undefined ? "" : (r.snippet.split("\n")[0] ?? "");
    lines.push(`${r.file}:${range}  ${score}  ${firstSnippetLine}`);
  }
  return lines.join("\n");
};
