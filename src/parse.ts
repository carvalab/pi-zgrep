// Output parser for `zg` (zvec-grep) 0.3.0. Two shapes the CLI emits, both
// captured from the real binary into test/fixtures/:
//
//   - indexed routes (--hybrid/--fts/--vector), one block per hit:
//       #<rank> <path>:<start>[-<end>]
//       symbol: [function] AuthService      ← optional metadata line
//       status: possibly_stale              ← optional metadata line
//         <line>: <text>                    ← source (--preview short|full)
//     With --preview none the same header is followed by `<line>\t<text>`
//     source lines and no `source:`/`matched:` metadata.
//   - managed ripgrep (--rg): a bare path line, a blank line between path
//     groups, then two-space indented `<line>: <text>` match lines.
//
// Multi-query runs prefix each non-empty group with `-- query i/n: text --`.
// Any structural mismatch returns { raw: text } — upstream is pre-1.0 and may
// change, so the parser must never fabricate structure it didn't see.

export interface ZgResult {
  file: string;
  lineStart: number;
  lineEnd?: number;
  // zg 0.3.0 prints `#<rank> <path>:<range>` and, only with --preview detail,
  // a `score=<n>` attribute. Short previews carry no score, so this stays
  // optional; renderResults keeps a column for it when one is present.
  score?: number;
  snippet?: string;
}

export type QueryParse = { results: ZgResult[] } | { raw: string };

export type StatusParse =
  | { ready: boolean; freshness?: string }
  | { raw: string };

// The path may contain spaces and drive letters (`C:\\Work Folder\\my notes.md`),
// so the file group is greedy up to the trailing `:<start>[-<end>]`.
const HIT_LINE = /^#\d+\s+(?<file>.+):(?<start>\d+)(?:-(?<end>\d+))?\s*$/u;
const HIT_LINE_FRONT = /^#\d+\s/u;
// `-- query 1/2: AuthService --` (plain output; colored output only adds
// theme escapes, and buildQueryArgs forces --color never).
const GROUP_DIVIDER = /^--\s+query\s+\d+\/\d+:.*--\s*$/u;
const NO_HITS_LINE = /^No (?:matches|searchable files)\.$/u;
// --preview short|full source line: two-space indent, line number, colon.
// The clamps cut long lines with a `…` marker line of its own.
const SHORT_PREVIEW_LINE = /^\s{2}(?<num>\d+):(?: (?<text>.*))?$/u;
const TRUNCATION_LINE = /^\s{2}(?:…|\.\.\.)$/u;
// --preview none source line: line number, tab, text.
const PLAIN_PREVIEW_LINE = /^(?<num>\d+)\t(?<text>.*)$/u;
// Header-adjacent metadata: never source text, so it must not reach the
// snippet. Covers code (`symbol:`), markdown (`heading:`), diagnostics, and
// the 0.3.0 stale-index trailer — a stale index stamps each hit with
// `status: possibly_stale` and closes the run with `results:
// served_from_current_index` / `background_refresh: idle (n/m)`. Those are
// run-level facts, not hits, so they end the listing instead of forcing the
// whole query to {raw}.
const METADATA_LINE =
  /^(?:symbol|heading|heading_level|scope|status|matched|source|outline|score|trace|results|background_refresh):/u;
// `  Coverage    ████ 100%  1 / 1 files` or
// `  Coverage    Unavailable (rebuild required)`.
const STATUS_COVERAGE = /^\s*Coverage\s+(?<value>.+?)\s*$/u;
const STATUS_NOTE = /\((?<note>[^()]*)\)\s*$/u;

// rg-shaped input: a bare, unindented path line (spaces allowed — repo folders
// and file names may contain them), then two-space indented `<line>: <text>`
// match lines, with a blank line between path groups. `#` is excluded because an
// indexed hit header (`#1 path:1-3`) starts with it, and `--` because a
// multi-query run prefixes every group with a `-- query i/n: ... --` divider.
const RG_PATH_LINE = /^(?!#)(?!--)(?<path>\S(?:.*\S)?)$/u;
const RG_MATCH_LINE = /^\s+(?<line>\d+):[ \t](?<text>.*)$/u;

// Detect + parse the --rg stanza. Returns { results } when the input is
// rg-shaped and at least one match line is found; returns null when the rg
// shape is not recognized (caller falls through to the indexed-stanza path).
// Pulled out of parseQueryOutput so the latter stays under the oxlint
// complexity ceiling.
const parseRgOutput = (text: string): QueryParse | null => {
  const lines = text.split(/\r?\n/u);
  const firstNonEmpty = lines.find(
    (l) => l.length > 0 && !GROUP_DIVIDER.test(l)
  );
  if (firstNonEmpty === undefined) {
    return null;
  }
  if (NO_HITS_LINE.test(firstNonEmpty)) {
    return { results: [] };
  }
  const firstPath = RG_PATH_LINE.exec(firstNonEmpty);
  if (firstPath?.groups?.path === undefined) {
    return null;
  }
  const rgResults: ZgResult[] = [];
  let currentFile = firstPath.groups.path;
  for (const ln of lines) {
    // Blank lines separate path groups; a divider separates query groups.
    if (ln.length === 0 || GROUP_DIVIDER.test(ln) || NO_HITS_LINE.test(ln)) {
      continue;
    }
    const sep = RG_PATH_LINE.exec(ln);
    if (sep?.groups?.path !== undefined) {
      // A bare line starts the next path group; the blank line before it
      // separates groups in 0.3.0 output.
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
    // Anything else inside the rg stanza is unexpected for our captured
    // shape (e.g. -A/-B/-C context lines, which this extension never
    // requests); bail to raw rather than fabricate.
    return { raw: text };
  }
  if (rgResults.length > 0) {
    return { results: rgResults };
  }
  // Recognized rg shape but produced no hits — fall through so we still
  // return {raw} for unrecognized empty-ish input rather than silently
  // swallowing it.
  return null;
};

interface HitBody {
  next: number;
  snippet: string | undefined;
}

// Consume everything between a `#<rank> <path>:<range>` header and the next
// header/divider/blank line: optional metadata lines plus the source preview.
// Returns null when a line is neither, so the caller can bail to {raw}.
const readHitBody = (lines: string[], start: number): HitBody | null => {
  const previewLines: string[] = [];
  let next = start;
  while (next < lines.length) {
    const line = lines[next] ?? "";
    if (
      line.length === 0 ||
      HIT_LINE_FRONT.test(line) ||
      GROUP_DIVIDER.test(line) ||
      NO_HITS_LINE.test(line)
    ) {
      break;
    }
    if (METADATA_LINE.test(line) || TRUNCATION_LINE.test(line)) {
      next += 1;
      continue;
    }
    const short = SHORT_PREVIEW_LINE.exec(line);
    if (short?.groups) {
      previewLines.push(short.groups.text ?? "");
      next += 1;
      continue;
    }
    const plain = PLAIN_PREVIEW_LINE.exec(line);
    if (plain?.groups) {
      previewLines.push(plain.groups.text ?? "");
      next += 1;
      continue;
    }
    return null;
  }
  return {
    next,
    snippet: previewLines.length > 0 ? previewLines.join("\n") : undefined,
  };
};

export const parseQueryOutput = (text: string): QueryParse => {
  // rg-shaped short-circuit: bare path first line + at least one ripgrep
  // match line below. Detect this BEFORE the indexed-stanza path because
  // --rg output is intentionally headerless (see test/fixtures/NOTES.md).
  const rg = parseRgOutput(text);
  if (rg !== null) {
    return rg;
  }

  const lines = text.split(/\r?\n/u);
  const results: ZgResult[] = [];
  let sawStructure = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.length === 0) {
      i += 1;
      continue;
    }

    if (GROUP_DIVIDER.test(line) || NO_HITS_LINE.test(line)) {
      sawStructure = true;
      i += 1;
      continue;
    }

    const m = HIT_LINE.exec(line);
    if (!m?.groups) {
      // Unknown line: bail out rather than guess. The upstream format may
      // have changed; surfacing raw is the safer compat behavior.
      return { raw: text };
    }

    const body = readHitBody(lines, i + 1);
    if (body === null) {
      return { raw: text };
    }

    sawStructure = true;
    const result: ZgResult = {
      file: m.groups.file ?? "",
      lineStart: Number(m.groups.start),
    };
    if (m.groups.end !== undefined) {
      result.lineEnd = Number(m.groups.end);
    }
    if (body.snippet !== undefined) {
      result.snippet = body.snippet;
    }
    results.push(result);
    i = body.next;
  }

  if (!sawStructure) {
    return { raw: text };
  }
  return { results };
};

// `zg --status` prints a four-field block; the first non-empty line is
// Coverage, whose readiness note is the only not-ready signal on stdout:
//   Coverage    ████████████████████ 100%  1 / 1 files        → ready
//   Coverage    Unavailable (rebuild required)                → not ready
// The authoritative readiness API is still the --check-ready exit code
// (src/zg.ts); this only labels the state for /zg-status.
export const parseStatusOutput = (text: string): StatusParse => {
  const firstNonEmpty = text.split(/\r?\n/u).find((l) => l.length > 0);
  if (firstNonEmpty === undefined) {
    return { raw: text };
  }

  const value = STATUS_COVERAGE.exec(firstNonEmpty)?.groups?.value;
  if (value === undefined) {
    return { raw: text };
  }

  const note = STATUS_NOTE.exec(value)?.groups?.note?.trim();
  if (note === undefined || note.length === 0) {
    return { freshness: "fresh", ready: true };
  }
  // Upstream notes: "needs update", "failed files", "indexing disabled",
  // "index not created", "index not configured", "status unknown",
  // "rebuild required". Forwarded verbatim so the agent can tell a missing
  // index from a stale or failed one.
  return { freshness: note, ready: false };
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
