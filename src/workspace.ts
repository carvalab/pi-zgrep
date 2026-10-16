// Which workspace index a query from `cwd` should use, and which root a build
// should target. Pure apart from the injectable `exists` probe.
//
// Upstream resolves the index by walking from cwd up to the filesystem root
// and taking the first `.zvec-grep/` it finds (engine/service/root.js,
// findNearestWorkspaceLocation). It does not stop at a repository boundary,
// and its builds skip nested git repositories. So one index left in a parent
// folder (say ~/Dev) captures every repo below it: `zg status` reports ready,
// and queries return the parent's files. A plain `zg index` from the child
// refreshes the parent too. Captured against zg 0.2.2.
//
// The plan treats a `.git` (directory, or file for worktrees/submodules)
// between cwd and the ancestor index as a boundary: that repo needs its own
// index, built with an explicit root. Without a boundary — a subfolder of an
// indexed monorepo — the ancestor index is the right one, exactly as upstream
// resolves it.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const ZVEC_GREP_DIR = ".zvec-grep";

export interface WorkspacePlan {
  // Root a build should target, passed to `zg index <root>` explicitly so
  // upstream cannot redirect it to an ancestor.
  buildRoot: string;
  // Root of the nearest existing index, or null when none exists.
  indexRoot: string | null;
  // False when the nearest index belongs to a parent folder across a repo
  // boundary: its "ready" status says nothing about this repo.
  trustStatus: boolean;
}

export interface PlanOpts {
  exists?: (p: string) => boolean;
}

const hasIndex = (dir: string, exists: (p: string) => boolean): boolean =>
  exists(path.join(dir, ZVEC_GREP_DIR, "manifest.json"));

const hasGit = (dir: string, exists: (p: string) => boolean): boolean =>
  exists(path.join(dir, ".git"));

export const planWorkspace = (cwd: string, o: PlanOpts = {}): WorkspacePlan => {
  const exists = o.exists ?? existsSync;
  const start = path.resolve(cwd);
  // Closest repository root at or above cwd, below the index found so far.
  let gitRoot: string | null = null;
  let current = start;
  while (true) {
    if (hasIndex(current, exists)) {
      if (current === start || gitRoot === null) {
        return { buildRoot: current, indexRoot: current, trustStatus: true };
      }
      return { buildRoot: gitRoot, indexRoot: current, trustStatus: false };
    }
    if (gitRoot === null && hasGit(current, exists)) {
      gitRoot = current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { buildRoot: start, indexRoot: null, trustStatus: true };
    }
    current = parent;
  }
};

// Auto-builds never index a home directory or a filesystem root: that walks
// everything the user owns, and the index then captures every folder below
// it. An explicit /zg-index still can.
export const isUnsafeAutoIndexRoot = (
  root: string,
  home: string = homedir()
): boolean => {
  const resolved = path.resolve(root);
  return (
    resolved === path.parse(resolved).root ||
    (home.length > 0 && resolved === path.resolve(home))
  );
};
