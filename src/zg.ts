// The real runner (Task 7) owns process lifecycle (signal handling, detach
// for `zg --server on`, PATH-aware `zg --version` probe). This file is the
// pure logic + interface, fully mocked-testable — no child_process here.

import {
  buildIndexArgs,
  buildStatusArgs,
  isNewIndexState,
  nonEmpty,
} from "./args.ts";
import { parseStatusOutput } from "./parse.ts";
import { isUnsafeAutoIndexRoot, planWorkspace } from "./workspace.ts";
import type { WorkspacePlan } from "./workspace.ts";

export interface RunResult {
  code: number;
  stderr: string;
  stdout: string;
}

export interface Runner {
  // Resolved binary path (PI_ZG_BIN (exclusive) → packaged platform binary → `zg` on PATH) or null when missing.
  // The real runner implements: `zg --version` with a 10s timeout — slow binaries
  // must not trigger reinstall (spec § Components L57).
  probe: () => Promise<string | null>;

  // Optional accessor for the version line from the most recent successful
  // probe (filled in by `probe`, used by /zg-status); call sites use the
  // optional form `runner.version?.()` but every real runner implements it.
  version?: () => string | undefined;

  // Optional diagnosis for the last failed probe: which candidate binaries
  // were rejected and which version each one reported. The real runner gates
  // on `zg --version` >= 0.3.0 (0.2.x had a different CLI), so a failure here
  // usually means "an old zg is on PATH" and the message has to say so.
  probeIssue?: () => string | undefined;

  // Buffered run for status / help / version. The real runner pipes stdout/stderr.
  run: (args: string[]) => Promise<RunResult>;

  // Streaming run for long-lived commands (build, query). onUpdate receives
  // progress lines; signal aborts the child (Esc kills the build — spec § L83).
  stream: (
    args: string[],
    o?: { cwd?: string; onUpdate?: (s: string) => void; signal?: AbortSignal }
  ) => Promise<{ code: number }>;

  // Install the global `@zvec/zvec-grep` package (npm -g with bun fallback).
  // Streams progress via onUpdate. 0.3.0 ships no JS entry, so a plain global
  // install is enough — never add --ignore-scripts or --omit=optional (either
  // leaves the install without the per-platform native engine).
  install: () => Promise<void>;

  // Detached `zg --server on`, best-effort. Failure is ignored — the daemon
  // handles background refresh, watcher updates, hourly reconciliation, and
  // embedding-model reuse (upstream docs/06-server.md § Refresh behavior).
  // Skip when PI_ZG_SERVER is set to any non-empty value (spec § L59).
  startServer: () => Promise<void>;

  // Overridable for tests; default impl runs `zg --status --check-ready`.
  // Exit code is the API: 0 = ready, non-zero = not ready (stdout/stderr
  // carries the reason, surfaced verbatim on failure — spec § L85 offline
  // embedding-model failure, § L87 parse-miss).
  probeStatus?: () => Promise<RunResult>;
}

export interface ZgOpts {
  env?: Record<string, string | undefined>;
  // Injectable for tests: filesystem probe and home directory used to plan
  // which index a query belongs to (see ./workspace.ts).
  exists?: (p: string) => boolean;
  home?: string;
  onUpdate?: (s: string) => void;
  root: string;
  signal?: AbortSignal;
}

/**
 * Pure resolver + ensure chain. All side effects go through `runner`, so this
 * file is testable with a fake runner (see `test/ensure.test.ts`).
 *
 * Locks (all session-scoped to this `createZg` instance):
 *   - `installP`   — at most one in-flight install; concurrent callers share it.
 *   - `buildP`     — at most one in-flight `zg --index` build per session.
 *   - `serverStarted` — `zg --server on` fires exactly once after first successful build.
 *
 * The session-scoped `failedRoots` memo prevents silent rebuild loops when a
 * build legitimately fails (offline machine, broken repo): the second probe
 * surfaces the original `zg --status` text instead of starting another doomed
 * build. The retry-on-cold-start path is one attempt per root per session.
 */
// `zg --index` argv after the flag. The root is always explicit: a bare
// `zg --index` targets the nearest ancestor index, which may belong to a parent
// folder rather than this repo. A first build across a repo boundary also
// forces `--mode direct`: with zg 0.2.2 the daemon (auto/server modes) resolved
// the requested root back to the ancestor's workspace and rebuilt that instead.
// zg 0.3.0 no longer does — `zg --index <child>` with the daemon running builds
// at the child (test/fixtures/NOTES.md, finding b) — but the direct transport
// stays because it costs nothing and cannot be redirected by a stale daemon.
// Once the repo has its own index, the nearest lookup finds it and later builds
// go through the daemon as usual.
export const boundaryBuildArgs = (plan: WorkspacePlan): string[] =>
  plan.trustStatus ? [plan.buildRoot] : [plan.buildRoot, "--mode", "direct"];

export const createZg = (runner: Runner, opts: ZgOpts) => {
  let installP: Promise<unknown> | undefined;
  let buildP: Promise<unknown> | undefined;
  let serverStarted = false;
  const failedRoots = new Set<string>();

  // The version gate lives in the runner's probe (a 0.2.x binary must never
  // receive 0.3.0 flags), so a successful probe means "usable binary". The
  // rejection detail, when there is one, comes from runner.probeIssue().
  const probeAndVersion = async (): Promise<boolean> =>
    (await runner.probe()) !== null;

  const rejected = (): string => {
    const issue = runner.probeIssue?.();
    return issue === undefined || issue.length === 0 ? "" : `\n${issue}`;
  };

  // Returns nothing on purpose: the resolved path already lives in the
  // runner (probedBin / version()), and every caller discarded the old
  // `{ bin }` wrapper.
  const ensureBinary = async (): Promise<void> => {
    if (await probeAndVersion()) {
      return;
    }
    // PI_ZG_BIN set-but-unusable → error naming the var, NO fallback to PATH or
    // install. User explicitly chose this path; silent fallback would surprise
    // them. (spec § Components L57)
    if (nonEmpty(opts.env?.PI_ZG_BIN)) {
      throw new Error(
        `PI_ZG_BIN=${opts.env?.PI_ZG_BIN} is set but zg is not usable there. Fix the path or unset PI_ZG_BIN.${rejected()}`
      );
    }
    // PI_ZG_AUTO_INSTALL non-empty → skip install; surface the exact manual
    // command so the user can run it themselves.
    if (nonEmpty(opts.env?.PI_ZG_AUTO_INSTALL)) {
      throw new Error(
        `zg is not installed. Install it with: npm install -g @zvec/zvec-grep${rejected()}`
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
    if (!(await probeAndVersion())) {
      throw new Error(
        "zg install finished but the binary is still not on PATH. Try: npm install -g @zvec/zvec-grep"
      );
    }
  };

  // `rebuild` is set when the status probe reported "rebuild required": an
  // index from a pre-0.3.0 zg under <root>/.zvec-grep is unreadable by 0.3.0,
  // and a plain `zg --index` then fails with "This index is incompatible with
  // the current version of zg" instead of upgrading. `--index --rebuild` is the
  // upstream recovery (zg-cli implicit_index tests), so ride it automatically
  // once. `newIndex` is true only when zg reported no index at all, which is the
  // one case that must name an embedding model (see buildIndexArgs).
  const runBuild = async (
    buildArgs: string[],
    rebuild: boolean,
    newIndex = false,
    hooks: Pick<ZgOpts, "signal" | "onUpdate"> = {}
  ): Promise<void> => {
    // F2: buffer the last ~10 progress lines so a failed build can surface
    // zg's own output instead of pointing the user at `zg --status`. Every
    // line still forwards to opts.onUpdate verbatim.
    const TAIL_MAX = 10;
    const tail: string[] = [];
    const userOnUpdate = hooks.onUpdate ?? opts.onUpdate;
    const wrappedOnUpdate = userOnUpdate
      ? (s: string): void => {
          tail.push(s);
          if (tail.length > TAIL_MAX) {
            tail.shift();
          }
          userOnUpdate(s);
        }
      : undefined;
    // `newIndex` names the embedding model for a workspace that has no index
    // yet; refreshes and --rebuild keep the model the index already stores.
    // See buildIndexArgs in args.ts.
    const extra = rebuild ? [...buildArgs, "--rebuild"] : buildArgs;
    const res = await runner.stream(
      buildIndexArgs(extra, {
        env: opts.env,
        newIndex: !rebuild && newIndex,
      }),
      {
        cwd: opts.root,
        onUpdate: wrappedOnUpdate,
        signal: hooks.signal ?? opts.signal,
      }
    );
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

  // Daemon start, at most once per chain (session + root). `zg --server on` is
  // idempotent (prints ready, same pid), replaces a leftover 0.2.x daemon
  // (which cannot serve a 0.3.0 client), and upstream enforces one instance
  // per home via the fixed listen port, so attempts from other sessions are
  // harmless no-ops.
  const startServerOnce = (): void => {
    if (serverStarted || nonEmpty(opts.env?.PI_ZG_SERVER)) {
      return;
    }
    serverStarted = true;
    void startServerFireAndForget();
  };

  const ensureIndex = async (
    hooks: Pick<ZgOpts, "signal" | "onUpdate"> = {}
  ): Promise<{ error?: string }> => {
    hooks.signal?.throwIfAborted();
    const plan = planWorkspace(opts.root, { exists: opts.exists });
    const st = runner.probeStatus
      ? await runner.probeStatus()
      : await runner.run(buildStatusArgs());
    // A ready status from a parent folder's index (across a repo boundary)
    // says nothing about this repo: build its own index instead.
    if (st.code === 0 && plan.trustStatus) {
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
    // failed → don't loop. Surface the verbatim `zg --status` text (or stderr)
    // so the user sees what zg actually said (offline → embedding-model
    // download failure, broken repo → indexer error, etc. — spec § L85, § L87).
    if (failedRoots.has(opts.root)) {
      return {
        error: `zg index is not ready (previous build attempt failed). zg --status said: ${st.stdout || st.stderr}`,
      };
    }
    if (isUnsafeAutoIndexRoot(plan.buildRoot, opts.home)) {
      return {
        error: `not auto-indexing ${plan.buildRoot}: it is a home directory or filesystem root, and an index there would capture every folder below it. Use mode=rg here, start pi inside a project folder, or run /zg-index to index it on purpose.`,
      };
    }
    // An index from a pre-0.3.0 zg is unreadable by 0.3.0: `--status` reports
    // "rebuild required" in the Coverage note and both `--index` and every
    // indexed query refuse until it is rebuilt.
    const status = parseStatusOutput(st.stdout);
    const freshness = "raw" in status ? undefined : status.freshness;
    const needsRebuild = freshness === "rebuild required";
    // No index at all (fresh workspace, no configured model): the build must be
    // told which model to use, otherwise a bare `--index` has nothing to
    // resolve and every query answers [ZG.ENGINE.NOT_FOUND] instead of
    // searching (crates/zg/src/main.rs:620-625 refuses to auto-create it).
    const newIndex = isNewIndexState(freshness);
    // Synchronously assign buildP before any await so concurrent riders see
    // it set and join the in-flight build instead of falling into the
    // failedRoots memo branch above. failedRoots is mutated only inside the
    // wrapper — after the build has actually settled.
    buildP = (async (): Promise<unknown> => {
      try {
        await runBuild(boundaryBuildArgs(plan), needsRebuild, newIndex, hooks);
        startServerOnce();
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

  return { ensureBinary, ensureIndex, startServerOnce };
};
