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
export const buildQueryArgs = (i: QueryInput): string[] => {
  const args = ["query"];
  if (i.mode === "fts") {
    args.push("--fts", i.query);
  } else if (i.mode === "vector") {
    args.push("--vector", i.query);
  } else if (i.mode === "rg") {
    args.push("--rg", i.query);
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
