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

// rg-shaped input: bare path first line, then `^\d+: <text>` (or tab)
// match blocks. Context lines from `-A/-B/-C` look like `^\d+- <text>`
// and the `--` group separator sits between ripgrep path groups.
const RG_PATH_LINE = /^(?<path>[^\s:#][^:#\s]*)$/u;
const RG_MATCH_LINE = /^\s*(?<line>\d+):(?<sep>[ \t])(?<text>.*)$/u;
const RG_CONTEXT_LINE = /^\s*\d+-[ \t]/u;
const RG_GROUP_SEPARATOR = /^--$/u;

// Detect + parse the --rg stanza. Returns { results } when the input
// is rg-shaped and at least one match line is found; returns null
// when rg shape isn't recognized (caller falls through to the
// indexed-stanza path). Pulled out of parseQueryOutput so the latter
// stays under the oxlint complexity ceiling.
const parseRgOutput = (text: string): QueryParse | null => {
  const lines = text.split(/\r?\n/u);
  const firstNonEmpty = lines.find((l) => l.length > 0);
  if (firstNonEmpty === undefined) {
    return null;
  }
  if (firstNonEmpty === "No matches.") {
    return { results: [] };
  }
  const firstPath = RG_PATH_LINE.exec(firstNonEmpty);
  if (firstPath?.groups?.path === undefined) {
    return null;
  }
  const rgResults: ZgResult[] = [];
  let currentFile = firstPath.groups.path;
  for (const ln of lines) {
    if (RG_GROUP_SEPARATOR.test(ln)) {
      currentFile = "";
      continue;
    }
    const sep = RG_PATH_LINE.exec(ln);
    if (sep?.groups?.path !== undefined) {
      // Subsequent path lines appear after `--` in ripgrep output.
      // Update currentFile for any match lines that follow.
      currentFile = sep.groups.path;
      continue;
    }
    const match = RG_MATCH_LINE.exec(ln);
    if (match?.groups) {
      const lineStart = Number(match.groups.line);
      const snippet = match.groups.text ?? "";
      rgResults.push({ file: currentFile, lineStart, snippet });
      continue;
    }
    // Context line (e.g. `  2-\t...`) — not a hit, skip.
    if (RG_CONTEXT_LINE.test(ln)) {
      continue;
    }
    // Anything else inside the rg stanza is unexpected for our
    // captured shape; bail to raw rather than fabricate.
    if (ln.length > 0) {
      return { raw: text };
    }
  }
  if (rgResults.length > 0) {
    return { results: rgResults };
  }
  // Recognized rg shape but produced no hits — fall through so we
  // still return {raw} for unrecognized empty-ish input rather than
  // silently swallowing it.
  return null;
};

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
  // rg-shaped short-circuit: bare path first line + at least one
  // ripgrep match line below. Detect this BEFORE the `query groups`
  // header gate because --rg output is intentionally headerless (see
  // test/fixtures/NOTES.md). Anything we don't recognize here falls
  // through to the indexed-stanza path below.
  const rg = parseRgOutput(text);
  if (rg !== null) {
    return rg;
  }

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
    // Tri-state: "not configured" means no index exists yet (the
    // README's "missing" bucket); any other `?` label is the
    // existing-but-stale case. Distinguishing them lets the agent
    // recommend `zg index` vs. a rebuild instead of a single blanket
    // "possibly stale" reply.
    const freshness = /not configured/u.test(firstNonEmpty)
      ? "not configured"
      : "possibly_stale";
    return { freshness, ready: false };
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
