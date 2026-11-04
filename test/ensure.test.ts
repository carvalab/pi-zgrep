import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createZg } from "../src/zg.ts";
import type { Runner } from "../src/zg.ts";
// getOrCreateZg + resetZgCache exported from src/index.ts. F2: parallel
// tool calls on the same root must share one ensure-chain instance
// (installP / buildP / failedRoots), so makeRunner+createZg per
// execute doesn't break the memoized-error / lock guarantees.

const fakeRunner = (
  over: Partial<Runner> = {}
): Runner & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    // Default: probeStatus returns ready without recording into `calls` so
    // the "ready index" test sees zero calls when no override is supplied.
    calls,
    install: (): Promise<void> => {
      calls.push(["<install>"]);
      return Promise.resolve();
    },
    probe: (): Promise<string | null> => Promise.resolve("/usr/bin/zg"),
    probeStatus: () => Promise.resolve({ code: 0, stderr: "", stdout: "" }),
    run: (
      args: string[]
    ): Promise<{ code: number; stderr: string; stdout: string }> => {
      calls.push(args);
      return Promise.resolve({ code: 0, stderr: "", stdout: "" });
    },
    startServer: (): Promise<void> => {
      calls.push(["--server", "on"]);
      return Promise.resolve();
    },
    stream: (
      args: string[],
      _o?: { onUpdate?: (s: string) => void }
    ): Promise<{ code: number }> => {
      calls.push(args);
      return Promise.resolve({ code: 0 });
    },
    ...over,
  };
};

test("ready index: no index command runs", async () => {
  const r = fakeRunner();
  const zg = createZg(r, { root: "/x" });
  await zg.ensureIndex();
  assert.deepEqual(r.calls, []);
});

test("cold index builds once under parallel calls, then starts daemon once", async () => {
  const r = fakeRunner({
    probeStatus: () =>
      Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
  });
  const zg = createZg(r, { root: "/x" });
  await Promise.all([zg.ensureIndex(), zg.ensureIndex(), zg.ensureIndex()]);
  const builds = r.calls.filter((c) => c[0] === "--index");
  const servers = r.calls.filter((c) => c[0] === "--server");
  assert.equal(
    builds.length,
    1,
    "parallel cold-start calls must share one build"
  );
  assert.equal(servers.length, 1, "daemon started once after first build");
});

test("rider during in-flight build gets {} on success (no spurious memo)", async () => {
  const r = fakeRunner({
    probeStatus: () =>
      Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
  });
  const zg = createZg(r, { root: "/x" });
  const [r1, r2] = await Promise.all([zg.ensureIndex(), zg.ensureIndex()]);
  // Bug guard: a rider must not see "previous build attempt failed" before
  // the build has actually settled. Both calls resolve to {} on success.
  assert.deepEqual(r1, {});
  assert.deepEqual(r2, {});
  assert.equal(
    r.calls.filter((c) => c[0] === "--index").length,
    1,
    "shared build still runs exactly once"
  );
});

test("failed build memo: second ensure surfaces status text instead of rebuilding", async () => {
  let n = 0;
  const r = fakeRunner({
    probeStatus: () =>
      Promise.resolve({
        code: 1,
        stderr: "",
        stdout: "index error: model download failed",
      }),
    // Index build goes through `stream` (per spec: long-running commands use
    // stream with onUpdate + signal + cwd). Make it fail so the session-scoped
    // memo engages.
    stream: (args: string[]): Promise<{ code: number }> => {
      if (args[0] === "--index") {
        n += 1;
        return Promise.resolve({ code: 1 });
      }
      return Promise.resolve({ code: 0 });
    },
  });
  const zg = createZg(r, { root: "/x" });
  await zg.ensureIndex();
  const e2 = await zg.ensureIndex();
  assert.equal(n, 1, "must not rebuild after a failed attempt this session");
  assert.match(String(e2?.error ?? ""), /model download failed/u);
});

test("install lock: parallel resolves install once", async () => {
  let installs = 0;
  const r = fakeRunner({
    // First probe: zg not found. After install succeeds, zg is on PATH —
    // realistic behavior so the impl's post-install re-probe finds the binary.
    install: (): Promise<void> => {
      installs += 1;
      return Promise.resolve();
    },
    probe: (): Promise<string | null> =>
      Promise.resolve(installs > 0 ? "/usr/bin/zg" : null),
  });
  const zg = createZg(r, { root: "/x" });
  await Promise.all([zg.ensureBinary(), zg.ensureBinary()]);
  assert.equal(installs, 1);
});

test("PI_ZG_BIN set but probe fails -> error naming the var, no install", async () => {
  const r = fakeRunner({
    install: (): never => {
      throw new Error("should not install");
    },
    probe: (): Promise<string | null> => Promise.resolve(null),
  });
  const zg = createZg(r, { env: { PI_ZG_BIN: "/nope/zg" }, root: "/x" });
  await assert.rejects(zg.ensureBinary(), /PI_ZG_BIN/u);
});

test("failed probe surfaces the runner's diagnosis (which binary, which version)", async () => {
  // The version gate lives in the runner's probe: an old zg on PATH or in
  // PI_ZG_BIN is skipped there, and probeIssue() names it. ensureBinary has to
  // carry that detail into the error, otherwise the user only sees "not
  // installed" while a working 0.2.x binary sits on their PATH.
  const r = fakeRunner({
    install: (): never => {
      throw new Error("should not install");
    },
    probe: (): Promise<string | null> => Promise.resolve(null),
    probeIssue: (): string =>
      "/usr/bin/zg (0.2.1 — zg 0.3.0 or newer is required)",
  });
  const zg = createZg(r, { env: { PI_ZG_AUTO_INSTALL: "1" }, root: "/x" });
  await assert.rejects(zg.ensureBinary(), (error: Error) => {
    assert.match(error.message, /0\.2\.1/u);
    assert.match(error.message, /\/usr\/bin\/zg/u);
    return true;
  });
});

test("ensureBinary does not re-spawn --version after a successful probe", async () => {
  // probe() already paid for `zg --version`; the ensure chain must not repeat
  // it (and must not run a 0.3.0 `--version` against anything else).
  const r = fakeRunner({
    // Simulates the makeRunner closure cache populated by probe's stdout drain.
    version: (): string => "0.3.0",
  });
  // Void: the resolved path lives in the runner (probedBin/version()), so no
  // caller reads a return value any more.
  assert.equal(await createZg(r, { root: "/x" }).ensureBinary(), undefined);
  assert.equal(
    r.calls.filter((c) => c[0] === "--version").length,
    0,
    `expected no --version spawn; got calls=${JSON.stringify(r.calls)}`
  );
});

test("failed build surfaces last progress lines from onUpdate tail", async () => {
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
    // Failing build: drives onUpdate so the tail buffer captures the lines
    // zg would have printed, then exits non-zero so runBuild throws.
    stream: (
      args: string[],
      o?: { onUpdate?: (s: string) => void }
    ): Promise<{ code: number }> => {
      if (args[0] === "--index") {
        o?.onUpdate?.("progress line 1");
        o?.onUpdate?.("progress line 2");
        o?.onUpdate?.("model download failed: network unreachable");
        return Promise.resolve({ code: 1 });
      }
      return Promise.resolve({ code: 0 });
    },
  });
  const zg = createZg(r, { onUpdate: (): void => {}, root: "/x" });
  const e = await zg.ensureIndex();
  assert.match(String(e?.error ?? ""), /model download failed/u);
});

test("PI_ZG_AUTO_INSTALL=1 skips install and surfaces manual command", async () => {
  let installs = 0;
  const r = fakeRunner({
    install: (): Promise<void> => {
      installs += 1;
      return Promise.resolve();
    },
    probe: (): Promise<string | null> => Promise.resolve(null),
  });
  const zg = createZg(r, {
    env: { PI_ZG_AUTO_INSTALL: "1" },
    root: "/x",
  });
  await assert.rejects(zg.ensureBinary(), /npm install -g @zvec\/zvec-grep/u);
  assert.equal(
    installs,
    0,
    "install must not be called when AUTO_INSTALL is set"
  );
});

test("install runs but zg still missing afterwards => still not on PATH error", async () => {
  const r = fakeRunner({
    install: (): Promise<void> => Promise.resolve(),
    probe: (): Promise<string | null> => Promise.resolve(null),
  });
  const zg = createZg(r, { root: "/x" });
  await assert.rejects(zg.ensureBinary(), /still not on PATH/u);
});

test("riders joining a failing build both get {error} and exactly one build runs", async () => {
  let builds = 0;
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
    stream: (args: string[]): Promise<{ code: number }> => {
      if (args[0] === "--index") {
        builds += 1;
        return Promise.resolve({ code: 1 });
      }
      return Promise.resolve({ code: 0 });
    },
  });
  const zg = createZg(r, { root: "/x" });
  const [r1, r2] = await Promise.all([zg.ensureIndex(), zg.ensureIndex()]);
  assert.equal(builds, 1, "exactly one build despite parallel calls");
  assert.ok(r1.error, "rider 1 sees the error");
  assert.ok(r2.error, "rider 2 sees the error");
});

// F2: getOrCreateZg caches one ensure-chain per cwd so parallel tool
// calls on the same root share install/build locks and the
// failedRoots memo. Without the cache, each tool execute creates its
// own createZg instance and the session-scoped promises reset every
// call → install fires per call, build races per call, and the
// README's "memoized error" claim is false.
test("getOrCreateZg returns the same ensure chain for the same cwd", async () => {
  const { getOrCreateZg, resetZgCache } = await import("../src/index.ts");
  resetZgCache();
  let probeCalls = 0;
  let installCalls = 0;
  const runner: Runner = {
    install: (): Promise<void> => {
      installCalls += 1;
      return Promise.resolve();
    },
    // First probe returns null (binary missing); once install has
    // been called the probe finds the binary on PATH. Same shape as
    // the install-lock test in this file.
    probe: (): Promise<string | null> => {
      probeCalls += 1;
      return Promise.resolve(installCalls > 0 ? "/usr/bin/zg" : null);
    },
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
    run: (): Promise<{ code: number; stderr: string; stdout: string }> =>
      Promise.resolve({ code: 0, stderr: "", stdout: "" }),
    startServer: (): Promise<void> => Promise.resolve(),
    stream: (): Promise<{ code: number }> => Promise.resolve({ code: 0 }),
  };
  const a = getOrCreateZg({
    cwd: "/repo-x",
    env: {},
    makeRunner: () => runner,
  });
  const b = getOrCreateZg({
    cwd: "/repo-x",
    env: {},
    makeRunner: () => runner,
  });
  assert.equal(a, b, "same cwd must return the same cached chain");
  // Two calls into ensureBinary must yield one install even when the
  // cache returns the same chain twice (this exercises installP).
  await Promise.all([a.zg.ensureBinary(), b.zg.ensureBinary()]);
  assert.equal(installCalls, 1, "install shared across cached callers");
  // probe still gets called per-ensureBinary because makeRunner is
  // wrapped at the factory layer — that's fine, the cache's purpose
  // is to share the install promise, not the probe. Reset the cache
  // so subsequent tests start clean.
  resetZgCache();
  assert.ok(probeCalls >= 2, "probe runs each call (cheap, no caching needed)");
});

// A bare workspace answers `--status --check-ready` with exit 1 and
// `  Coverage    Unavailable (index not configured)` (zsrc crates/zg/tests/
// implicit_index.rs:290). That build has to name an embedding model: a bare
// `--index` leaves nothing to resolve and the next non-interactive query is
// refused with [ZG.ENGINE.NOT_FOUND] (crates/zg/src/main.rs:620-625) instead of
// returning hits.
const notReadyStatus =
  (note: string) =>
  (): Promise<{ code: number; stderr: string; stdout: string }> =>
    Promise.resolve({
      code: 1,
      stderr: "Error: workspace index is not ready\n",
      stdout: `  Coverage    Unavailable (${note})\n`,
    });

test("first index names the default model; PI_ZG_EMBEDDING overrides it", async () => {
  // 0.3.0 argv: `--index [root] --embedding <model>` — the root is always
  // explicit so a build can never be redirected to an ancestor's workspace.
  const first = fakeRunner({
    probeStatus: notReadyStatus("index not configured"),
  });
  await createZg(first, { env: {}, root: "/x" }).ensureIndex();
  assert.deepEqual(
    first.calls.filter((c) => c[0] === "--index"),
    [["--index", "--embedding", "local/potion-code-16m-v2", "/x"]]
  );

  const viaEnv = fakeRunner({
    probeStatus: notReadyStatus("index not created"),
  });
  await createZg(viaEnv, {
    env: { PI_ZG_EMBEDDING: "local/pi-choice" },
    root: "/x",
  }).ensureIndex();
  assert.deepEqual(
    viaEnv.calls.filter((c) => c[0] === "--index"),
    [["--index", "--embedding", "local/pi-choice", "/x"]]
  );
});

test("stale and rebuild-required indexes refresh without --embedding", async () => {
  const cases: [string, string[]][] = [
    ["needs update", ["--index", "/x"]],
    ["rebuild required", ["--index", "/x", "--rebuild"]],
  ];
  const runners = cases.map(([note]) =>
    fakeRunner({ probeStatus: notReadyStatus(note) })
  );
  await Promise.all(
    runners.map((r) => createZg(r, { env: {}, root: "/x" }).ensureIndex())
  );
  for (const [i, [note, expected]] of cases.entries()) {
    assert.deepEqual(
      runners[i].calls.filter((c) => c[0] === "--index"),
      [expected],
      note
    );
  }
});

test("getOrCreateZg returns distinct chains for distinct cwds", async () => {
  const { getOrCreateZg, resetZgCache } = await import("../src/index.ts");
  resetZgCache();
  const a = getOrCreateZg({
    cwd: "/repo-a",
    env: {},
    makeRunner: () => fakeRunner(),
  });
  const b = getOrCreateZg({
    cwd: "/repo-b",
    env: {},
    makeRunner: () => fakeRunner(),
  });
  assert.notEqual(a, b, "different cwds get different chains");
  resetZgCache();
});

// Ancestor-index guard (see src/workspace.ts and test/workspace.test.ts).
const parentDir = path.resolve("/work/dev");
const repoDir = path.join(parentDir, "repo");
const existsIn =
  (...paths: string[]) =>
  (p: string): boolean =>
    paths.map((x) => path.resolve(x)).includes(path.resolve(p));

test("ready status from a parent folder's index across a repo boundary still builds this repo", async () => {
  const r = fakeRunner();
  const zg = createZg(r, {
    exists: existsIn(
      path.join(parentDir, ".zvec-grep", "manifest.json"),
      path.join(repoDir, ".git")
    ),
    root: repoDir,
  });
  const res = await zg.ensureIndex();
  assert.deepEqual(res, {});
  assert.deepEqual(
    r.calls.filter((c) => c[0] === "--index"),
    [["--index", repoDir, "--mode", "direct"]],
    "build must name the repo root explicitly (zg resolves a child query to the parent index)"
  );
});

test("ready status with no repo boundary trusts the parent index (monorepo subfolder)", async () => {
  const r = fakeRunner();
  const zg = createZg(r, {
    exists: existsIn(path.join(parentDir, ".zvec-grep", "manifest.json")),
    root: path.join(parentDir, "packages", "a"),
  });
  await zg.ensureIndex();
  assert.deepEqual(r.calls, []);
});

test("cold build always passes an explicit root", async () => {
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
  });
  const zg = createZg(r, { exists: () => false, root: repoDir });
  await zg.ensureIndex();
  assert.deepEqual(
    r.calls.filter((c) => c[0] === "--index"),
    [["--index", repoDir]]
  );
});

test("never auto-builds an index in the home directory", async () => {
  const home = path.resolve("/home/me");
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
  });
  const zg = createZg(r, { exists: () => false, home, root: home });
  const res = await zg.ensureIndex();
  assert.match(res.error ?? "", /not auto-indexing .*home directory/u);
  assert.match(res.error ?? "", /mode=rg/u);
  assert.deepEqual(r.calls, [], "no build and no daemon start");
});

test("a ready index in the home directory is still used", async () => {
  const home = path.resolve("/home/me");
  const r = fakeRunner();
  const zg = createZg(r, { exists: () => false, home, root: home });
  assert.deepEqual(await zg.ensureIndex(), {});
});
