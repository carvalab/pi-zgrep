// The real runner (Task 7) owns process lifecycle (signal handling, detach
// for `zg server on`, PATH-aware `zg --version` probe). This file is the
// pure logic + interface, fully mocked-testable — no child_process here.

import { buildIndexArgs, buildStatusArgs } from "./args.ts";

export interface RunResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface Runner {
  // Resolved binary path (PI_ZG_BIN → `zg` on PATH) or null when missing.
  // The real runner implements: `zg --version` with a 10s timeout — slow binaries
  // must not trigger reinstall (spec § Components L57).
  probe: () => Promise<string | null>;

  // F7: optional accessor for the captured version line from the
  // most recent successful probe. When present, createZg skips the
  // redundant `zg --version` spawn inside probeAndVersion. Older
  // test runners without this method must still type-check; the
  // optional call site uses `runner.version?.()`.
  version?: () => string | undefined;

  // Buffered run for status / help / version. The real runner pipes stdout/stderr.
  run: (args: string[]) => Promise<RunResult>;

  // Streaming run for long-lived commands (build, query). onUpdate receives
  // progress lines; signal aborts the child (Esc kills the build — spec § L83).
  stream: (
    args: string[],
    o?: { cwd?: string; onUpdate?: (s: string) => void; signal?: AbortSignal }
  ) => Promise<{ code: number }>;

  // Install the global `@zvec/zvec-grep` package (npm -g with bun fallback).
  // Streams progress via onUpdate. MUST retry with `--ignore-scripts` when the
  // primary install fails in sharp's postinstall — prebuilt @img/sharp-linux-x64
  // ships in the tree and is safe to use without node-gyp. See
  // test/fixtures/NOTES.md:203. The real runner encodes that retry; this
  // signature is just the contract.
  install: () => Promise<void>;

  // Detached `zg server on`, best-effort. Failure is ignored — the daemon
  // handles background refresh, watcher updates, hourly reconciliation, and
  // embedding-model reuse (upstream docs/06-server.md § Refresh behavior).
  // Skip when PI_ZG_SERVER is set to any non-empty value (spec § L59).
  startServer: () => Promise<void>;

  // Overridable for tests; default impl runs `zg status --check-ready`.
  // Exit code is the API: 0 = ready, non-zero = not ready (stdout/stderr
  // carries the reason, surfaced verbatim on failure — spec § L85 offline
  // embedding-model failure, § L87 parse-miss).
  probeStatus?: () => Promise<RunResult>;
}

export interface ZgOpts {
  env?: Record<string, string | undefined>;
  onUpdate?: (s: string) => void;
  root: string;
  signal?: AbortSignal;
}

const nonEmpty = (v?: string): boolean => typeof v === "string" && v.length > 0;

/**
 * Pure resolver + ensure chain. All side effects go through `runner`, so this
 * file is testable with a fake runner (see `test/ensure.test.ts`).
 *
 * Locks (all session-scoped to this `createZg` instance):
 *   - `installP`   — at most one in-flight install; concurrent callers share it.
 *   - `buildP`     — at most one in-flight `zg index` build per session.
 *   - `serverStarted` — `zg server on` fires exactly once after first successful build.
 *
 * The session-scoped `failedRoots` memo prevents silent rebuild loops when a
 * build legitimately fails (offline machine, broken repo): the second probe
 * surfaces the original `zg status` text instead of starting another doomed
 * build. The retry-on-cold-start path is one attempt per root per session.
 */
export const createZg = (runner: Runner, opts: ZgOpts) => {
  let installP: Promise<unknown> | undefined;
  let buildP: Promise<unknown> | undefined;
  let serverStarted = false;
  const failedRoots = new Set<string>();

  const probeAndVersion = async (): Promise<{
    bin: string;
    warning?: string;
  } | null> => {
    const bin = await runner.probe();
    if (!bin) {
      return null;
    }
    // F7: probe() already paid for `zg --version` — reuse the
    // captured line when available. Falls back to a buffered
    // `runner.run(["--version"])` for older runners without the
    // optional method, or when probe captured empty stdout.
    const cached = runner.version?.();
    const versionText =
      cached !== undefined && cached.length > 0
        ? cached
        : await (async (): Promise<string> => {
            // F3: warn on pre-0.2 upstream (spec § Components L57).
            // Version probe is warn-only: a failure here (timeout,
            // spawn ENOENT, parse miss) must never block use of the
            // binary — return { bin } with no warning and let the
            // real runner own the recovery path.
            try {
              const v = await runner.run(["--version"]);
              return v.stdout;
            } catch {
              return "";
            }
          })();
    const m = versionText.match(/(?<major>\d+)\.(?<minor>\d+(?:\.\d+)?)/u);
    let warning: string | undefined;
    if (m?.groups) {
      const major = Math.trunc(Number(m.groups.major));
      const minor = Math.trunc(Number(m.groups.minor));
      if (major === 0 && minor < 2) {
        warning = `zg ${m[0]} is below 0.2; the upstream is pre-1.0 and may be unstable.`;
      }
    }
    return { bin, warning };
  };

  const ensureBinary = async (): Promise<{ bin: string; warning?: string }> => {
    const first = await probeAndVersion();
    if (first) {
      return first;
    }
    // PI_ZG_BIN set-but-broken → error naming the var, NO fallback to PATH or
    // install. User explicitly chose this path; silent fallback would surprise
    // them. (spec § Components L57)
    if (nonEmpty(opts.env?.PI_ZG_BIN)) {
      throw new Error(
        `PI_ZG_BIN=${opts.env?.PI_ZG_BIN} is set but zg is not executable there. Fix the path or unset PI_ZG_BIN.`
      );
    }
    // PI_ZG_AUTO_INSTALL non-empty → skip install; surface the exact manual
    // command so the user can run it themselves.
    if (nonEmpty(opts.env?.PI_ZG_AUTO_INSTALL)) {
      throw new Error(
        "zg is not installed. Install it with: npm install -g @zvec/zvec-grep"
      );
    }
    if (!installP) {
      // Wrap the install promise so we can clear `installP` after it settles
      // (success or failure) without using `.finally()` (linter bans promise
      // chaining in src). Both concurrent callers then share one in-flight
      // install.
      const tracked = runner.install();
      installP = (async (): Promise<unknown> => {
        try {
          return await tracked;
        } finally {
          installP = undefined;
        }
      })();
    }
    await installP;
    const again = await probeAndVersion();
    if (!again) {
      throw new Error(
        "zg install finished but the binary is still not on PATH. Try: npm install -g @zvec/zvec-grep"
      );
    }
    return again;
  };

  const runBuild = async (): Promise<void> => {
    // F2: buffer the last ~10 progress lines so a failed build can surface
    // zg's own output instead of pointing the user at `zg status`. Every
    // line still forwards to opts.onUpdate verbatim.
    const TAIL_MAX = 10;
    const tail: string[] = [];
    const userOnUpdate = opts.onUpdate;
    const wrappedOnUpdate = userOnUpdate
      ? (s: string): void => {
          tail.push(s);
          if (tail.length > TAIL_MAX) {
            tail.shift();
          }
          userOnUpdate(s);
        }
      : undefined;
    const res = await runner.stream(buildIndexArgs(), {
      cwd: opts.root,
      onUpdate: wrappedOnUpdate,
      signal: opts.signal,
    });
    if (res.code !== 0) {
      const tailText =
        tail.length > 0 ? `\nLast output:\n${tail.join("\n")}` : "";
      throw new Error(`zg index failed (exit ${res.code}).${tailText}`);
    }
  };

  const startServerFireAndForget = async (): Promise<void> => {
    try {
      await runner.startServer();
    } catch {
      // # ponytail: fire-and-forget daemon start; add health surfacing in
      // /zg-status if users report issues.
    }
  };

  const ensureIndex = async (): Promise<{ error?: string }> => {
    const st = runner.probeStatus
      ? await runner.probeStatus()
      : await runner.run(buildStatusArgs());
    if (st.code === 0) {
      return {};
    }
    // F1: a concurrent call already started a build for this session — just
    // wait for it. Adding the root to failedRoots here would mark the
    // in-flight build as already-failed and surface a spurious memo to the
    // rider if the build then succeeds.
    if (buildP) {
      try {
        await buildP;
      } catch (error) {
        return { error: (error as Error).message };
      }
      return {};
    }
    // No build in flight. Already attempted this root this session and it
    // failed → don't loop. Surface the verbatim `zg status` text (or stderr)
    // so the user sees what zg actually said (offline → embedding-model
    // download failure, broken repo → indexer error, etc. — spec § L85, § L87).
    if (failedRoots.has(opts.root)) {
      return {
        error: `zg index is not ready (previous build attempt failed). zg status said: ${st.stdout || st.stderr}`,
      };
    }
    // Synchronously assign buildP before any await so concurrent riders see
    // it set and join the in-flight build instead of falling into the
    // failedRoots memo branch above. failedRoots is mutated only inside the
    // wrapper — after the build has actually settled.
    buildP = (async (): Promise<unknown> => {
      try {
        await runBuild();
        if (!serverStarted && !nonEmpty(opts.env?.PI_ZG_SERVER)) {
          serverStarted = true;
          void startServerFireAndForget();
        }
      } catch (error) {
        failedRoots.add(opts.root);
        throw error;
      } finally {
        buildP = undefined;
      }
      return undefined;
    })();
    try {
      await buildP;
    } catch (error) {
      return { error: (error as Error).message };
    }
    return {};
  };

  return { ensureBinary, ensureIndex };
};
