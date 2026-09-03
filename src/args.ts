import { existsSync } from "node:fs";

export type QueryMode = "hybrid" | "fts" | "vector" | "rg";
export interface QueryInput {
  query: string;
  mode: QueryMode;
  limit: number;
  preview: "short" | "none";
  refresh?: "auto" | "wait";
  glob?: string;
  type?: string;
}

// F3: input guard. Three classes of input that look like searches but
// would either be silently misinterpreted by upstream or trigger an
// unhelpful "missing: <flag>" parse error:
//   (a) empty query — every route rejects it; reject up-front with a
//       message the agent can read.
//   (b) hybrid positional route with a leading-dash query — the query
//       token would be parsed as a flag (upstream has no separator on
//       this route). The rg route handles this case via `-e` in
//       buildQueryArgs, so we only reject hybrid/fts/vector here.
//   (c) glob/type starting with "-" — would be sent as `-g -x` /
//       `-t -x`. upstream treats this as a glob value "-x" with no
//       error; the agent almost certainly meant an exclusion
//       (`!node_modules`) so force them to be explicit.
export const validateQueryInput = (i: QueryInput): void => {
  if (i.query.length === 0) {
    throw new Error("query must not be empty");
  }
  if (i.mode !== "rg" && i.query.startsWith("-")) {
    throw new Error(
      `hybrid/fts/vector routes have no flag separator for the query position; leading "-" queries must use mode=rg (which emits -e). Got query=${JSON.stringify(i.query)}`
    );
  }
  if (i.glob !== undefined && i.glob.startsWith("-")) {
    throw new Error(
      `glob must not start with "-"; use !<pattern> to exclude. Got glob=${JSON.stringify(i.glob)}`
    );
  }
  if (i.type !== undefined && i.type.startsWith("-")) {
    throw new Error(
      `type must not start with "-". Got type=${JSON.stringify(i.type)}`
    );
  }
};

export const buildQueryArgs = (i: QueryInput): string[] => {
  const args = ["query"];
  if (i.mode === "fts") {
    args.push("--fts", i.query);
  } else if (i.mode === "vector") {
    args.push("--vector", i.query);
  } else if (i.mode === "rg") {
    // F3 (a): a query that begins with "-" would be parsed as a flag
    // by upstream unless prefixed with `-e`. help-query.txt spells
    // this out: "Use -e when a pattern begins with '-'". Verified
    // against real `zg` 0.2.1: `zg query --rg -e "-x" --limit 1`
    // matches; the bare `zg query --rg "-x" --limit 1` form fails
    // with "missing: --limit, 1".
    if (i.query.startsWith("-")) {
      args.push("--rg", "-e", i.query);
    } else {
      args.push("--rg", i.query);
    }
  } else {
    args.push(i.query);
  }
  // rg route: real `zg` v0.2.1 rejects --preview, --mode, and
  // --refresh alongside --rg ("--preview is not supported with --rg;
  // use -A/-B/-C for rg context"; same upstream error shape for
  // --mode/--refresh). Omit them for rg; keep --limit and the optional
  // filters.
  if (i.mode === "rg") {
    args.push("--limit", String(i.limit));
  } else {
    args.push(
      "--limit",
      String(i.limit),
      "--preview",
      i.preview,
      "--mode",
      "auto"
    );
    if (i.refresh === "wait") {
      args.push("--refresh", "wait");
    }
  }
  if (i.glob) {
    args.push("-g", i.glob);
  }
  if (i.type) {
    args.push("-t", i.type);
  }
  return args;
};
export const buildIndexArgs = (extra: string[] = []): string[] => [
  "index",
  ...extra,
];
export const buildStatusArgs = (): string[] => ["status", "--check-ready"];

export type IndexCommandArgs = { args: string[]; ok: true } | { ok: false };

// /zg-index argument guard. Flags pass through untouched (thin integrator —
// upstream can add flags without changes here). A bare word is forwarded only
// when it exists on disk (upstream's optional positional [root]); anything
// else is a typo like "status" that upstream kills with [ROOT_NOT_FOUND] —
// reject it with a usage hint instead of a doomed spawn. `exists` is
// injectable for tests.
export const parseIndexCommandArgs = (
  raw?: string,
  exists: (p: string) => boolean = existsSync
): IndexCommandArgs => {
  const args = raw ? raw.split(/\s+/u).filter((s) => s.length > 0) : [];
  const bare = args.filter((s) => !s.startsWith("-"));
  if (bare.some((s) => !exists(s))) {
    return { ok: false };
  }
  return { args, ok: true };
};
