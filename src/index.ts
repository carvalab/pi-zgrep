// pi-zg: extension factory. Wraps the zg (zvec-grep) CLI as a single tool
// ("zg") plus two commands (/zg-index, /zg-status) and an opt-out system
// prompt nudge that steers the agent toward zg for code/content search.
//
// File layout:
//   - args.ts  → CLI arg builders (pure)
//   - parse.ts → output parsers (pure, fixture-tripwired)
//   - zg.ts    → ensure chain (pure, testable with a fake runner)
//   - index.ts → this file: the real Runner + extension factory
//
// The Runner interface (from ./zg.ts) is the contract; the real impl
// below owns process lifecycle, signal wiring, and the npm/bun install
// retry dance.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import type { Readable } from "node:stream";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  buildIndexArgs,
  buildQueryArgs,
  buildStatusArgs,
  parseIndexCommandArgs,
  validateQueryInput,
} from "./args.ts";
import { parseQueryOutput, parseStatusOutput, renderResults } from "./parse.ts";
import type { QueryParse } from "./parse.ts";
import { createZg } from "./zg.ts";
import type { RunResult, Runner } from "./zg.ts";

const PROBE_TIMEOUT_MS = 10_000;

const nonEmpty = (v: string | undefined): boolean =>
  typeof v === "string" && v.length > 0;

// --- Local engine resolution (npm-12-safe: files, not scripts) --------------

// The engine ships as a real dependency (@zvec/zvec-grep), so `pi install`
// materializes it next to this extension with no lifecycle scripts involved —
// npm 12 blocks dependency postinstalls by default (RFC 0054) and pi's
// installer does not opt in. Upstream ships its native core the same community
// way (@zvec/bindings-* as prebuilt optional deps), so a script-less install
// yields a working engine.
//
// `findPackageJSON` (node ≥22.14; our engines floor is 22.18) locates the
// package across `exports` maps and nested node_modules; the CLI entry comes
// from its `bin` field. Any mismatch (upstream layout change, absent bin) →
// null → PATH/global fallback; never a hard failure.
export const resolveLocalZgCli = (fromDir: string): string | null => {
  try {
    const pkgPath = findPackageJSON(
      "@zvec/zvec-grep",
      path.join(fromDir, "index.ts")
    );
    if (!pkgPath) {
      return null;
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      bin?: Record<string, string> | string;
    };
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.zg;
    if (!rel) {
      return null;
    }
    const cli = path.join(path.dirname(pkgPath), rel);
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
};

// Memoized for resolveBin (called on every spawn). Caches misses too — a
// dependency-less dev checkout (`pi -e .`) stays null for the session and
// falls through to PATH / global-install.
let localZgCliCache: string | null | undefined;
const localZgCli = (): string | null => {
  if (localZgCliCache === undefined) {
    localZgCliCache = resolveLocalZgCli(import.meta.dirname);
  }
  return localZgCliCache;
};

// --- Guidance (opt-out via PI_ZG_GUIDANCE) ---------------------------------

export const guidanceText = (): string =>
  [
    "Code/content search: prefer the `zg` tool before grep/find. The `zg` tool is a function you call directly — there is no `zg` binary to run from a shell.",
    "- mode=hybrid (default) for intent or natural-language questions; mode=fts for known symbols/identifiers; mode=vector for paraphrases; mode=rg for exact literal/regex.",
    "- Fall back to grep/find only when (1) zg returns zero results, (2) the zg tool errors, (3) results report possibly_stale for content just edited this session, or (4) the target is outside the indexed workspace.",
  ].join("\n");

export const shouldInjectGuidance = (
  env: Record<string, string | undefined>
): boolean => !nonEmpty(env.PI_ZG_GUIDANCE);

// First line of the `/zg-status` binary line. `bin` is the resolved binary
// name (PI_ZG_BIN or `zg`); `versionFirstLine` is the first non-empty line
// from `zg --version`, or null when the probe failed. Any falsy input
// degrades to the "not found" line so /zg-status never crashes.
export const formatBinaryLine = (
  bin: string | null,
  versionFirstLine: string | null
): string => {
  if (!bin || !versionFirstLine || versionFirstLine.length === 0) {
    return "binary: not found (install on next zg tool use)";
  }
  return `binary: ${bin} (${versionFirstLine})`;
};

// `/zg-status` daemon line. `serverStatus` is the buffered `zg server status`
// spawn (null when the spawn itself failed). zg owns the daemon lifecycle;
// this only surfaces its state and degrades to a start hint.
export const formatDaemonLine = (
  serverStatus: { code: number; stdout: string } | null
): string => {
  const start = "start it with /zg-server on";
  if (!serverStatus || serverStatus.code !== 0) {
    return `daemon: not ready — ${start}`;
  }
  const state =
    serverStatus.stdout
      .match(/^Server:\s*(?<state>.+)$/mu)
      ?.groups?.state?.trim() ?? "ready";
  if (state !== "ready") {
    // plain `zg server status` exits 0 even when stopped — the state text is
    // the only signal.
    return `daemon: ${state} — ${start}`;
  }
  const pid = serverStatus.stdout.match(/^PID:\s*(?<pid>\d+)/mu)?.groups?.pid;
  return `daemon: ready${pid ? ` (pid ${pid})` : ""} — stop it with /zg-server off`;
};

// --- Process helpers --------------------------------------------------------

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code: unknown }).code === "ENOENT";

const collectStream = async (stream: Readable | null): Promise<string> => {
  if (!stream) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

// Wait for a child to either close (normal exit) or error (spawn failure).
// Returns the exit code, or rejects on spawn error. F4: after the race
// resolves, attach `.catch(() => {})` to the loser so a late event on
// its registered listener cannot become `unhandledRejection` in the
// host process. Exported for the regression test in runner.test.ts.
export const awaitChild = async (child: ChildProcess): Promise<number> => {
  const errorP = (async (): Promise<never> => {
    const [error] = (await once(child, "error")) as [Error];
    throw error;
  })();
  const closeP = once(child, "close") as Promise<[number | null]>;
  // F4: Promise.race attaches handlers to both promises, so a late
  // errorP rejection after closeP wins can never be unhandled. Never
  // await the loser: `once(child, "error")` never settles on a clean
  // close, so awaiting it would hang every successful spawn.
  const winner = await Promise.race([closeP, errorP]);
  return (winner[0] ?? -1) as number;
};

const forwardLines = async (
  stream: Readable,
  onLine: (line: string) => void
): Promise<void> => {
  let buf = "";
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    buf += chunk.toString("utf-8");
    let idx = buf.indexOf("\n");
    while (idx >= 0) {
      onLine(buf.slice(0, idx));
      buf = buf.slice(idx + 1);
      idx = buf.indexOf("\n");
    }
  }
  if (buf.length > 0) {
    onLine(buf);
  }
};

const wireAbortKill = (
  child: ChildProcess,
  signal: AbortSignal
): (() => void) => {
  const onAbort = (): void => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return (): void => {
    signal.removeEventListener("abort", onAbort);
  };
};

// --- Real Runner ------------------------------------------------------------

interface MakeRunnerOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onUpdate?: (s: string) => void;
  signal?: AbortSignal;
}

export const makeRunner = (opts: MakeRunnerOpts): Runner => {
  let probedBin: string | undefined;
  // F7: closure-scoped version cache populated by probe. createZg's
  // probeAndVersion uses runner.version?.() to skip the redundant
  // `--version` spawn (probe already paid for it).
  let versionLine: string | undefined;
  // Resolution order: PI_ZG_BIN (explicit override) → the packaged engine
  // dependency resolved from this package's node_modules → `zg` on PATH. If
  // the local copy exists but is broken, probe fails and ensureBinary falls
  // through to the global-install path; PI_ZG_BIN stays the manual escape
  // hatch for that corner.
  const resolveBin = (): string =>
    nonEmpty(opts.env?.PI_ZG_BIN)
      ? (opts.env?.PI_ZG_BIN as string)
      : (localZgCli() ?? "zg");

  const startProcess = (
    bin: string,
    args: string[],
    o?: { cwd?: string }
  ): ChildProcess => {
    // The local engine is a packaged JS entry — run it with the current node
    // instead of relying on exec bits and shebangs. Global and PI_ZG_BIN bins
    // stay direct spawns.
    const [cmd, argv] = bin.endsWith(".js")
      ? [process.execPath, [bin, ...args]]
      : [bin, args];
    return spawn(cmd, argv, {
      cwd: o?.cwd ?? opts.cwd,
      env: opts.env,
      shell: false,
    });
  };

  const probe = async (): Promise<string | null> => {
    const bin = resolveBin();
    let child: ChildProcess;
    try {
      child = startProcess(bin, ["--version"]);
    } catch {
      return null;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, PROBE_TIMEOUT_MS);
    try {
      // F7: drain stdout so the version line is available for the
      // cache. Trimming the captured text keeps the cached value
      // close to what `zg --version` actually prints (the line is
      // "0.2.1\n" on a real install).
      const [code, stdout] = await Promise.all([
        awaitChild(child),
        collectStream(child.stdout),
      ]);
      if (timedOut) {
        throw new Error("zg --version timed out after 10s");
      }
      if (code === 0) {
        probedBin = bin;
        const first = stdout.trim().split("\n", 1)[0] ?? "";
        versionLine = first.length > 0 ? first : undefined;
        return bin;
      }
      return null;
    } catch (error) {
      if (isEnoent(error)) {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  // F7: optional accessor for the cached version line. Undefined
  // until probe() has succeeded with non-empty stdout. Additive on
  // the Runner interface — older test runners without it still type-
  // check against the base shape.
  const version = (): string | undefined => versionLine;

  const run = (args: string[]): Promise<RunResult> => {
    const bin = probedBin ?? resolveBin();
    const child = startProcess(bin, args);
    const unwire = opts.signal ? wireAbortKill(child, opts.signal) : null;
    return (async (): Promise<RunResult> => {
      try {
        const [stdout, stderr, code] = await Promise.all([
          collectStream(child.stdout),
          collectStream(child.stderr),
          awaitChild(child),
        ]);
        return { code, stderr, stdout };
      } finally {
        if (unwire) {
          unwire();
        }
      }
    })();
  };

  const stream = (
    args: string[],
    o?: { cwd?: string; onUpdate?: (s: string) => void; signal?: AbortSignal }
  ): Promise<{ code: number }> => {
    const bin = probedBin ?? resolveBin();
    const child = startProcess(bin, args, { cwd: o?.cwd });
    const unwire = o?.signal ? wireAbortKill(child, o.signal) : null;
    return (async (): Promise<{ code: number }> => {
      const linesP =
        o?.onUpdate && child.stdout
          ? forwardLines(child.stdout, o.onUpdate)
          : Promise.resolve();
      try {
        // F4: drain stderr so a noisy build doesn't deadlock the pipe
        // (>64KiB stderr buffer with no reader blocks the child on write).
        // Discard bytes — stdout carries the indexed output.
        const { code } = await Promise.all([
          awaitChild(child),
          linesP,
          collectStream(child.stderr),
        ]).then(([c]) => ({ code: c as number }));
        return { code };
      } finally {
        if (unwire) {
          unwire();
        }
      }
    })();
  };

  const tryInstall = async (
    bin: string,
    cmdArgs: string[]
  ): Promise<
    { ok: true } | { ok: false; reason: "enoent" | "exit"; stderr: string }
  > => {
    // F2: spawn doesn't throw sync on ENOENT — it emits 'error' async,
    // which awaitChild rejects with. Wrap the await to catch it so the
    // npm-missing case yields {reason:"enoent"} and the bun fallback
    // is reachable.
    const child = spawn(bin, cmdArgs, {
      env: opts.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const linesP =
      opts.onUpdate && child.stdout
        ? forwardLines(child.stdout, opts.onUpdate)
        : Promise.resolve();
    try {
      const [stderr, code] = await Promise.all([
        collectStream(child.stderr),
        awaitChild(child),
        linesP,
      ]).then(([s, c]) => [s, c] as [string, number]);
      if (code === 0) {
        return { ok: true };
      }
      return { ok: false, reason: "exit", stderr };
    } catch (error) {
      if (isEnoent(error)) {
        return { ok: false, reason: "enoent", stderr: "" };
      }
      throw error;
    }
  };

  const install = async (): Promise<void> => {
    // First attempt: npm install -g. Sharp's optional postinstall can fail
    // on machines without node-gyp; prebuilt @img/sharp-linux-x64 ships in
    // the tree, so --ignore-scripts is a safe retry.
    const r1 = await tryInstall("npm", ["install", "-g", "@zvec/zvec-grep"]);
    if (r1.ok) {
      return;
    }
    if (r1.reason === "enoent") {
      // npm missing entirely; try the bun fallback.
      const rb = await tryInstall("bun", ["add", "-g", "@zvec/zvec-grep"]);
      if (rb.ok) {
        return;
      }
      throw new Error(
        "Install failed. Run manually: npm install -g @zvec/zvec-grep"
      );
    }
    // npm ran but exited non-zero — most likely sharp's postinstall. Retry
    // once with --ignore-scripts; if that also fails, give up with the
    // exact manual command.
    const r2 = await tryInstall("npm", [
      "install",
      "-g",
      "@zvec/zvec-grep",
      "--ignore-scripts",
    ]);
    if (r2.ok) {
      return;
    }
    throw new Error(
      "Install failed. Run manually: npm install -g @zvec/zvec-grep"
    );
  };

  const startServer = (): Promise<void> => {
    const bin = probedBin ?? resolveBin();
    try {
      // Detach + ignore stdio so `zg server on` survives pi's process group
      // (Ctrl+C / terminal close). unref() lets the parent exit cleanly while
      // the daemon keeps running. This is the only spawn in the runner that
      // detaches; probe/run/stream stay attached to their parent.
      const child = spawn(bin, ["server", "on"], {
        cwd: opts.cwd,
        detached: true,
        env: opts.env,
        shell: false,
        stdio: "ignore",
      });
      // F1: async spawn failures (ENOENT) emit 'error' on the child; with
      // no listener they crash the host pi process via uncaughtException.
      // We detach and don't await, so the empty handler is intentional —
      // daemon management is zg's responsibility.
      child.on("error", () => {
        // intentional no-op: see comment above
      });
      child.unref();
    } catch {
      // Fire-and-forget; daemon management is zg's responsibility
      // (spec § L59: "pi-zg leaves daemon management to zg").
    }
    return Promise.resolve();
  };

  return { install, probe, run, startServer, stream, version };
};

// --- Factory ----------------------------------------------------------------

// F2: per-cwd cache of { runner, zg }. pi executes tools in parallel
// by default, so creating a fresh ensure-chain on every tool call
// would reset installP / buildP / failedRoots per call — install
// would fire once per call, builds would race, and the README's
// "memoized error" claim would be false. Hoisting a Map<cwd, …>
// keyed by ctx.cwd makes the session guarantees real. makeRunner
// stays per-call (cheap closure) but the cache means the runner it
// returns is only used on the first invocation for a given cwd;
// subsequent callers reuse the cached chain.
interface CachedChain {
  env: Record<string, string | undefined>;
  runner: Runner;
  zg: ReturnType<typeof createZg>;
}
const chainCache = new Map<string, CachedChain>();

export interface GetOrCreateOpts {
  cwd: string;
  env: Record<string, string | undefined>;
  makeRunner: () => Runner;
  onUpdate?: (s: string) => void;
  signal?: AbortSignal;
}

export const getOrCreateZg = (opts: GetOrCreateOpts): CachedChain => {
  const cached = chainCache.get(opts.cwd);
  if (cached) {
    return cached;
  }
  const runner = opts.makeRunner();
  const zg = createZg(runner, {
    env: opts.env,
    onUpdate: opts.onUpdate,
    root: opts.cwd,
    signal: opts.signal,
  });
  const entry: CachedChain = {
    env: opts.env,
    runner,
    zg,
  };
  chainCache.set(opts.cwd, entry);
  return entry;
};

// Test-only: clear the per-cwd cache between cases so assertions about
// fresh-chains-on-distinct-cwds stay deterministic.
export const resetZgCache = (): void => {
  chainCache.clear();
};

// --- Tool: zg ---------------------------------------------------------------

type ZgToolDetails = QueryParse | { isError: true };

const ZgToolParams = Type.Object({
  glob: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ maximum: 50, minimum: 1 })),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("hybrid"),
      Type.Literal("fts"),
      Type.Literal("vector"),
      Type.Literal("rg"),
    ])
  ),
  preview: Type.Optional(
    Type.Union([Type.Literal("short"), Type.Literal("none")])
  ),
  query: Type.String({
    description:
      "Search query (natural language, symbol, or regex for mode=rg)",
    minLength: 1,
  }),
  refresh: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("wait")])
  ),
  type: Type.Optional(Type.String()),
});

// --- Commands ---------------------------------------------------------------

// Palette hints for command arguments (pi filters by the typed prefix and
// falls back to null when nothing matches). The /zg-index list is the common
// `zg index` flags, not the full surface — the command stays passthrough.
const ZG_SERVER_VERBS = ["on", "off", "status"];
const ZG_INDEX_FLAGS = [
  "--rebuild",
  "--drop",
  "--yes",
  "--debug",
  "--mode",
  "--embedding",
  "--glob",
];
const completeFrom =
  (values: string[]) =>
  (prefix: string): { value: string; label: string }[] | null => {
    const items = values
      .filter((v) => v.startsWith(prefix))
      .map((v) => ({ label: v, value: v }));
    return items.length > 0 ? items : null;
  };

const registerZgIndexCommand = (pi: ExtensionAPI): void => {
  pi.registerCommand("zg-index", {
    description:
      "Build or update the zg index for the current workspace. Forwards arguments to `zg index` (e.g. --rebuild, --drop --yes, --debug). For index status use /zg-status.",
    getArgumentCompletions: completeFrom(ZG_INDEX_FLAGS),
    handler: async (args, ctx) => {
      const started = Date.now();
      ctx.ui.setStatus("pi-zg", "indexing…");
      ctx.ui.notify("zg index started", "info");
      // F6: the runner-level onUpdate wrapper was dead here — /zg-index
      // never installs, so opts.onUpdate is never invoked. Fold setStatus
      // into streamOnUpdate so each build-progress line surfaces live.
      const parsed = parseIndexCommandArgs(args);
      if (!parsed.ok) {
        // Don't spawn a doomed build: bare words that aren't existing paths
        // (e.g. "status") die upstream as [ROOT_NOT_FOUND] with exit 1.
        ctx.ui.notify(
          "Usage: /zg-index [--rebuild | --drop --yes | <zg index flags> | <workspace path>]. For index status use /zg-status (or run `zg status` in bash).",
          "error"
        );
        return;
      }
      const runner = makeRunner({ cwd: ctx.cwd, env: process.env });
      const extra = parsed.args;

      // ponytail: /zg-index builds are unabortable and unlocked (command
      // ctx.signal is undefined while idle; two concurrent runs race) —
      // route through createZg if users hit this.

      // Tail buffer like runBuild in zg.ts: keep the last ~10 progress lines
      // so a failed build surfaces zg's own output in the failure notify.
      const TAIL_MAX = 10;
      const tail: string[] = [];
      const streamOnUpdate = (s: string): void => {
        ctx.ui.setStatus("pi-zg", s.slice(0, 80));
        tail.push(s);
        if (tail.length > TAIL_MAX) {
          tail.shift();
        }
      };

      try {
        const res = await runner.stream(buildIndexArgs(extra), {
          cwd: ctx.cwd,
          onUpdate: streamOnUpdate,
        });
        const duration = ((Date.now() - started) / 1000).toFixed(1);
        if (res.code === 0) {
          ctx.ui.notify(`zg index finished in ${duration}s`, "info");
          return;
        }
        const tailText =
          tail.length > 0 ? `\nLast output:\n${tail.join("\n")}` : "";
        ctx.ui.notify(
          `zg index failed (exit ${res.code}) in ${duration}s${tailText}`,
          "error"
        );
      } finally {
        // F5: install/build-progress status must clear even if the build
        // rejects (e.g. ENOENT, signal abort).
        ctx.ui.setStatus("pi-zg", undefined);
      }
    },
  });
};

const registerZgStatusCommand = (pi: ExtensionAPI): void => {
  pi.registerCommand("zg-status", {
    description: "Show zg index readiness and freshness",
    handler: async (_args, ctx) => {
      const runner = makeRunner({ cwd: ctx.cwd, env: process.env });
      // Probe the binary: single `zg --version` spawn. On success we have
      // both the resolved bin name and the version string; on any failure
      // (ENOENT, non-zero exit, spawn throw) the line degrades to the
      // "not found" form so the handler never crashes.
      const binName = nonEmpty(process.env.PI_ZG_BIN)
        ? (process.env.PI_ZG_BIN as string)
        : "zg";
      let versionFirstLine: string | null = null;
      try {
        const v = await runner.run(["--version"]);
        if (v.code === 0) {
          const trimmed = v.stdout.trim();
          if (trimmed.length > 0) {
            versionFirstLine = trimmed.split("\n", 1)[0] ?? null;
          }
        }
      } catch {
        // probe failed — versionFirstLine stays null; formatBinaryLine
        // degrades to the not-found line.
      }
      let res: RunResult;
      try {
        res = await runner.run(buildStatusArgs());
      } catch {
        // F3: status call failed (spawn ENOENT, daemon crash, etc.) — emit
        // the not-found binary line and skip the index lines so the
        // handler never rejects.
        ctx.ui.notify(formatBinaryLine(null, null), "info");
        return;
      }
      const parsed = parseStatusOutput(res.stdout);
      const lines: string[] = [formatBinaryLine(binName, versionFirstLine)];
      if ("raw" in parsed) {
        lines.push("index: unknown (could not parse zg output)");
        if (parsed.raw.trim().length > 0) {
          lines.push(parsed.raw.trim());
        }
      } else if (parsed.ready) {
        lines.push("index: ready");
        if (parsed.freshness) {
          lines.push(`freshness: ${parsed.freshness}`);
        }
      } else {
        lines.push("index: not ready");
        if (parsed.freshness) {
          lines.push(`freshness: ${parsed.freshness}`);
        }
      }
      if (res.stderr.trim().length > 0) {
        lines.push(res.stderr.trim());
      }
      let daemonStatus: RunResult | null = null;
      try {
        daemonStatus = await runner.run(["server", "status"]);
      } catch {
        // daemon probe is best-effort; formatDaemonLine degrades to a hint.
      }
      lines.push(formatDaemonLine(daemonStatus));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
};

// --- Tool registration ------------------------------------------------------

// Manual daemon override. Upstream starts the server itself for agent users
// (and our warmup starts it after the first build), so this is only needed to
// stop it, or to start it without building an index first.
const registerZgServerCommand = (pi: ExtensionAPI): void => {
  pi.registerCommand("zg-server", {
    description:
      "Start, stop, or inspect the zg daemon: /zg-server on|off|status. The daemon usually starts by itself after the first index build; this is a manual override.",
    getArgumentCompletions: completeFrom(ZG_SERVER_VERBS),
    handler: async (rawArgs, ctx) => {
      const verb = rawArgs?.trim().split(/\s+/u)[0] ?? "";
      if (verb !== "on" && verb !== "off" && verb !== "status") {
        ctx.ui.notify("Usage: /zg-server [on|off|status]", "error");
        return;
      }
      const runner = makeRunner({ cwd: ctx.cwd, env: process.env });
      try {
        const res = await runner.run(["server", verb]);
        if (verb === "status") {
          ctx.ui.notify(
            formatDaemonLine({ code: res.code, stdout: res.stdout }),
            "info"
          );
          return;
        }
        if (res.code === 0) {
          ctx.ui.notify(`zg server ${verb}: done`, "info");
          return;
        }
        const detail = [res.stdout.trim(), res.stderr.trim()]
          .filter((s) => s.length > 0)
          .join("\n");
        ctx.ui.notify(
          `zg server ${verb} failed (exit ${res.code})${detail ? `:\n${detail}` : ""}`,
          "error"
        );
      } catch {
        ctx.ui.notify(
          "zg binary not found — it installs on next /zg-index or zg tool use",
          "error"
        );
      }
    },
  });
};

const registerZgTool = (pi: ExtensionAPI): void => {
  pi.registerTool({
    description:
      'Workspace code/content search. Call this tool directly — there is no `zg` binary to shell out to. USE THIS FIRST for code/content questions, before grep/find. Local-first semantic + BM25 + hybrid + ripgrep over the current workspace; excludes node_modules/, .git/, and build outputs; anything outside the workspace is NOT indexed — grep directly for those. Modes: hybrid (default) natural-language intent ("where are auth tokens read?"); fts exact symbols ("PackageUpdate"); vector paraphrases; rg literal/regex ("^export function check") only when fts misses. Fall back to bash grep only when: (1) zero results though the term must exist, (2) this tool errors, (3) result says possibly_stale after you edited it this session, (4) the target is outside the indexed workspace. Don\'t default to bash grep out of habit: a 2s zg call beats a 30s grep reflex.',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // pi's ToolExecutionComponent reads `result.content` unguarded on every
      // update (for image-block extraction), so partial payloads MUST include
      // `content: []` alongside the progress details.
      // F2: use the per-cwd cache so parallel tool calls on the same root
      // share one ensure-chain (install lock, build lock, failedRoots memo).
      const chain = getOrCreateZg({
        cwd: ctx.cwd,
        env: process.env,
        makeRunner: (): Runner =>
          makeRunner({
            cwd: ctx.cwd,
            env: process.env,
            onUpdate: (s: string): void => {
              onUpdate?.({ content: [], details: { progress: s } });
              // F4: surface install progress on the status bar; cleared once
              // ensureBinary returns. Build progress flows through the same
              // onUpdate channel via createZg, but build uses ctx.ui.setStatus
              // only in the /zg-index command path — the tool path doesn't
              // overwrite this status mid-build because the createZg onUpdate
              // below deliberately omits setStatus.
              ctx.ui.setStatus("pi-zg", s.slice(0, 80));
            },
            signal,
          }),
        onUpdate: (s: string): void => {
          onUpdate?.({ content: [], details: { progress: s } });
        },
        signal,
      });
      const { runner, zg } = chain;

      let warning: string | undefined;
      try {
        ({ warning } = await zg.ensureBinary());
      } finally {
        // F5: install-progress status must clear even when ensureBinary
        // throws (ENOENT, install failure, PI_ZG_BIN misconfig).
        ctx.ui.setStatus("pi-zg", undefined);
      }

      if (params.mode !== "rg") {
        const idx = await zg.ensureIndex();
        if (idx.error) {
          return {
            content: [{ text: `zg error: ${idx.error}`, type: "text" }],
            details: { isError: true } as ZgToolDetails,
          };
        }
      }

      const args = buildQueryArgs({
        glob: params.glob,
        limit: params.limit ?? 10,
        mode: params.mode ?? "hybrid",
        preview: params.preview ?? "short",
        query: params.query,
        refresh: params.refresh,
        type: params.type,
      });

      // F3 (b/d): guard before we shell out so the agent sees a clear
      // tool error instead of an upstream "missing: --limit, 1" parse
      // failure. Schema minLength: 1 already covers empty query at the
      // type level; the guard covers the leading-dash cases TypeBox
      // can't express.
      try {
        validateQueryInput({
          glob: params.glob,
          limit: params.limit ?? 10,
          mode: params.mode ?? "hybrid",
          preview: params.preview ?? "short",
          query: params.query,
          refresh: params.refresh,
          type: params.type,
        });
      } catch (error) {
        return {
          content: [
            { text: `zg error: ${(error as Error).message}`, type: "text" },
          ],
          details: { isError: true } as ZgToolDetails,
        };
      }

      const res = await runner.run(args);
      const parsed = parseQueryOutput(res.stdout);
      const body =
        "raw" in parsed
          ? `zg output (unparsed — upstream format may have changed; run /zg-status and file an issue at carvalab/pi-zgrep):\n${parsed.raw}`
          : renderResults(parsed);
      const text = warning ? `${warning}\n${body}` : body;
      return {
        content: [{ text, type: "text" }],
        details: parsed as ZgToolDetails,
      };
    },
    label: "zg",
    name: "zg",
    parameters: ZgToolParams,
  });
};

// --- Session-start warmup ---------------------------------------------------

// Structural slice of the pi ctx that event handlers receive, with the exact
// signatures from ExtensionUIContext so the real ctx assigns cleanly.
export interface WarmupUi {
  notify: (message: string, type?: "info" | "warning" | "error") => void;
  setStatus: (key: string, text: string | undefined) => void;
}
export interface WarmupCtx {
  cwd: string;
  ui: WarmupUi;
}

// Kick the ensure-chain in the background at session start so the first zg
// query hits a ready index. Resource guarantees (user requirement: one build,
// one server, nothing heavy on startup):
//   - probe-only: binary missing → bail silently. No background npm install;
//     that stays on first tool use, exactly as before.
//   - one build per process: the per-cwd chainCache shares buildP, so a
//     warmup racing the first tool call joins the same build.
//   - one daemon: every session attempts `zg server on` once (idempotent;
//     upstream enforces a single instance per home via the fixed port), so
//     a daemon from a previous session is reused and a dead one revives at
//     startup instead of staying down until the next build.
// ponytail: locks are per-process — two pi windows on the same cold repo can
// race two `zg index` runs; upstream tolerates concurrent builds. Split a
// cross-process lock only if that ever misbehaves.
export const sessionWarmup = async (
  ctx: WarmupCtx,
  env: Record<string, string | undefined> = process.env
): Promise<void> => {
  const onProgress = (s: string): void => {
    ctx.ui.setStatus("pi-zg", s.slice(0, 80));
  };
  const chain = getOrCreateZg({
    cwd: ctx.cwd,
    env,
    makeRunner: (): Runner =>
      makeRunner({ cwd: ctx.cwd, env, onUpdate: onProgress }),
    onUpdate: onProgress,
  });
  try {
    if (!(await chain.runner.probe())) {
      return;
    }
    // Upstream agent guidance (docs/06-server.md): the daemon should simply
    // be running — background refresh and embedding-model reuse span
    // sessions. zg enforces a single instance per home (fixed listen port),
    // so this can never stack a second daemon over a previous session's.
    chain.zg.startServerOnce();
    ctx.ui.setStatus("pi-zg", "checking index…");
    const idx = await chain.zg.ensureIndex();
    if (idx.error) {
      ctx.ui.notify(`zg warmup: ${idx.error}`, "error");
    }
  } catch {
    // Warmup must never break session start; the tool path surfaces real
    // errors (install failures, PI_ZG_BIN misconfig) to the agent.
  } finally {
    ctx.ui.setStatus("pi-zg", undefined);
  }
};

const registerSessionWarmup = (pi: ExtensionAPI): void => {
  pi.on("session_start", (_event, ctx) => {
    // Fire-and-forget: never block startup on an index build. Reload/resume
    // re-runs it — two cheap spawns on a warm repo.
    void sessionWarmup(ctx);
  });
};

// --- Guidance event ---------------------------------------------------------

const registerGuidance = (pi: ExtensionAPI): void => {
  pi.on("before_agent_start", (event) => {
    if (!shouldInjectGuidance(process.env)) {
      return;
    }
    return { systemPrompt: `${event.systemPrompt}\n\n${guidanceText()}` };
  });
};

// --- Factory ----------------------------------------------------------------

export default function piZgExtension(pi: ExtensionAPI): void {
  registerZgTool(pi);
  registerZgIndexCommand(pi);
  registerZgStatusCommand(pi);
  registerZgServerCommand(pi);
  registerSessionWarmup(pi);
  registerGuidance(pi);
}
