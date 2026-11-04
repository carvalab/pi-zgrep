import { existsSync } from "node:fs";

// Shared env-flag test: every PI_ZG_* switch is on for *any* non-empty value
// (README § Configuration), so a blank string counts as unset.
export const nonEmpty = (v?: string): boolean =>
  typeof v === "string" && v.length > 0;

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

// zg 0.3.0 replaced subcommands with rg-style flags: every management
// operation is a --flag (--index/--status/--server) and every search route is
// an explicit query group (--hybrid/--fts/--vector), because a bare positional
// word is now literal search text. Anything that still emitted `zg query …`,
// `zg index …`, or `zg status …` would be searched for, not executed.

// Input guard. Two classes of input that look like searches but would be
// silently misinterpreted by upstream:
//   (a) empty query — every route rejects it; reject up-front with a
//       message the agent can read.
//   (b) glob/type starting with "-" — would be sent as `-g -x` / `-t -x`.
//       zg takes "-x" as a glob value with no error (the agent almost
//       certainly meant an exclusion: `!node_modules`), and rejects an
//       unknown type with "unknown indexed file format: -x". Force them to
//       be explicit instead.
// A leading "-" query is NOT rejected: buildQueryArgs attaches it to the
// explicit route flag (`--hybrid=-x`), which is the only form clap cannot
// mistake for an option, and the rg route uses `-e`.
export const validateQueryInput = (i: QueryInput): void => {
  if (i.query.length === 0) {
    throw new Error("query must not be empty");
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

const routeFlag = (mode: Exclude<QueryMode, "rg">): string => {
  if (mode === "fts") {
    return "--fts";
  }
  if (mode === "vector") {
    return "--vector";
  }
  return "--hybrid";
};

export const buildQueryArgs = (i: QueryInput): string[] => {
  const args: string[] = [];
  if (i.mode === "rg") {
    // Managed ripgrep. 0.3.0 rejects the indexed options alongside --rg
    // ("--rg cannot be combined with indexed preview, trace, refresh, or
    // symbol options"), so only the pattern, --limit, and the file filters
    // go out. `--rg` already prints `<path>` then two-space indented
    // `  <line>: <text>` matches, so line numbers come for free.
    args.push("--rg");
    // A pattern that begins with "-" is parsed as an option unless it
    // follows `-e`. Verified against the 0.3.0 binary: `zg --rg -e "-x"`
    // searches literally; the bare `zg --rg "-x"` form does not.
    if (i.query.startsWith("-")) {
      args.push("-e", i.query);
    } else {
      args.push(i.query);
    }
    args.push("--color", "never", "--limit", String(i.limit));
  } else {
    // Explicit route flag rather than a positional query: 0.3.0 treats a
    // path-shaped positional word as a file-name lookup (and warns on
    // stderr), which would turn a legit query like "auth.ts" into a path
    // probe. --color never keeps the pipe plain so the parser cannot trip
    // over ANSI escapes.
    // A query that begins with "-" rides *attached* to the route flag
    // (`--hybrid=-v`): in the separated form clap reads it as an option, so a
    // query that happens to name one of zg's own flags ("--trace",
    // "--refresh", "-L") dies with `a value is required for '--hybrid
    // <QUERY>'`, and a harmless "-x" survives only by luck
    // (crates/zg-cli/src/lib.rs:536 allows hyphen values on the positional,
    // which does not cover the route option). Verified against the 0.3.0
    // binary: `--hybrid=-v`, `--hybrid=--trace`, `--fts=--trace` and
    // `--vector=-v` all return normal results; the separated forms of
    // `--trace`/`--refresh`/`-L` fail with exit 2.
    const flag = routeFlag(i.mode);
    if (i.query.startsWith("-")) {
      args.push(`${flag}=${i.query}`);
    } else {
      args.push(flag, i.query);
    }
    args.push(
      "--limit",
      String(i.limit),
      "--preview",
      i.preview,
      "--color",
      "never",
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
// A workspace's FIRST index needs its embedding model named up front. Upstream
// `zg --help index` documents the order as `--embedding` > ZVEC_GREP_EMBEDDING >
// Global config, "falling back to local/potion-code-16m-v2" (upstream
// zsrc/rust/crates/zg-cli/src/render.rs:566-567 and :934), and the engine
// implements the same chain with this constant as its last resort
// (zsrc/rust/crates/zg-engine/src/pipelines/indexing/service.rs:667-688
// resolving explicit > existing > env > global default > DEFAULT_LOCAL_EMBEDDING,
// declared at :56). Local and code-tuned, so a fresh non-interactive repo never
// reaches for a remote model (which would also need --allow-remote,
// zsrc/rust/crates/zg/src/main.rs:1052-1058).
export const DEFAULT_NEW_INDEX_EMBEDDING = "local/potion-code-16m-v2";

// Model for a first build: ZVEC_GREP_EMBEDDING is what upstream itself reads
// (crates/zg-engine/src/models/catalog/resolution.rs:32-46), so it wins over
// the extension-level PI_ZG_EMBEDDING; both are trimmed and blank counts as
// unset.
export const resolveNewIndexEmbedding = (
  env: Record<string, string | undefined> = process.env
): string => {
  for (const name of ["ZVEC_GREP_EMBEDDING", "PI_ZG_EMBEDDING"] as const) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }
  return DEFAULT_NEW_INDEX_EMBEDDING;
};

// `--status` notes that mean "there is no index yet" (crates/zg/tests/
// implicit_index.rs:290 pins "index not configured" for a fresh workspace;
// "index not created" is the sibling upstream note). Every other not-ready
// note — "needs update", "failed files", "rebuild required", "status
// unknown" — describes an index that already exists.
export const isNewIndexState = (freshness?: string): boolean =>
  freshness === "index not created" || freshness === "index not configured";

const namesEmbedding = (args: string[]): boolean =>
  args.some((a) => a === "--embedding" || a.startsWith("--embedding="));

export interface IndexBuildOptions {
  env?: Record<string, string | undefined>;
  // True only when zg reported no index at all. Refreshing an existing index
  // must not pass --embedding: a compatible index reuses its stored model
  // (crates/zg-cli/src/render.rs:575) and naming a different one fails the
  // refresh with "Rebuild the index with `zg --index --rebuild`"
  // (crates/zg-engine/src/pipelines/indexing/service.rs:131-141).
  newIndex?: boolean;
}

export const buildIndexArgs = (
  extra: string[] = [],
  o: IndexBuildOptions = {}
): string[] => {
  // Three cases where the model is never injected, even for a first build: the
  // caller already named one (a second --embedding is a hard clap error), the
  // build is a --rebuild of an index that has (or had) its own model — upstream
  // only *permits* --embedding there (crates/zg-cli/src/render.rs:576) — or it
  // is --drop, which rejects every index option outright
  // (crates/zg-cli/src/lib.rs:1535-1551).
  if (
    o.newIndex !== true ||
    namesEmbedding(extra) ||
    extra.includes("--rebuild") ||
    extra.includes("--drop")
  ) {
    return ["--index", ...extra];
  }
  return ["--index", "--embedding", resolveNewIndexEmbedding(o.env), ...extra];
};
export const buildStatusArgs = (): string[] => ["--status", "--check-ready"];

export type IndexCommandArgs = { args: string[]; ok: true } | { ok: false };

// Tokenize arguments without shell evaluation. Backslashes in Windows paths
// are literal; quoted spaces and escaped double quotes stay in one argument.
const splitCommandArgs = (raw: string): string[] | null => {
  const args: string[] = [];
  let token = "";
  let quote = "";
  let active = false;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "\\" && quote === '"' && raw[i + 1] === '"') {
      token += '"';
      i += 1;
    } else if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? "" : char;
      active = true;
    } else if (/\s/u.test(char) && !quote) {
      if (active) {
        args.push(token);
      }
      token = "";
      active = false;
    } else {
      token += char;
      active = true;
    }
  }
  if (quote) {
    return null;
  }
  if (active) {
    args.push(token);
  }
  return args;
};

// /zg-index argument guard. Flags pass through untouched (thin integrator —
// upstream can add flags without changes here). A bare word is forwarded only
// when it exists on disk (upstream's optional positional [root]); anything
// else is a typo like "status" that upstream kills with
// `Error[ZG.ENGINE.NOT_FOUND]: resolve directory …`; reject it with a usage
// hint instead of a doomed spawn. `exists` is injectable for tests.
export const parseIndexCommandArgs = (
  raw?: string,
  exists: (p: string) => boolean = existsSync
): IndexCommandArgs => {
  const args = splitCommandArgs(raw ?? "");
  if (!args) {
    return { ok: false };
  }
  // Only the leading positional argument is a root. Values after flags must
  // pass through, including future engine options we do not know about yet.
  if (args[0] && !args[0].startsWith("-") && !exists(args[0])) {
    return { ok: false };
  }
  return { args, ok: true };
};
