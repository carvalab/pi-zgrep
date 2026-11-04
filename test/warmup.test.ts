// Session-start warmup: spawn-backed, hermetic via a fake `zg` shell script.
// Pins the two branches that matter: (1) binary present → probe + status run
// and the footer status clears (no build on a ready index, no error notify),
// (2) binary missing → bail with zero spawns, no background install.

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { registerSessionWarmup, safeUi, sessionWarmup } from "../src/index.ts";

const makeFakeZg = (dir: string, log: string): string => {
  const p = path.join(dir, "zg");
  // Log every argv[0]; --version prints a version so probe caches it, the
  // `--status --check-ready` route falls through to exit 0 (index ready).
  // The version must be >= 0.3.0: the runner refuses anything older.
  writeFileSync(
    p,
    `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\ncase "$1" in\n  --version) echo "0.3.0" ;;\nesac\nexit 0\n`
  );
  chmodSync(p, 0o755);
  return p;
};

const makeUi = (): {
  calls: string[];
  ui: Parameters<typeof sessionWarmup>[0]["ui"];
} => {
  const calls: string[] = [];
  return {
    calls,
    ui: {
      notify: (message: string): void => {
        calls.push(`notify:${message}`);
      },
      setStatus: (_key: string, text: string | undefined): void => {
        calls.push(`status:${text ?? "cleared"}`);
      },
    },
  };
};

const withTempDir = async (
  fn: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-warmup-`);
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

// Both cases inject `() => null` as the bundled-engine resolver: warmup must
// never fall back to this repo's own node_modules, so no real `zg --index` can
// run against a scratch directory inside a unit test.
test("warmup with ready index: probes + status-checks, no build, clears status", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const { calls, ui } = makeUi();
    await sessionWarmup(
      { cwd: dir, ui },
      { PI_ZG_BIN: makeFakeZg(dir, log) },
      path.join(dir, "home"),
      () => null
    );
    // The daemon start is fire-and-forget, so its log line can land after
    // warmup resolves. The probe and status spawns are awaited.
    await delay(500);
    const argv0 = new Set(
      readFileSync(log, "utf-8").split("\n").filter(Boolean)
    );
    assert.ok(argv0.has("--version"), "probe must run zg --version");
    assert.ok(argv0.has("--status"), "ensureIndex must run zg --status");
    assert.ok(argv0.has("--server"), "warmup must attempt the daemon start");
    assert.ok(!argv0.has("--index"), "ready index must not trigger a build");
    assert.equal(calls.filter((c) => c.startsWith("notify:")).length, 0);
    assert.equal(calls.at(-1), "status:cleared");
  });
});

test("warmup with missing binary: bails with no spawns and no install", async () => {
  await withTempDir(async (dir) => {
    const { calls, ui } = makeUi();
    await sessionWarmup(
      { cwd: dir, ui },
      { PI_ZG_BIN: "/nonexistent/zg-binary-xyz" },
      path.join(dir, "home"),
      () => null
    );
    assert.deepEqual(calls, ["status:cleared"]);
  });
});

const staleError = (): Error =>
  new Error("This extension ctx is stale after session replacement or reload");

test("warmup does not throw when the ctx went stale mid-flight (print mode)", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    // Mirrors pi in `pi -p`: the session ends while the background build is
    // still running, so every ctx.ui touch throws from that point on. The
    // uncaught throw used to exit the process 1.
    let live = true;
    const ui = {
      notify: (): void => {
        if (!live) {
          throw staleError();
        }
      },
      setStatus: (): void => {
        if (!live) {
          throw staleError();
        }
      },
    };
    const warm = sessionWarmup(
      { cwd: dir, ui },
      { PI_ZG_BIN: makeFakeZg(dir, log) },
      path.join(dir, "home"),
      () => null
    );
    live = false;
    await assert.doesNotReject(warm);
  });
});

test("warmup still reports through a live ctx (guard does not swallow early)", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const { calls, ui } = makeUi();
    await sessionWarmup({ cwd: dir, ui }, { PI_ZG_BIN: makeFakeZg(dir, log) });
    assert.ok(
      calls.some((c) => c.startsWith("status:")),
      "status lines must still surface while the ctx is live"
    );
  });
});

test("safeUi passes through live calls and swallows stale ones", () => {
  const calls: string[] = [];
  let live = true;
  const wrapped = safeUi({
    ui: {
      notify: (message: string): void => {
        calls.push(`notify:${message}`);
        if (!live) {
          throw staleError();
        }
      },
      setStatus: (_key: string, text: string | undefined): void => {
        calls.push(`status:${text ?? "cleared"}`);
        if (!live) {
          throw staleError();
        }
      },
    },
  });
  wrapped.notify("before");
  wrapped.setStatus("pi-zg", "indexing…");
  live = false;
  assert.doesNotThrow(() => {
    wrapped.notify("after");
    wrapped.setStatus("pi-zg", undefined);
  });
  // The throw happened *after* the call was recorded by the fake, so the
  // wrapper really did attempt both.
  assert.deepEqual(calls, [
    "notify:before",
    "status:indexing…",
    "notify:after",
    "status:cleared",
  ]);
});

test("warmup in the home directory skips quietly: no index check, no error", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const { calls, ui } = makeUi();
    await sessionWarmup(
      { cwd: dir, ui },
      { PI_ZG_BIN: makeFakeZg(dir, log), PI_ZG_SERVER: "1" },
      dir
    );
    const argv0 = readFileSync(log, "utf-8").trim().split("\n");
    assert.deepEqual(argv0, ["--version"], "probe only");
    assert.ok(!calls.some((c) => c.startsWith("notify:")), calls.join("|"));
  });
});

// --- Warmup lifecycle (abort) ----------------------------------------------
//
// The warmup is fire-and-forget from session_start, so it outlives the session
// that started it: a reload or /new aborts the old ctx while the build is still
// streaming. Without an AbortSignal threaded through sessionWarmup →
// ensureIndex → runner.stream, the killed session keeps an index build alive
// (up to minutes on a cold repo) and keeps writing progress into a ctx it no
// longer owns. `safeUi` hides the throw, not the work.

// Build that streams progress for ~4 s, so an abort lands mid-build instead of
// after it. Same probe/status shape as makeFakeZg: cold root, exit 1.
const makeSlowFakeZg = (dir: string, log: string): string => {
  const p = path.join(dir, "zg");
  writeFileSync(
    p,
    [
      "#!/bin/sh",
      `echo "$1" >> ${JSON.stringify(log)}`,
      'case "$1" in',
      '  --version) echo "0.3.0" ;;',
      "  --status)",
      '    echo "  Coverage    Unavailable (index not configured)"',
      "    exit 1 ;;",
      "  --index)",
      "    i=0",
      '    while [ $i -lt 40 ]; do echo "Indexing: $i/40 files"; i=$((i+1)); sleep 0.1; done ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(p, 0o755);
  return p;
};

const callsLog = (log: string): string =>
  existsSync(log) ? readFileSync(log, "utf-8").trim() : "";

// A ctx that records every ui *attempt* and throws once the session is gone.
// The record comes first, so an attempt made after the session died stays
// visible: safeUi swallows the throw, but the call still happened.
const recordingUi = (): {
  calls: string[];
  expire: () => void;
  ui: {
    notify: (m: string) => void;
    setStatus: (k: string, t?: string) => void;
  };
} => {
  const calls: string[] = [];
  let live = true;
  return {
    calls,
    expire: (): void => {
      live = false;
    },
    ui: {
      notify: (message: string): void => {
        calls.push(`notify:${message}`);
        if (!live) {
          throw staleError();
        }
      },
      setStatus: (_key: string, text?: string): void => {
        calls.push(`status:${text ?? "cleared"}`);
        if (!live) {
          throw staleError();
        }
      },
    },
  };
};

test("an already-aborted signal: no spawn, no ui touch", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const { calls, ui } = makeUi();
    const ctrl = new AbortController();
    ctrl.abort();
    await sessionWarmup(
      { cwd: dir, ui },
      { PI_ZG_BIN: makeSlowFakeZg(dir, log) },
      path.join(dir, "home"),
      () => null,
      ctrl.signal
    );
    await delay(250);
    assert.equal(callsLog(log), "", "a dead session must not spawn zg");
    assert.deepEqual(calls, []);
  });
});

test("abort mid-build kills the build and stops every later ui call", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    const ctx = recordingUi();
    const ctrl = new AbortController();
    const warm = sessionWarmup(
      { cwd: dir, ui: ctx.ui },
      { PI_ZG_BIN: makeSlowFakeZg(dir, log) },
      path.join(dir, "home"),
      () => null,
      ctrl.signal
    );
    // Let the build start streaming, then reload the session.
    await delay(400);
    assert.ok(
      ctx.calls.some((c) => c.startsWith("status:Indexing")),
      `build progress must reach the ui first; got ${ctx.calls.join("|")}`
    );
    ctrl.abort();
    // The session is gone from here on: no status line, no error notify.
    ctx.expire();
    await delay(700);
    const settled = ctx.calls.length;
    await delay(500);
    assert.equal(
      ctx.calls.length,
      settled,
      "nothing may touch the ui after the abort"
    );
    await warm;
    assert.equal(
      ctx.calls.filter((c) => c.startsWith("notify:")).length,
      0,
      "a cancelled build is not an error"
    );
  });
});

const captureSessionHandlers = (): Map<
  string,
  ((e: unknown, c: unknown) => void)[]
> => {
  const handlers = new Map<string, ((e: unknown, c: unknown) => void)[]>();
  registerSessionWarmup({
    on: (event: string, handler: (e: unknown, c: unknown) => void): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as Parameters<typeof registerSessionWarmup>[0]);
  return handlers;
};

test("session_start aborts the previous warmup, session_shutdown the next", async () => {
  await withTempDir(async (dir) => {
    const handlers = captureSessionHandlers();
    const start = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    assert.ok(start, "registerSessionWarmup must handle session_start");
    assert.ok(shutdown, "registerSessionWarmup must handle session_shutdown");
    // The registered handler reads process.env, so the fake binary has to live
    // there for the duration (same contract as the tool/command tests).
    const previousBin = process.env.PI_ZG_BIN;
    process.env.PI_ZG_BIN = makeSlowFakeZg(dir, path.join(dir, "calls.log"));
    try {
      const previous = recordingUi();
      start({}, { cwd: dir, ui: previous.ui });
      await delay(400);
      assert.ok(previous.calls.length > 0, "the first warmup runs");
      // Reload: the previous session is replaced mid-build.
      previous.expire();
      start({}, { cwd: dir, ui: recordingUi().ui });
      await delay(700);
      const settled = previous.calls.length;
      await delay(500);
      assert.equal(
        previous.calls.length,
        settled,
        "a new session_start must abort the warmup it replaced"
      );
      // Shutdown stops the live session's warmup the same way. A second, real
      // directory keeps its own ensure-chain out of the first one.
      const second = path.join(dir, "second");
      mkdirSync(second);
      const live = recordingUi();
      start({}, { cwd: second, ui: live.ui });
      await delay(400);
      assert.ok(live.calls.length > 0, "the second warmup runs");
      live.expire();
      shutdown({}, {});
      await delay(700);
      const liveSettled = live.calls.length;
      await delay(500);
      assert.equal(
        live.calls.length,
        liveSettled,
        "session_shutdown must abort the running warmup"
      );
    } finally {
      if (previousBin === undefined) {
        delete process.env.PI_ZG_BIN;
      } else {
        process.env.PI_ZG_BIN = previousBin;
      }
    }
  });
});
