// Ancestor-index guard. Upstream resolves the index by walking up to the
// nearest `.zvec-grep/` with no repository boundary, so a stray index in a
// parent folder (seen live: ~/Dev/.zvec-grep) captured every repo below it.
// These pin the plan that decides when that parent index is not ours.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { isUnsafeAutoIndexRoot, planWorkspace } from "../src/workspace.ts";

// Fake filesystem: a set of existing paths.
const fs = (...paths: string[]): ((p: string) => boolean) => {
  const set = new Set(paths.map((p) => path.resolve(p)));
  return (p: string): boolean => set.has(path.resolve(p));
};
const idx = (dir: string): string =>
  path.join(dir, ".zvec-grep", "manifest.json");
const git = (dir: string): string => path.join(dir, ".git");

const parent = path.resolve("/work/dev");
const child = path.join(parent, "repo");

test("own index at cwd: trusted, build targets cwd", () => {
  assert.deepEqual(
    planWorkspace(child, { exists: fs(idx(child), git(child)) }),
    {
      buildRoot: child,
      indexRoot: child,
      trustStatus: true,
    }
  );
});

test("subfolder of an indexed project (no repo boundary) inherits it", () => {
  const sub = path.join(parent, "src", "deep");
  assert.deepEqual(planWorkspace(sub, { exists: fs(idx(parent)) }), {
    buildRoot: parent,
    indexRoot: parent,
    trustStatus: true,
  });
});

test("repo inside an indexed parent folder needs its own index", () => {
  assert.deepEqual(
    planWorkspace(child, { exists: fs(idx(parent), git(child)) }),
    {
      buildRoot: child,
      indexRoot: parent,
      trustStatus: false,
    }
  );
});

test("from a subfolder of that repo, the build targets the repo root", () => {
  const sub = path.join(child, "src");
  assert.deepEqual(
    planWorkspace(sub, { exists: fs(idx(parent), git(child)) }),
    {
      buildRoot: child,
      indexRoot: parent,
      trustStatus: false,
    }
  );
});

test("the indexed folder's own .git is not a boundary", () => {
  const sub = path.join(parent, "src");
  assert.deepEqual(
    planWorkspace(sub, { exists: fs(idx(parent), git(parent)) }),
    { buildRoot: parent, indexRoot: parent, trustStatus: true }
  );
});

test("no index anywhere: build targets cwd, as upstream would", () => {
  assert.deepEqual(planWorkspace(child, { exists: fs(git(child)) }), {
    buildRoot: child,
    indexRoot: null,
    trustStatus: true,
  });
});

test("nearest index wins over a farther one", () => {
  const exists = fs(idx(parent), idx(child), git(child));
  assert.equal(
    planWorkspace(path.join(child, "a"), { exists }).indexRoot,
    child
  );
});

test("real filesystem: nested git repo under an indexed parent", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-zg-ws-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  mkdirSync(path.join(root, ".zvec-grep"));
  writeFileSync(path.join(root, ".zvec-grep", "manifest.json"), "{}");
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const plan = planWorkspace(repo);
  assert.equal(plan.trustStatus, false);
  assert.equal(plan.buildRoot, repo);
  // A git worktree/submodule has a `.git` file, which also counts.
  const wt = path.join(root, "worktree");
  mkdirSync(wt);
  writeFileSync(path.join(wt, ".git"), "gitdir: elsewhere\n");
  assert.equal(planWorkspace(wt).buildRoot, wt);
});

test("auto-index refuses home and filesystem root, allows projects", () => {
  const home = path.resolve("/home/me");
  assert.equal(isUnsafeAutoIndexRoot(home, home), true);
  assert.equal(isUnsafeAutoIndexRoot(`${home}/`, home), true);
  assert.equal(isUnsafeAutoIndexRoot(path.parse(home).root, home), true);
  assert.equal(isUnsafeAutoIndexRoot(path.join(home, "Dev"), home), false);
  assert.equal(
    isUnsafeAutoIndexRoot(path.join(home, "Dev", "app"), home),
    false
  );
});
