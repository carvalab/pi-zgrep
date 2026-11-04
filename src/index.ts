// pi-zg: extension factory. Wraps the zg (zvec-grep) CLI as a single tool
// ("zg") plus three commands (/zg-index, /zg-status, /zg-server) and opt-out
// prompt guidelines that steer the agent toward zg for code/content search.
//
// File layout:
//   - args.ts      → CLI arg builders (pure)
//   - parse.ts     → output parsers (pure, fixture-tripwired)
//   - tool.ts      → argument repair, model text, truncation, renderers
//   - workspace.ts → which index a cwd belongs to (ancestor-index guard)
//   - zg.ts        → ensure chain (pure, testable with a fake runner)
//   - index.ts     → this file: the real Runner + extension factory
//
// The Runner interface (from ./zg.ts) is the contract; the real impl
// below owns process lifecycle, signal wiring, and the npm/bun install
// retry dance.
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "cross-spawn";
import { Type } from "typebox";
import type { Static } from "typebox";

import {
  buildIndexArgs,
  buildQueryArgs,
  buildStatusArgs,
  isNewIndexState,
  nonEmpty,
  parseIndexCommandArgs,
  validateQueryInput,
} from "./args.ts";
import { parseQueryOutput, parseStatusOutput } from "./parse.ts";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  ZgOutputSchema,
  formatQueryText,
  prepareZgArguments,
  renderCallText,
  renderResultText,
  toStructured,
  truncateForModel,
} from "./tool.ts";
import type { RenderableResult, ZgToolDetails } from "./tool.ts";
import { isUnsafeAutoIndexRoot, planWorkspace } from "./workspace.ts";
import { createZg } from "./zg.ts";
import type { RunResult, Runner } from "./zg.ts";

const PROBE_TIMEOUT_MS = 10_000;

// --- Local engine resolution (files, not lifecycle scripts) -----------------

// 0.3.0 rewrote the engine in Rust: the package is a shell around a native
// binary with no `main`, no `exports`, and no JS entry, so findPackageJSON()
// cannot locate it and nothing here may run it through `node`. The payload
// lives in per-platform optional dependencies
// (@zvec/zvec-grep-<os>-<arch>[-<libc>], listed in the meta package's
// platforms.json); install.cjs copies it to bin/zg.exe, but npm 12 blocks
// dependency postinstalls by default (RFC 0054) and pi's installer does not
// opt in — bin/zg.exe is then a shell stub that prints "native binary was not
// materialized" and exits 1. So resolve the platform package in place, verify
// its payload against the shipped checksums.json, and run that binary.
// Order: PI_ZG_BIN (see makeRunner) → platform package → a materialized
// bin/zg.exe that really is a native executable → `zg` on PATH.
const ENGINE_PACKAGE = "@zvec/zvec-grep";
const ENGINE_META_BINARY = path.join("bin", "zg.exe");
const ENGINE_HINT =
  "Reinstall @zvec/zvec-grep without --omit=optional so the per-platform native package lands next to it (npm install @zvec/zvec-grep), or set PI_ZG_BIN.";

interface PlatformEntry {
  binary: string;
  cpu: string;
  libc?: string;
  os: string;
  package: string;
  target: string;
}

export interface LocalEngine {
  // Absolute path to a verified native binary, or null when the packaged
  // engine is absent or unusable (caller falls back to PATH / global install).
  cli: string | null;
  // Why the packaged engine was skipped, for /zg-status and install failures.
  problems: string[];
}

export interface EngineTarget {
  arch?: string;
  libc?: "glibc" | "musl";
  platform?: string;
}

// Lean mirror of install.cjs selectPlatform (install.cjs:454-467): linux
// entries are libc-tagged, everything else is not.
const selectPlatformEntry = (
  platforms: PlatformEntry[],
  platform: string,
  arch: string,
  libc: "glibc" | "musl"
): PlatformEntry | null => {
  const matches = platforms.filter(
    (entry) =>
      entry.os === platform &&
      entry.cpu === arch &&
      (entry.libc === undefined || entry.libc === libc)
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

// glibc vs musl via the same signal install.cjs reads: a musl host reports no
// glibcVersionRuntime.
const detectLibc = (): "glibc" | "musl" => {
  try {
    const report = process.report?.getReport?.() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    if (report?.header?.glibcVersionRuntime) {
      return "glibc";
    }
  } catch {
    // No report available; fall through to the conservative answer.
  }
  return "musl";
};

// Executable magic: ELF, PE, and the three Mach-O flavours. The 0.3.0 install
// stub is a /bin/sh script, so this is the cheapest reliable "is this really
// the engine?" check.
const NATIVE_MAGIC = new Set([
  "7f454c46",
  "4d5a",
  "feedface",
  "cefaedfe",
  "cafebabe",
  "bebafeca",
]);

const isNativeExecutable = (file: string): boolean => {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(4);
    const read = readSync(fd, buf, 0, 4, 0);
    return read === 4 && NATIVE_MAGIC.has(buf.toString("hex"));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
};

const ensureExecutable = (file: string, mode: number): void => {
  // Any execute bit set? (Bitwise operators are lint-banned, so mask by
  // division: the exec bits are bits 6-8, i.e. mode / 0o100 mod 8.)
  const execBits = Math.floor(mode / 0o100) % 8;
  if (process.platform === "win32" || execBits !== 0) {
    return;
  }
  // Some archives lose the exec bit; the package dir is ours to fix.
  try {
    chmodSync(file, 0o755);
  } catch {
    // spawn() will surface EACCES and probe() falls back to PATH.
  }
};

const sha256 = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

// Verify a platform payload against its checksums.json (install.cjs
// verifyPayload, install.cjs:101-123), then hand back the path.
const verifyPlatformBinary = (
  platformDir: string,
  entry: PlatformEntry
): { cli: string } | { problem: string } => {
  const cli = path.join(platformDir, "bin", entry.binary);
  if (!existsSync(cli)) {
    return { problem: `${entry.package} has no bin/${entry.binary}` };
  }
  let expected: { bytes?: number; sha256?: string } | undefined;
  try {
    const checksums = JSON.parse(
      readFileSync(path.join(platformDir, "checksums.json"), "utf-8")
    ) as { files?: Record<string, { bytes?: number; sha256?: string }> };
    expected = checksums.files?.[`bin/${entry.binary}`];
  } catch {
    return { problem: `${entry.package} ships no readable checksums.json` };
  }
  if (
    expected === undefined ||
    !Number.isSafeInteger(expected.bytes) ||
    typeof expected.sha256 !== "string"
  ) {
    return {
      problem: `${entry.package} checksums.json does not describe bin/${entry.binary}`,
    };
  }
  const metadata = statSync(cli);
  if (metadata.size !== expected.bytes || sha256(cli) !== expected.sha256) {
    return {
      problem: `${entry.package} bin/${entry.binary} failed checksum verification — reinstall it`,
    };
  }
  ensureExecutable(cli, metadata.mode);
  return { cli };
};

// findPackageJSON() needs a resolvable entry, which @zvec/zvec-grep no longer
// has: walk node_modules explicitly instead (hoisted and nested layouts).
const findPackageDir = (fromDir: string, name: string): string | null => {
  const parts = name.split("/");
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...parts);
    if (existsSync(path.join(candidate, "package.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
};

const readPlatforms = (metaDir: string): PlatformEntry[] | null => {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(metaDir, "platforms.json"), "utf-8")
    );
    return Array.isArray(parsed) ? (parsed as PlatformEntry[]) : null;
  } catch {
    return null;
  }
};

export const resolveLocalEngine = (
  fromDir: string,
  target: EngineTarget = {}
): LocalEngine => {
  const problems: string[] = [];
  const metaDir = findPackageDir(fromDir, ENGINE_PACKAGE);
  if (metaDir === null) {
    return { cli: null, problems };
  }

  const platform = target.platform ?? process.platform;
  const arch = target.arch ?? process.arch;
  const libc = target.libc ?? (platform === "linux" ? detectLibc() : "glibc");
  const platforms = readPlatforms(metaDir);
  if (platforms !== null) {
    const entry = selectPlatformEntry(platforms, platform, arch, libc);
    if (entry === null) {
      const suffix = platform === "linux" ? `-${libc}` : "";
      problems.push(
        `@zvec/zvec-grep publishes no native package for ${platform}-${arch}${suffix}`
      );
    } else {
      const platformDir = findPackageDir(fromDir, entry.package);
      if (platformDir === null) {
        problems.push(
          `${entry.package} is not installed (optional dependency omitted?)`
        );
      } else {
        const verified = verifyPlatformBinary(platformDir, entry);
        if ("cli" in verified) {
          return { cli: verified.cli, problems };
        }
        problems.push(verified.problem);
      }
    }
  }

  const metaBinary = path.join(metaDir, ENGINE_META_BINARY);
  if (existsSync(metaBinary)) {
    if (isNativeExecutable(metaBinary)) {
      ensureExecutable(metaBinary, statSync(metaBinary).mode);
      return { cli: metaBinary, problems };
    }
    problems.push(
      "@zvec/zvec-grep/bin/zg.exe is a placeholder — the native binary was never materialized (postinstall did not run)"
    );
  }
  return { cli: null, problems };
};

// Memoized for resolveBin (called on every spawn). The checksum pass reads
// ~50 MB, so it runs at most once per process; a dependency-less dev checkout
// (`pi -e .`) stays null for the session and falls through to PATH.
let localEngineCache: LocalEngine | undefined;
const localEngine = (): LocalEngine => {
  localEngineCache ??= resolveLocalEngine(import.meta.dirname);
  return localEngineCache;
};

// Actionable text when a packaged engine exists but cannot be used. Null when
// it resolved, or when nothing was installed at all — PATH/global install is
// then a perfectly normal state.
const localEngineProblem = (): string | null => {
  const { cli, problems } = localEngine();
  if (cli !== null || problems.length === 0) {
    return null;
  }
  return `local engine unusable: ${problems.join("; ")}. ${ENGINE_HINT}`;
};

// --- Guidance (opt-out via PI_ZG_GUIDANCE) ---------------------------------

// One-line entry for the system prompt's "Available tools" section; pi leaves
// custom tools out of that list when a tool has no snippet.
export const PROMPT_SNIPPET =
  "Search workspace code and content: semantic, BM25, hybrid, or ripgrep, auto-indexed";

// Bullets for the system prompt's guidelines section, added by pi only while
// the tool is active. Each one names zg, since pi lists them among the
// guidelines of every other tool.
export const guidanceLines = (): string[] => [
  "For code/content search, prefer the `zg` tool before grep/find. `zg` is a tool you call directly; there is no `zg` binary to run from a shell.",
  "zg modes: hybrid (default) for intent or natural-language questions; fts for known symbols/identifiers; vector for paraphrases; rg for exact literal/regex.",
  "Fall back from zg to grep/find only when (1) zg returns zero results, (2) the zg tool errors, (3) results report possibly_stale for content just edited this session, or (4) the target is outside the indexed workspace.",
];

export const guidanceText = (): string => guidanceLines().join("\n");

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

// `/zg-status` daemon line. `serverStatus` is the buffered `zg --server status`
// spawn (null when the spawn itself failed). zg owns the daemon lifecycle;
// this only surfaces its state and degrades to a start hint.
export const formatDaemonLine = (
  serverStatus: { code: number; stderr?: string; stdout: string } | null
): string => {
  const start = "start it with /zg-server on";
  if (!serverStatus || serverStatus.code !== 0) {
    // A 0.2.x daemon keeps the port and cannot serve a 0.3.0 client; upstream
    // asks for `zg --server on` with the same --home, which /zg-server on does.
    if (serverStatus?.stderr?.includes("legacy zvec-grep daemon") === true) {
      return "daemon: legacy 0.2.x daemon running — /zg-server on replaces it";
    }
    return `daemon: not ready — ${start}`;
  }
  const state =
    serverStatus.stdout
      .match(/^Server:\s*(?<state>.+)$/mu)
      ?.groups?.state?.trim() ?? "ready";
  if (state !== "ready") {
    // plain `zg --server status` exits 0 even when stopped — the state text
    // is the only signal.
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

// Spawn failures that mean "this path is not an executable binary": missing
// (ENOENT), not executable (EACCES), and a non-binary payload such as the
// 0.3.0 "native binary was not materialized" shell stub (ENOEXEC). All three
// must degrade to the next candidate instead of throwing.
const UNRUNNABLE_CODES = new Set(["ENOENT", "EACCES", "ENOEXEC"]);

const isUnrunnable = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  UNRUNNABLE_CODES.has(String((error as { code: unknown }).code));

// zg 0.3.0 is the floor: 0.2.x had subcommands (query/index/status/server) and
// this extension now emits rg-style flags, so an older binary must never be
// executed. Mirrors the upstream version line ("0.3.0", optionally prefixed).
const MIN_SUPPORTED_VERSION: readonly number[] = [0, 3, 0];
const VERSION_NUMBER = /(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?/u;

const parseVersion = (text: string): number[] | null => {
  const m = VERSION_NUMBER.exec(text);
  if (!m?.groups) {
    return null;
  }
  return [
    Number(m.groups.major),
    Number(m.groups.minor),
    Number(m.groups.patch ?? 0),
  ];
};

const compareVersion = (a: readonly number[], b: readonly number[]): number => {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return 0;
};

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
  return winner[0] ?? -1;
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
  if (signal.aborted) {
    onAbort();
  }
  return (): void => {
    signal.removeEventListener("abort", onAbort);
  };
};

// --- Real Runner ------------------------------------------------------------

interface MakeRunnerOpts {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  onUpdate?: (s: string) => void;
  // Injectable bundled-engine resolver. Defaults to the memoized
  // resolveLocalEngine(import.meta.dirname); tests pass a hermetic resolver
  // (usually `() => null`) so a probe never reaches this repo's own
  // node_modules and a unit test can never run a real `zg --index`.
  resolveEngine?: () => LocalEngine | null;
  signal?: AbortSignal;
}

export const makeRunner = (opts: MakeRunnerOpts): Runner => {
  let probedBin: string | undefined;
  // F7: closure-scoped version cache populated by probe. createZg's
  // probeAndVersion uses runner.version?.() to skip the redundant
  // `--version` spawn (probe already paid for it).
  let versionLine: string | undefined;
  // Bundled engine for this runner: the injected resolver in tests, otherwise
  // the memoized resolveLocalEngine(import.meta.dirname). Null means "no
  // packaged engine" (dependency-less dev checkout, omitted optional deps).
  const engine = (): LocalEngine | null =>
    opts.resolveEngine ? opts.resolveEngine() : localEngine();

  // Pre-probe fallback only. probe() is the authority on which binary may run:
  // it gates every candidate on `--version` and caches the winner in
  // probedBin, which every later spawn reuses. The order here mirrors
  // candidates(): PI_ZG_BIN (exclusive) → bundled engine → `zg` on PATH.
  const resolveBin = (): string =>
    nonEmpty(opts.env?.PI_ZG_BIN)
      ? (opts.env?.PI_ZG_BIN as string)
      : (engine()?.cli ?? "zg");

  const startProcess = (
    bin: string,
    args: string[],
    o?: { cwd?: string; detached?: boolean; stdio?: "ignore" }
  ): ChildProcess => {
    // The packaged engine (and a globally installed one) is a native executable
    // and is spawned directly. Only a PI_ZG_BIN override that names a JS file is
    // run through the current node, so a fake engine in tests needs no exec bit
    // or shebang. cross-spawn resolves Windows .cmd shims (npm, bun).
    const [cmd, argv] = /\.[cm]?js$/iu.test(bin)
      ? [process.execPath, [bin, ...args]]
      : [bin, args];
    return spawn(cmd, argv, {
      cwd: o?.cwd ?? opts.cwd,
      detached: o?.detached,
      env: opts.env,
      shell: false,
      stdio: o?.stdio,
      windowsHide: true,
    });
  };

  // Every candidate the extension may execute. PI_ZG_BIN is EXCLUSIVE: when it
  // is set, it is the only candidate, so an explicit path that turns out to be
  // missing, not executable, the install stub, or older than 0.3.0 fails loudly
  // instead of silently running a binary the user did not pick (contract:
  // src/zg.ts:126-145). Without it: bundled platform binary → `zg` on PATH, both
  // gated on the version floor inside probe().
  const candidates = (): string[] => {
    const override = opts.env?.PI_ZG_BIN;
    if (nonEmpty(override)) {
      return [override as string];
    }
    const list: string[] = [];
    const bundled = engine()?.cli;
    if (typeof bundled === "string" && bundled.length > 0) {
      list.push(bundled);
    }
    list.push("zg");
    return [...new Set(list)];
  };

  let probeIssue: string | undefined;

  // One `--version` spawn. Returns raw stdout, or null when the binary cannot
  // run at all (absent, not executable, placeholder script).
  const readVersion = async (bin: string): Promise<string | null> => {
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
      const [code, stdout] = await Promise.all([
        awaitChild(child),
        collectStream(child.stdout),
      ]);
      if (timedOut) {
        throw new Error("zg --version timed out after 10s");
      }
      return code === 0 ? stdout : null;
    } catch (error) {
      if (isUnrunnable(error)) {
        return null;
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  // 0.3.0 rewrote the CLI (subcommands became flags), so a 0.2.x binary on PATH
  // or in PI_ZG_BIN is a live upgrade hazard for existing users. Every candidate
  // is gated on `--version`; an older one is skipped rather than fed 0.3.0
  // flags, and probeIssue names each candidate it rejected with the version it
  // found.
  const probe = async (): Promise<string | null> => {
    // Cached winner: probe() gates once and every later spawn reuses probedBin,
    // so a second call must not pay another `--version` spawn. A failed probe
    // leaves probedBin undefined (probeIssue is sticky), so a retry after
    // install or after the user fixes PI_ZG_BIN still re-probes.
    if (probedBin !== undefined) {
      return probedBin;
    }
    const rejected: string[] = [];
    for (const bin of candidates()) {
      // Sequential on purpose: candidates are a preference order, and the first
      // one that runs and reports >= 0.3.0 wins.
      // oxlint-disable-next-line no-await-in-loop
      const stdout = await readVersion(bin);
      if (stdout === null) {
        rejected.push(
          `${bin} (not runnable: missing, not executable, install stub, or failed on --version)`
        );
        continue;
      }
      const [first] = stdout.trim().split("\n", 1);
      const found = parseVersion(first);
      if (found === null) {
        rejected.push(`${bin} (unrecognized version ${JSON.stringify(first)})`);
        continue;
      }
      if (compareVersion(found, MIN_SUPPORTED_VERSION) < 0) {
        rejected.push(
          `${bin} (${found.join(".")} — zg ${MIN_SUPPORTED_VERSION.join(".")} or newer is required)`
        );
        continue;
      }
      probedBin = bin;
      versionLine = first.length > 0 ? first : undefined;
      probeIssue = undefined;
      return bin;
    }
    probeIssue =
      rejected.length > 0
        ? `no usable zg binary: ${rejected.join("; ")}`
        : undefined;
    return null;
  };

  // Optional accessor for the version line probe() cached, so /zg-status can
  // show it without paying a second `--version` spawn.
  const version = (): string | undefined => versionLine;

  // Diagnoses for the last failed probe (version gate, unrunnable binaries).
  const issue = (): string | undefined => probeIssue;

  const run = (args: string[]): Promise<RunResult> => {
    opts.signal?.throwIfAborted();
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
    o?.signal?.throwIfAborted();
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
        const [code] = await Promise.all([
          awaitChild(child),
          linesP,
          o?.onUpdate && child.stderr
            ? forwardLines(child.stderr, o.onUpdate)
            : collectStream(child.stderr),
        ]);
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
    // npm and bun are .cmd shims on Windows; startProcess resolves them.
    const child = startProcess(bin, cmdArgs);
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
    // 0.3.0 ships no JS entry: the CLI is the native binary from the
    // per-platform optional dependency, so a plain `npm install -g` is enough
    // and lifecycle scripts are irrelevant. Never add --ignore-scripts or
    // --omit=optional here — either one leaves the install without an engine
    // (the 0.2.x sharp workaround is gone; sharp is no longer a dependency).
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
    const detail = r1.stderr.trim();
    throw new Error(
      `Install failed. Run manually: npm install -g @zvec/zvec-grep (keep optional dependencies enabled: the native engine ships in @zvec/zvec-grep-<platform>-<arch>).${detail.length > 0 ? `\nnpm said: ${detail}` : ""}`
    );
  };

  const startServer = (): Promise<void> => {
    const bin = probedBin ?? resolveBin();
    try {
      // Detach + ignore stdio so `zg --server on` survives pi's process group
      // (Ctrl+C / terminal close). unref() lets the parent exit cleanly while
      // the daemon keeps running. This is the only spawn in the runner that
      // detaches; probe/run/stream stay attached to their parent. `--server on`
      // is also the documented way to replace a still-running 0.2.x daemon, so
      // warmup doubles as migration.
      const child = startProcess(bin, ["--server", "on"], {
        detached: true,
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

  return {
    install,
    probe,
    probeIssue: issue,
    run,
    startServer,
    stream,
    version,
  };
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

const ZgToolParams = Type.Object({
  glob: Type.Optional(
    Type.String({
      description: "Path glob to include, e.g. src/**; prefix ! to exclude",
    })
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Maximum results (default ${DEFAULT_LIMIT})`,
      maximum: MAX_LIMIT,
      minimum: 1,
    })
  ),
  mode: Type.Optional(
    Type.Union([
      Type.Literal("hybrid"),
      Type.Literal("fts"),
      Type.Literal("vector"),
      Type.Literal("rg"),
    ])
  ),
  preview: Type.Optional(
    Type.Union([Type.Literal("short"), Type.Literal("none")], {
      description: "Snippet size for indexed modes (default short)",
    })
  ),
  query: Type.String({
    description:
      "Search query (natural language, symbol, or regex for mode=rg)",
    minLength: 1,
  }),
  refresh: Type.Optional(
    Type.Union([Type.Literal("auto"), Type.Literal("wait")], {
      description:
        "wait = refresh the index before an indexed query (use after edits)",
    })
  ),
  type: Type.Optional(
    Type.String({ description: "ripgrep file type, e.g. ts, py" })
  ),
});

// --- Commands ---------------------------------------------------------------

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

// pi invalidates the event ctx when the session ends/reloads; any ui call
// after that throws "This extension ctx is stale" and, in print mode, an
// uncaught throw kills the process. Async work started from a ctx (warmup,
// long builds, multi-spawn status probes) can outlive it, so those paths go
// through this best-effort wrapper.
export const safeUi = (ctx: { ui: WarmupUi }): WarmupUi => ({
  notify: (message, type) => {
    try {
      ctx.ui.notify(message, type);
    } catch {
      // stale ctx — the session that owned it is gone.
    }
  },
  setStatus: (key, text) => {
    try {
      ctx.ui.setStatus(key, text);
    } catch {
      // stale ctx — the session that owned it is gone.
    }
  },
});

// Palette hints for command arguments (pi filters by the typed prefix and
// falls back to null when nothing matches). The /zg-index list is the common
// `zg --index` flags, not the full surface — the command stays passthrough.
// 0.3.0 has no `--yes`: `--drop` runs immediately without a prompt.
const ZG_SERVER_VERBS = ["on", "off", "status"];
const ZG_INDEX_FLAGS = [
  "--rebuild",
  "--drop",
  "--debug",
  "--mode",
  "--embedding",
  "--device",
  "--model-cache",
  "--allow-remote",
  "--glob",
  "--type",
];

// /zg-index: does this build start from nothing? Only then does it need an
// explicit embedding model (see buildIndexArgs in args.ts) — a refresh of an
// existing index must keep its stored model. A user-supplied --embedding,
// --rebuild or --drop already answers the question; otherwise ask
// `zg --status --check-ready`, the same signal ensureIndex uses.
const indexBuildStartsFresh = async (
  extra: string[],
  runner: Runner
): Promise<boolean> => {
  if (
    extra.some((a) => a === "--embedding" || a.startsWith("--embedding=")) ||
    extra.includes("--rebuild") ||
    extra.includes("--drop")
  ) {
    return false;
  }
  try {
    const st = await runner.run(buildStatusArgs());
    if (st.code === 0) {
      return false;
    }
    const status = parseStatusOutput(st.stdout);
    return isNewIndexState("raw" in status ? undefined : status.freshness);
  } catch {
    // A failed probe must not turn /zg-index into a different command.
    return false;
  }
};
const completeFrom =
  (values: string[]) =>
  (prefix: string): { value: string; label: string }[] | null => {
    const items = values
      .filter((v) => v.startsWith(prefix))
      .map((v) => ({ label: v, value: v }));
    return items.length > 0 ? items : null;
  };

export const registerZgIndexCommand = (pi: ExtensionAPI): void => {
  pi.registerCommand("zg-index", {
    description:
      "Build or update the zg index for the current workspace. Forwards arguments to `zg --index` (e.g. --rebuild, --drop, --debug, --embedding). For index status use /zg-status.",
    getArgumentCompletions: completeFrom(ZG_INDEX_FLAGS),
    handler: async (args, ctx) => {
      const started = Date.now();
      // safeUi: a build can outlive a session reload/newSession, and an
      // uncaught stale-ctx throw here would kill the process.
      const ui = safeUi(ctx);
      // F6: the runner-level onUpdate wrapper was dead here — /zg-index
      // never installs, so opts.onUpdate is never invoked. Fold setStatus
      // into streamOnUpdate so each build-progress line surfaces live.
      const parsed = parseIndexCommandArgs(args, (p) =>
        existsSync(path.resolve(ctx.cwd, p))
      );
      if (!parsed.ok) {
        // Don't spawn a doomed build: bare words that aren't existing paths
        // (e.g. "status") die upstream as
        // `Error[ZG.ENGINE.NOT_FOUND]: resolve directory …` with exit 1.
        ui.notify(
          "Usage: /zg-index [--rebuild | --drop | <zg --index flags> | <workspace path>]. For index status use /zg-status (or run `zg --status` in bash).",
          "error"
        );
        ui.setStatus("pi-zg", undefined);
        return;
      }
      const runner = makeRunner({ cwd: ctx.cwd, env: process.env });
      // Gate on --version first, exactly like /zg-server: every spawn below
      // (`--status --check-ready`, `--index`) is a 0.3.0 flag, and a 0.2.x
      // binary on PATH (dev checkout, `pi -e .`) would read it as a query.
      // Probe before the status line so a rejected binary never leaves
      // "indexing…" on screen.
      if ((await runner.probe()) === null) {
        ui.notify(
          [localEngineProblem(), runner.probeIssue?.()]
            .filter((line) => line !== undefined && line !== null)
            .join("\n") ||
            "zg binary not found — it installs on next /zg-index or zg tool use",
          "error"
        );
        return;
      }
      ui.setStatus("pi-zg", "indexing…");
      ui.notify("zg --index started", "info");
      const extra = parsed.args;

      // ponytail: /zg-index builds are unabortable and unlocked (command
      // ctx.signal is undefined while idle; two concurrent runs race) —
      // route through createZg if users hit this.

      // Tail buffer like runBuild in zg.ts: keep the last ~10 progress lines
      // so a failed build surfaces zg's own output in the failure notify.
      const TAIL_MAX = 10;
      const tail: string[] = [];
      const streamOnUpdate = (s: string): void => {
        ui.setStatus("pi-zg", s.slice(0, 80));
        tail.push(s);
        if (tail.length > TAIL_MAX) {
          tail.shift();
        }
      };

      try {
        const res = await runner.stream(
          buildIndexArgs(extra, {
            env: process.env,
            newIndex: await indexBuildStartsFresh(extra, runner),
          }),
          {
            cwd: ctx.cwd,
            onUpdate: streamOnUpdate,
          }
        );
        const duration = ((Date.now() - started) / 1000).toFixed(1);
        if (res.code === 0) {
          ui.notify(`zg --index finished in ${duration}s`, "info");
          return;
        }
        const tailText =
          tail.length > 0 ? `\nLast output:\n${tail.join("\n")}` : "";
        ui.notify(
          `zg --index failed (exit ${res.code}) in ${duration}s${tailText}`,
          "error"
        );
      } finally {
        // F5: install/build-progress status must clear even if the build
        // rejects (e.g. ENOENT, signal abort).
        ui.setStatus("pi-zg", undefined);
      }
    },
  });
};

const registerZgStatusCommand = (pi: ExtensionAPI): void => {
  pi.registerCommand("zg-status", {
    description: "Show zg index readiness and freshness",
    handler: async (_args, ctx) => {
      // Same triggered-then-result shape as /zg-index: without this the
      // command looks like a no-op until its three probes finish. safeUi
      // because the probe spawns can outlive a short print-mode session.
      const ui = safeUi(ctx);
      ui.setStatus("pi-zg", "checking zg status…");
      ui.notify("zg --status started", "info");
      try {
        const runner = makeRunner({ cwd: ctx.cwd, env: process.env });
        // Probe first: it runs `zg --version`, gates on >= 0.3.0, and caches the
        // version line. Every later spawn reuses the binary that passed, so
        // 0.3.0 flags can never reach a 0.2.x install. Probe failures (timeout,
        // unexpected spawn error) degrade to "not found".
        const binName = await runner.probe().catch(() => null);
        const versionFirstLine = runner.version?.() ?? null;
        if (binName === null) {
          const lines = [
            formatBinaryLine(null, null),
            localEngineProblem() ?? "",
            runner.probeIssue?.() ?? "",
            formatDaemonLine(null),
          ];
          ui.notify(lines.filter((line) => line.length > 0).join("\n"), "info");
          return;
        }
        let res: RunResult;
        try {
          res = await runner.run(buildStatusArgs());
        } catch {
          // F3: status call failed (spawn ENOENT, daemon crash, etc.) — emit
          // the not-found binary line and skip the index lines so the
          // handler never rejects.
          ui.notify(formatBinaryLine(null, null), "info");
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
          daemonStatus = await runner.run(["--server", "status"]);
        } catch {
          // daemon probe is best-effort; formatDaemonLine degrades to a hint.
        }
        lines.push(formatDaemonLine(daemonStatus));
        ui.notify(lines.join("\n"), "info");
      } finally {
        ui.setStatus("pi-zg", undefined);
      }
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
      // safeUi: `zg --server on/off` spawns and can outlive a reload.
      const ui = safeUi(ctx);
      const verb = rawArgs?.trim().split(/\s+/u)[0] ?? "";
      if (verb !== "on" && verb !== "off" && verb !== "status") {
        ui.notify("Usage: /zg-server [on|off|status]", "error");
        return;
      }
      const runner = makeRunner({ cwd: ctx.cwd, env: process.env });
      try {
        // Gate on --version first: `--server` is a 0.3.0 flag and a 0.2.x
        // binary would read it as a query.
        if ((await runner.probe()) === null) {
          ui.notify(
            [localEngineProblem(), runner.probeIssue?.()]
              .filter((line) => line !== undefined && line !== null)
              .join("\n") ||
              "zg binary not found — it installs on next /zg-index or zg tool use",
            "error"
          );
          return;
        }
        const res = await runner.run(["--server", verb]);
        if (verb === "status") {
          ui.notify(
            formatDaemonLine({
              code: res.code,
              stderr: res.stderr,
              stdout: res.stdout,
            }),
            "info"
          );
          return;
        }
        if (res.code === 0) {
          ui.notify(`zg --server ${verb}: done`, "info");
          return;
        }
        const detail = [res.stdout.trim(), res.stderr.trim()]
          .filter((s) => s.length > 0)
          .join("\n");
        ui.notify(
          `zg --server ${verb} failed (exit ${res.code})${detail ? `:\n${detail}` : ""}`,
          "error"
        );
      } catch {
        ui.notify(
          "zg binary not found — it installs on next /zg-index or zg tool use",
          "error"
        );
      }
    },
  });
};

const errorResult = (
  text: string
): {
  content: { text: string; type: "text" }[];
  details: ZgToolDetails;
  isError: true;
} => ({
  content: [{ text, type: "text" }],
  details: { isError: true },
  isError: true,
});

export const registerZgTool = (pi: ExtensionAPI): void => {
  pi.registerTool({
    // Searching never changes the user's files. It may write the gitignored
    // .zvec-grep/ index and start the local daemon, which a permission gate
    // should not prompt for. No network: embeddings are local by default.
    annotations: { openWorldHint: false, readOnlyHint: true },
    description:
      'Workspace code/content search. Call this tool directly — there is no `zg` binary to shell out to. USE THIS FIRST for code/content questions, before grep/find. Local-first semantic + BM25 + hybrid + ripgrep over the current workspace; excludes node_modules/, .git/, and build outputs; anything outside the workspace is NOT indexed — grep directly for those. Modes: hybrid (default) natural-language intent ("where are auth tokens read?"); fts exact symbols ("PackageUpdate"); vector paraphrases; rg literal/regex ("^export function check") only when fts misses. Fall back to bash grep only when: (1) zero results though the term must exist, (2) this tool errors, (3) result says possibly_stale after you edited it this session, (4) the target is outside the indexed workspace. Don\'t default to bash grep out of habit: a 2s zg call beats a 30s grep reflex. Output is capped at 2000 lines / 50KB; when cut, the full output path is given.',
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // pi's ToolExecutionComponent reads `result.content` unguarded on every
      // update (for image-block extraction), so partial payloads MUST include
      // `content: []` alongside the progress details.
      // F2: use the per-cwd cache so parallel tool calls on the same root
      // share one ensure-chain (install lock, build lock, failedRoots memo).
      // safeUi: the tool call can outlive a session reload (print mode,
      // newSession), and an uncaught stale-ctx throw kills the process.
      const ui = safeUi(ctx);
      const mode = params.mode ?? "hybrid";
      const limit = params.limit ?? DEFAULT_LIMIT;
      const progress = (s: string): void => {
        onUpdate?.({
          content: [],
          details: { mode, progress: s, query: params.query },
        });
      };
      const chain = getOrCreateZg({
        cwd: ctx.cwd,
        env: process.env,
        makeRunner: (): Runner =>
          makeRunner({
            cwd: ctx.cwd,
            env: process.env,
            onUpdate: (s: string): void => {
              progress(s);
              // F4: surface install progress on the status bar; cleared once
              // ensureBinary returns. Build progress flows through the same
              // onUpdate channel via createZg, but build uses ctx.ui.setStatus
              // only in the /zg-index command path — the tool path doesn't
              // overwrite this status mid-build because the createZg onUpdate
              // below deliberately omits setStatus.
              ui.setStatus("pi-zg", s.slice(0, 80));
            },
          }),
        onUpdate: progress,
      });
      const { zg } = chain;
      // The ensure-chain is shared; query cancellation belongs to this call.
      const runner = makeRunner({ cwd: ctx.cwd, env: process.env, signal });

      const input = {
        glob: params.glob,
        limit,
        mode,
        preview: params.preview ?? "short",
        query: params.query,
        refresh: params.refresh,
        type: params.type,
      };
      // F3 (b/d): guard before we shell out (and before any install or
      // build) so the agent sees a clear tool error instead of an upstream
      // "missing: --limit, 1" parse failure. Schema minLength: 1 already
      // covers empty query at the type level; the guard covers the
      // leading-dash cases TypeBox can't express.
      try {
        validateQueryInput(input);
      } catch (error) {
        return errorResult(`zg error: ${(error as Error).message}`);
      }

      try {
        await zg.ensureBinary();
      } catch (error) {
        // A packaged engine that exists but cannot run (placeholder stub,
        // checksum mismatch, no platform package) is the common install
        // failure; name the cause instead of only "not installed".
        const problem = localEngineProblem();
        const { message } = error as Error;
        return errorResult(
          problem ? `zg error: ${message}\n${problem}` : `zg error: ${message}`
        );
      } finally {
        // F5: install-progress status must clear even when ensureBinary
        // throws (ENOENT, install failure, PI_ZG_BIN misconfig).
        ui.setStatus("pi-zg", undefined);
      }

      if (mode !== "rg") {
        const idx = await zg.ensureIndex({ onUpdate: progress, signal });
        if (idx.error) {
          return errorResult(`zg error: ${idx.error}`);
        }
      }

      const res = await runner.run(buildQueryArgs(input));
      if (res.code !== 0) {
        return errorResult(
          `zg error (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim() || "query failed"}`
        );
      }
      const parsed = parseQueryOutput(res.stdout);
      const body = formatQueryText(parsed, { limit, mode });
      const out = await truncateForModel(body);
      const details: ZgToolDetails = {
        fullOutputPath: out.fullOutputPath,
        mode,
        query: params.query,
        truncated: out.truncated,
        ...("raw" in parsed
          ? { raw: parsed.raw }
          : { results: parsed.results }),
      };
      return {
        content: [{ text: out.text, type: "text" }],
        details,
        structuredContent: toStructured(parsed, out.truncated),
      };
    },
    label: "zg",
    name: "zg",
    outputSchema: ZgOutputSchema,
    parameters: ZgToolParams,
    prepareArguments: (args) =>
      prepareZgArguments(args) as Static<typeof ZgToolParams>,
    promptGuidelines: shouldInjectGuidance(process.env)
      ? guidanceLines()
      : undefined,
    promptSnippet: PROMPT_SNIPPET,
    renderCall: (args, theme) => new Text(renderCallText(args, theme), 0, 0),
    renderResult: (result, options, theme) =>
      new Text(
        renderResultText(result as RenderableResult, options, theme),
        0,
        0
      ),
  });
};

// --- Session-start warmup ---------------------------------------------------

// Kick the ensure-chain in the background at session start so the first zg
// query hits a ready index. Resource guarantees (user requirement: one build,
// one server, nothing heavy on startup):
//   - probe-only: binary missing → bail silently. No background npm install;
//     that stays on first tool use, exactly as before.
//   - one build per process: the per-cwd chainCache shares buildP, so a
//     warmup racing the first tool call joins the same build.
//   - one daemon: every session attempts `zg --server on` once (idempotent;
//     upstream enforces a single instance per home via the fixed port), so
//     a daemon from a previous session is reused and a dead one revives at
//     startup instead of staying down until the next build.
// ponytail: locks are per-process — two pi windows on the same cold repo can
// race two `zg --index` runs; upstream tolerates concurrent builds. Split a
// cross-process lock only if that ever misbehaves.
export const sessionWarmup = async (
  ctx: WarmupCtx,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
  // Injectable bundled-engine resolver, same contract as makeRunner's. Tests
  // pass `() => null` so warmup never probes this repo's node_modules and never
  // runs a real `zg --index` against a scratch directory.
  resolveEngine?: () => LocalEngine | null,
  // Aborted by the next session_start or by session_shutdown (see
  // registerSessionWarmup). The warmup outlives the ctx that started it, so a
  // reload must be able to stop the build instead of leaving it running.
  signal?: AbortSignal
): Promise<void> => {
  // A session that is already gone wants no spawn and no status line.
  if (signal?.aborted) {
    return;
  }
  const ui = safeUi(ctx);
  const onProgress = (s: string): void => {
    if (!signal?.aborted) {
      ui.setStatus("pi-zg", s.slice(0, 80));
    }
  };
  const chain = getOrCreateZg({
    cwd: ctx.cwd,
    env,
    makeRunner: (): Runner =>
      makeRunner({ cwd: ctx.cwd, env, onUpdate: onProgress, resolveEngine }),
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
    // pi opened in ~ or / with no index: nothing to warm, and the ensure
    // chain would refuse the build anyway. Skip quietly rather than show an
    // error at every session start; a zg call there explains the refusal.
    const plan = planWorkspace(ctx.cwd);
    if (
      plan.indexRoot === null &&
      isUnsafeAutoIndexRoot(plan.buildRoot, home)
    ) {
      return;
    }
    ui.setStatus("pi-zg", "checking index…");
    const idx = await chain.zg.ensureIndex({ signal });
    // Nothing to report to a session that ended mid-warmup: the build was
    // cancelled on purpose and its exit code is only that cancellation's corpse.
    if (idx.error && !signal?.aborted) {
      ui.notify(`zg warmup: ${idx.error}`, "error");
    }
  } catch {
    // Warmup must never break session start; the tool path surfaces real
    // errors (install failures, PI_ZG_BIN misconfig) to the agent.
  } finally {
    if (!signal?.aborted) {
      ui.setStatus("pi-zg", undefined);
    }
  }
};

export const registerSessionWarmup = (
  pi: ExtensionAPI
): { whenIdle: () => Promise<void> } => {
  // One live warmup per extension instance. A reload (`/new`, resume) and a
  // shutdown both replace the ctx while the previous build may still be
  // running, so it is cancelled instead of streaming into a dead session.
  let activeWarmup: AbortController | undefined;
  // Abort only *signals* the build: `runner.stream` kills the child and waits
  // for it, but the warmup is fire-and-forget from the event handler, so that
  // wait lands in a promise nobody holds. The killed `zg --index` child keeps
  // the session's workspace as its cwd for a moment after the abort returns —
  // harmless on POSIX, where a directory can be removed under a live process,
  // EPERM on Windows until the process is really gone. Keep every started
  // warmup here so a caller about to delete that workspace (teardown, tests)
  // can wait for the killed child instead of racing it.
  const running = new Set<Promise<void>>();
  const track = (warm: Promise<void>): void => {
    running.add(warm);
    // Forget it on settle. Both handlers are attached, so a rejection can never
    // surface as an unhandledRejection before whenIdle gets to observe it.
    const forget = (): boolean => running.delete(warm);
    void warm.then(forget, forget);
  };
  // Resolves once no warmup this instance started is still running, aborts
  // included: the child an abort killed has exited and released the workspace.
  // Recursive instead of a loop because a new session_start may track another
  // warmup while this waits.
  const whenIdle = async (): Promise<void> => {
    if (running.size > 0) {
      await Promise.allSettled(running);
      await whenIdle();
    }
  };
  pi.on("session_start", (_event, ctx) => {
    activeWarmup?.abort();
    const ctrl = new AbortController();
    activeWarmup = ctrl;
    // Fire-and-forget: never block startup on an index build. Reload/resume
    // re-runs it — two cheap spawns on a warm repo.
    track(sessionWarmup(ctx, process.env, homedir(), undefined, ctrl.signal));
  });
  pi.on("session_shutdown", () => {
    activeWarmup?.abort();
    activeWarmup = undefined;
  });
  return { whenIdle };
};

// --- Factory ----------------------------------------------------------------

export default function piZgExtension(pi: ExtensionAPI): void {
  registerZgTool(pi);
  registerZgIndexCommand(pi);
  registerZgStatusCommand(pi);
  registerZgServerCommand(pi);
  registerSessionWarmup(pi);
}
