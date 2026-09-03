import assert from "node:assert/strict";
import { test } from "node:test";

import { createZg } from "../src/zg.ts";
import type { Runner } from "../src/zg.ts";

const fakeRunner = (
  over: Partial<Runner> = {}
): Runner & { calls: string[][] } => {
  const calls: string[][] = [];
  return {
    // Default: probeStatus returns ready without recording into `calls` so
    // the "ready index" test sees zero calls when no override is supplied.
    calls,
    install: (): void => {
      calls.push(["<install>"]);
    },
    probe: (): string | null => "/usr/bin/zg",
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 0, stderr: "", stdout: "" }),
    run: (
      args: string[]
    ): Promise<{ code: number; stderr: string; stdout: string }> => {
      calls.push(args);
      return Promise.resolve({ code: 0, stderr: "", stdout: "" });
    },
    startServer: (): void => {
      calls.push(["server", "on"]);
    },
    stream: (
      args: string[],
      _o?: { onUpdate?: (s: string) => void }
    ): Promise<{ code: number }> => {
      calls.push(args);
      return Promise.resolve({ code: 0 });
    },
    ...over,
  } as Runner & { calls: string[][] };
};

test("ready index: no index command runs", async () => {
  const r = fakeRunner();
  const zg = createZg(r, { root: "/x" });
  await zg.ensureIndex();
  assert.deepEqual(r.calls, []);
});

test("cold index builds once under parallel calls, then starts daemon once", async () => {
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
  });
  const zg = createZg(r, { root: "/x" });
  await Promise.all([zg.ensureIndex(), zg.ensureIndex(), zg.ensureIndex()]);
  const builds = r.calls.filter((c) => c[0] === "index");
  const servers = r.calls.filter((c) => c[0] === "server");
  assert.equal(
    builds.length,
    1,
    "parallel cold-start calls must share one build"
  );
  assert.equal(servers.length, 1, "daemon started once after first build");
});

test("rider during in-flight build gets {} on success (no spurious memo)", async () => {
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> => Promise.resolve({ code: 1, stderr: "", stdout: "not ready" }),
  });
  const zg = createZg(r, { root: "/x" });
  const [r1, r2] = await Promise.all([zg.ensureIndex(), zg.ensureIndex()]);
  // Bug guard: a rider must not see "previous build attempt failed" before
  // the build has actually settled. Both calls resolve to {} on success.
  assert.deepEqual(r1, {});
  assert.deepEqual(r2, {});
  assert.equal(
    r.calls.filter((c) => c[0] === "index").length,
    1,
    "shared build still runs exactly once"
  );
});

test("failed build memo: second ensure surfaces status text instead of rebuilding", async () => {
  let n = 0;
  const r = fakeRunner({
    probeStatus: (): Promise<{
      code: number;
      stderr: string;
      stdout: string;
    }> =>
      Promise.resolve({
        code: 1,
        stderr: "",
        stdout: "index error: model download failed",
      }),
    // Index build goes through `stream` (per spec: long-running commands use
    // stream with onUpdate + signal + cwd). Make it fail so the session-scoped
    // memo engages.
    stream: (args: string[]): Promise<{ code: number }> => {
      if (args[0] === "index") {
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

test("ensureBinary returns warning for zg <0.2 and none for >=0.2", async () => {
  const oldR = fakeRunner({
    run: (
      args: string[]
    ): Promise<{ code: number; stderr: string; stdout: string }> => {
      if (args[0] === "--version") {
        return Promise.resolve({ code: 0, stderr: "", stdout: "zg 0.1.9\n" });
      }
      return Promise.resolve({ code: 0, stderr: "", stdout: "" });
    },
  });
  const oldRes = await createZg(oldR, { root: "/x" }).ensureBinary();
  assert.equal(oldRes.bin, "/usr/bin/zg");
  assert.match(String(oldRes.warning ?? ""), /0\.1\.9/u);

  const newR = fakeRunner({
    run: (
      args: string[]
    ): Promise<{ code: number; stderr: string; stdout: string }> => {
      if (args[0] === "--version") {
        return Promise.resolve({ code: 0, stderr: "", stdout: "zg 0.2.1\n" });
      }
      return Promise.resolve({ code: 0, stderr: "", stdout: "" });
    },
  });
  const newRes = await createZg(newR, { root: "/x" }).ensureBinary();
  assert.equal(newRes.bin, "/usr/bin/zg");
  assert.equal(newRes.warning, undefined);
});

test("version-check rejects: ensureBinary resolves with { bin, warning: undefined }", async () => {
  // Contract pin: a Runner whose `run` rejects (timeout, spawn ENOENT,
  // parse miss) must still let ensureBinary resolve with the probed bin.
  // probeAndVersion wraps runner.run(["--version"]) in try/catch and returns
  // { bin } on failure — the version probe is warn-only and must never
  // block use of the binary. (src/zg.ts: probeAndVersion)
  const r = fakeRunner({
    run: (): Promise<{ code: number; stderr: string; stdout: string }> =>
      Promise.reject(new Error("timeout")),
  });
  const res = await createZg(r, { root: "/x" }).ensureBinary();
  assert.equal(res.bin, "/usr/bin/zg");
  assert.equal(res.warning, undefined);
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
      if (args[0] === "index") {
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
      if (args[0] === "index") {
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
