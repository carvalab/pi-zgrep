// Which zg does the extension actually run? One row per user setup, proven
// against the real published artifacts rather than against src/.
//
//   node tools/upgrade-matrix.mjs      (npm run test:upgrade)
//
// Every scenario gets a fresh scratch project, installs the tgz this repo packs
// with `npm pack` exactly the way a user's pi install leaves it
// (`npm install <tgz>`, plus a second tree with `--ignore-scripts`: pi never
// opts into dependency postinstalls, so the shipped bin/zg.exe is often never
// materialized), imports the *installed* package's own makeRunner/createZg, and
// records the binary it resolved plus the `zg --version` it got back.
//
//   S1 bundled only, no zg on PATH            -> bundled 0.3.x platform binary
//   S2 global zg 0.2.2 first on PATH          -> bundled 0.3.x wins, 0.2.2 never runs
//   S3 PI_ZG_BIN -> the 0.2.2 binary          -> one error naming PI_ZG_BIN, no fallback
//   S4 PI_ZG_BIN -> missing path              -> same
//   S5 PI_ZG_BIN -> a global zg 0.3.x         -> that binary, not the bundled one
//   S6 0.6.0 (bundled 0.2.2, index built) -> 0.7.0 tgz over it
//                                             -> bundled 0.3.x, old index rebuilt
//
// Anything outside the scratch tree is left alone: HOME, USERPROFILE,
// npm_config_cache and npm_config_prefix all live inside it, PI_ZG_SERVER is
// set so no daemon starts, and npm/bun/pnpm are shadowed by a trap that records
// the call and exits 1 instead of ever touching a real global install.
//
// ZG_UPGRADE_KEEP=1 keeps the scratch dir; ZG_UPGRADE_ONLY=S2,S6 filters rows;
// ZG_UPGRADE_CACHE_DIR re-points the npm cache (default: a persistent
// pi-zg-upgrade-cache under the OS temp dir, so reruns do not re-download).
// Exit code 1 when any row FAILs.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Node only strips types for files outside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING); the installed package is
// mirrored one level up before it is imported. Re-exec when stripping is off.
if (!process.features.typescript) {
  const child = spawnSync(
    process.execPath,
    ["--experimental-strip-types", ...process.argv.slice(1)],
    { env: process.env, stdio: "inherit" }
  );
  process.exit(child.status ?? 1);
}

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const WIN = process.platform === "win32";
const VARIANTS = ["plain", "ignore-scripts"];
const MODEL = "local/potion-code-16m-v2";
const LEGACY_ZG = "0.2.2";
const LEGACY_EXTENSION = "pi-zgrep@0.6.0";

const CACHE_ROOT =
  process.env.ZG_UPGRADE_CACHE_DIR ??
  path.join(tmpdir(), "pi-zg-upgrade-cache");
const SCRATCH = mkdtempSync(
  path.join(process.env.ZG_UPGRADE_DIR ?? tmpdir(), "pi-zg-upgrade-")
);
const HOME_DIR = path.join(SCRATCH, "home");
// The npm cache outlives a run on purpose: every scenario installs a whole tree
// (pi's own peer dependencies are large), so a per-run cache would re-download
// everything each time.
const NPM_CACHE = path.join(CACHE_ROOT, "npm-cache");
const NPM_GLOBAL_LEGACY = path.join(SCRATCH, "npm-global-legacy");
const NPM_GLOBAL_MODERN = path.join(SCRATCH, "npm-global-modern");
const TRAP = path.join(SCRATCH, "trap");
const DECOY = path.join(SCRATCH, "decoy");
const POISON = path.join(SCRATCH, "poison");
const TRAP_LOG = path.join(TRAP, "calls.log");
const DECOY_LOG = path.join(DECOY, "calls.log");
const POISON_LOG = path.join(POISON, "calls.log");

for (const dir of [HOME_DIR, NPM_CACHE, TRAP, DECOY, POISON]) {
  mkdirSync(dir, { recursive: true });
}

// --- process helpers --------------------------------------------------------

const TAIL = 3000;
const tail = (text) => {
  const s = String(text ?? "").trim();
  return s.length > TAIL ? `…${s.slice(-TAIL)}` : s;
};

// npm and the .cmd shims next to it are batch files on Windows, and Node's
// spawn refuses to run one without a shell. Quote the whole command line
// ourselves rather than handing an argv array to shell mode (which would drop
// the quoting around paths that contain spaces).
const winQuote = (value) =>
  /^[\w@%+=:,./\\-]+$/u.test(value)
    ? value
    : `"${value.replaceAll('"', '""')}"`;

const env0 = () => {
  const env = { ...process.env };
  // `npm run` exports every npm config as npm_config_* into the script's
  // environment, so the harness would inherit the caller's registry/lifecycle
  // settings (npm 11 ships an allow-scripts approval that then fails every
  // project install with EALLOWSCRIPTS). Start from a clean npm slate.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase().startsWith("npm_config_")) {
      delete env[key];
    }
  }
  for (const name of [
    "PI_ZG_BIN",
    "PI_ZG_AUTO_INSTALL",
    "PI_ZG_SERVER",
    "PI_ZG_EMBEDDING",
    "ZVEC_GREP_EMBEDDING",
    "NODE_OPTIONS",
    "Path",
  ]) {
    delete env[name];
  }
  return {
    ...env,
    HOME: HOME_DIR,
    USERPROFILE: HOME_DIR,
    npm_config_audit: "false",
    npm_config_cache: NPM_CACHE,
    npm_config_fund: "false",
    npm_config_prefix: NPM_GLOBAL_LEGACY,
    npm_config_progress: "false",
    npm_config_update_notifier: "false",
    npm_config_userconfig: path.join(SCRATCH, "npmrc"),
    PI_ZG_SERVER: "1",
    // 0.2.x pulls sharp; a system libvips makes sharp's install script fall
    // through to a source build that needs node-gyp. Its prebuilt binary is
    // what npm installs anyway.
    SHARP_IGNORE_GLOBAL_LIBVIPS: "true",
  };
};

const run = (cmd, args, o = {}) => {
  const options = {
    cwd: o.cwd ?? REPO,
    encoding: "utf8",
    env: o.env ?? env0(),
    maxBuffer: 256 * 1024 * 1024,
    timeout: o.timeout ?? 900_000,
  };
  const res = WIN
    ? spawnSync(
        [cmd, ...args].map(winQuote).join(" "),
        // oxlint-disable-next-line no-useless-spread
        { ...options, shell: true }
      )
    : spawnSync(cmd, args, options);
  return {
    code: res.status,
    out: `${res.stdout ?? ""}`,
    err: `${res.stderr ?? ""}\n${res.error ? String(res.error.message) : ""}`,
  };
};

const mustRun = (cmd, args, o = {}) => {
  const res = run(cmd, args, o);
  if (res.code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} exited ${res.code}\n${tail(res.out)}\n${tail(res.err)}`
    );
  }
  return res;
};

const runNodeScript = (file, args, o = {}) => {
  const res = run(process.execPath, [file, ...args], o);
  if (res.code !== 0) {
    throw new Error(
      `node ${file} ${args.join(" ")} exited ${res.code}\n${tail(res.out)}\n${tail(res.err)}`
    );
  }
  return res;
};

const firstLine = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? "";

const statusSummary = (text) =>
  String(text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" / ");

const readJSON = (file) => JSON.parse(readFileSync(file, "utf8"));

const readLog = (file) => {
  try {
    return readFileSync(file, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const resetLog = (file) => writeFileSync(file, "");

// --- PATH construction ------------------------------------------------------

const ZG_NAMES = ["zg", "zg.exe", "zg.cmd", "zg.bat"];
const dirHasZg = (dir) => ZG_NAMES.some((n) => existsSync(path.join(dir, n)));

const NODE_DIR = path.dirname(process.execPath);

// Inherited PATH minus every directory that carries a zg binary, so "no zg on
// PATH" is a fact and not a hope (a machine-wide zg would otherwise satisfy
// S1 silently). The node directory always stays: the 0.2.2 CLI is a JS file
// with a `#!/usr/bin/env node` shebang.
const basePath = (() => {
  const inherited = (process.env.PATH ?? process.env.Path ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const kept = [];
  const dropped = [];
  for (const dir of inherited) {
    if (path.resolve(dir) === path.resolve(NODE_DIR) || !dirHasZg(dir)) {
      kept.push(dir);
    } else {
      dropped.push(dir);
    }
  }
  return {
    dropped,
    dirs: [...new Set(kept)],
    zgInNodeDir: dirHasZg(NODE_DIR),
  };
})();

const joinPath = (...dirs) =>
  [...new Set(dirs.filter(Boolean))].join(path.delimiter);

const globalBinRoot = (prefix) => (WIN ? prefix : path.join(prefix, "bin"));
const globalZg = (prefix) =>
  path.join(globalBinRoot(prefix), WIN ? "zg.cmd" : "zg");

// --- shims -----------------------------------------------------------------

const writeShim = (dir, name, posixBody, winBody) => {
  mkdirSync(dir, { recursive: true });
  const script = path.join(dir, name);
  writeFileSync(script, `#!/bin/sh\n${posixBody}\n`);
  chmodSync(script, 0o755);
  writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n${winBody}\r\n`);
};

// Records the call and fails: a fallback install must never reach a real
// prefix, and seeing the marker means the extension tried.
const writeTrap = () => {
  resetLog(TRAP_LOG);
  for (const name of ["npm", "bun", "pnpm"]) {
    writeShim(
      TRAP,
      name,
      `printf '${name} %s\\n' "$*" >> '${TRAP_LOG}'\nexit 1`,
      `>>"${TRAP_LOG}" echo ${name} %*\r\nexit /b 1`
    );
  }
};

// S2: a wrapper in front of the real global 0.2.2 binary. It appears on PATH
// exactly where that binary would, logs any execution, and delegates — so a
// marker means the old engine ran.
const writeDecoy = (legacyZgPath) => {
  resetLog(DECOY_LOG);
  writeShim(
    DECOY,
    "zg",
    `printf 'zg %s\\n' "$*" >> '${DECOY_LOG}'\nexec '${legacyZgPath}' "$@"`,
    `>>"${DECOY_LOG}" echo zg %*\r\n@"${legacyZgPath}" %*\r\nexit /b %errorlevel%`
  );
};

// S3/S4/S5: a zg on PATH that can only ever be reached by a fallback the
// contract forbids. Logs and fails.
const writePoison = () => {
  resetLog(POISON_LOG);
  writeShim(
    POISON,
    "zg",
    `printf 'zg %s\\n' "$*" >> '${POISON_LOG}'\nexit 1`,
    `>>"${POISON_LOG}" echo zg %*\r\nexit /b 1`
  );
};

// --- installing the package under test --------------------------------------

const packTarball = () => {
  const dest = path.join(SCRATCH, "pack");
  mkdirSync(dest, { recursive: true });
  const res = mustRun("npm", ["pack", "--pack-destination", dest], {
    cwd: REPO,
    env: { ...env0(), npm_config_prefix: NPM_GLOBAL_MODERN },
  });
  const name = res.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  const tgz = path.join(dest, name);
  if (!existsSync(tgz)) {
    throw new Error(`npm pack did not produce ${tgz}:\n${tail(res.out)}`);
  }
  return tgz;
};

const freshProject = (id, variant) => {
  const app = path.join(SCRATCH, id.toLowerCase(), variant);
  mkdirSync(app, { recursive: true });
  writeFileSync(
    path.join(app, "package.json"),
    `${JSON.stringify(
      {
        name: `zg-upgrade-${id.toLowerCase()}-${variant}`,
        private: true,
        version: "1.0.0",
      },
      null,
      2
    )}\n`
  );
  return app;
};

const installArgs = (spec, variant) => {
  const args = ["install", spec, "--no-audit", "--no-fund"];
  if (variant === "ignore-scripts") {
    args.push("--ignore-scripts");
  }
  return args;
};

// The installed package is copied out of node_modules because Node refuses to
// strip types there; its bare imports (cross-spawn, typebox, pi-tui) still
// resolve from <app>/node_modules.
const mirrorInstalled = (app) => {
  const from = path.join(app, "node_modules", "pi-zgrep");
  if (!existsSync(path.join(from, "package.json"))) {
    throw new Error(`pi-zgrep is not installed in ${app}`);
  }
  const to = path.join(app, "runtime", "pi-zgrep");
  rmSync(to, { force: true, recursive: true });
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  return to;
};

const installTarball = (app, variant, tgz) => {
  mustRun("npm", installArgs(tgz, variant), { cwd: app });
  mirrorInstalled(app);
  const meta = readJSON(
    path.join(app, "node_modules", "@zvec", "zvec-grep", "package.json")
  );
  return {
    engine: meta.version,
    mirror: path.join(app, "runtime", "pi-zgrep"),
  };
};

// --- importing the installed package ---------------------------------------

let loadCounter = 0;

const loadExtension = async (mirror) => {
  // A fresh query string defeats the ESM cache: S6 imports the same path twice
  // across the 0.6.0 -> 0.7.0 upgrade.
  loadCounter += 1;
  const tag = `?upgrade-matrix=${loadCounter}`;
  const index = await import(
    `${pathToFileURL(path.join(mirror, "src", "index.ts")).href}${tag}`
  );
  const zg = await import(
    `${pathToFileURL(path.join(mirror, "src", "zg.ts")).href}${tag}`
  );
  if (
    typeof index.makeRunner !== "function" ||
    typeof zg.createZg !== "function"
  ) {
    throw new Error(`${mirror} does not export makeRunner/createZg`);
  }
  return { createZg: zg.createZg, makeRunner: index.makeRunner };
};

const inspect = async ({ mirror, root, env }) => {
  const { makeRunner, createZg } = await loadExtension(mirror);
  const runner = makeRunner({ cwd: root, env });
  const bin = await runner.probe();
  const version = runner.version() ?? null;
  const issue = runner.probeIssue() ?? null;
  const api = createZg(runner, { env, home: HOME_DIR, root });
  return { api, bin, issue, runner, version };
};

const ensureBinaryError = async (api) => {
  try {
    await api.ensureBinary();
    return null;
  } catch (error) {
    return String(error?.message ?? error);
  }
};

// --- formatting ------------------------------------------------------------

const short = (target) => {
  if (!target) {
    return "null";
  }
  const rel = path.relative(SCRATCH, target);
  return rel.startsWith("..") ? target : rel;
};

// "bundled" = a binary from a @zvec/zvec-grep-<os>-<arch> platform package.
const isBundled = (bin) =>
  typeof bin === "string" && /@zvec[/\\]zvec-grep-/u.test(bin);

const isModern = (version) =>
  typeof version === "string" && /^0\.3\./u.test(version.trim());
const isLegacy = (version) =>
  typeof version === "string" && version.trim() === LEGACY_ZG;

// --- scenarios -------------------------------------------------------------

const SCENARIOS = [
  {
    id: "S1",
    name: "bundled only, no zg on PATH",
    expected: "bundled 0.3.x platform binary",
    async run(variant, ctx) {
      const app = freshProject("S1", variant);
      const installed = installTarball(app, variant, ctx.tgz);
      const probe = await inspect({
        env: ctx.env({ PATH: joinPath(TRAP, ...basePath.dirs) }),
        mirror: installed.mirror,
        root: app,
      });
      const failures = [];
      if (!isBundled(probe.bin)) {
        failures.push(
          `resolved ${short(probe.bin)}, expected the bundled platform binary`
        );
      }
      if (!isModern(probe.version)) {
        failures.push(`version ${probe.version}, expected 0.3.x`);
      }
      if (basePath.zgInNodeDir) {
        failures.push(
          `a zg binary sits in ${NODE_DIR}, so PATH is not zg-free`
        );
      }
      const calls = readLog(TRAP_LOG);
      if (calls.length > 0) {
        failures.push(`fallback install attempted: ${calls.join("; ")}`);
      }
      const engine = await ensureBinaryError(probe.api);
      if (engine !== null) {
        failures.push(`ensureBinary failed: ${engine}`);
      }
      return {
        actual: `${short(probe.bin)} (zg ${probe.version}); no fallback install`,
        details: [
          `engine package @zvec/zvec-grep ${installed.engine} installed with ${
            variant === "plain" ? "npm install" : "npm install --ignore-scripts"
          }`,
          basePath.dropped.length > 0
            ? `PATH dirs dropped because they ship zg: ${basePath.dropped.join(", ")}`
            : "no zg on PATH and no zg dir to drop",
        ],
        failures,
      };
    },
  },
  {
    id: "S2",
    name: `global zg ${LEGACY_ZG} first on PATH`,
    expected: `bundled 0.3.x wins, ${LEGACY_ZG} never executes`,
    async run(variant, ctx) {
      const app = freshProject("S2", variant);
      const installed = installTarball(app, variant, ctx.tgz);
      const legacy = globalZg(NPM_GLOBAL_LEGACY);
      writeDecoy(legacy);
      const probe = await inspect({
        env: ctx.env({
          PATH: joinPath(
            TRAP,
            DECOY,
            globalBinRoot(NPM_GLOBAL_LEGACY),
            ...basePath.dirs
          ),
        }),
        mirror: installed.mirror,
        root: app,
      });
      const ran = readLog(DECOY_LOG);
      const failures = [];
      if (!isBundled(probe.bin)) {
        failures.push(
          `resolved ${short(probe.bin)}, expected the bundled platform binary`
        );
      }
      if (!isModern(probe.version)) {
        failures.push(`version ${probe.version}, expected 0.3.x`);
      }
      if (ran.length > 0) {
        failures.push(`the ${LEGACY_ZG} binary executed: ${ran.join("; ")}`);
      }
      const calls = readLog(TRAP_LOG);
      if (calls.length > 0) {
        failures.push(`fallback install attempted: ${calls.join("; ")}`);
      }
      return {
        actual: `${short(probe.bin)} (zg ${probe.version}); ${LEGACY_ZG} wrapper calls: ${ran.length}`,
        details: [
          `PATH order: trap, decoy(${LEGACY_ZG}), ${short(globalBinRoot(NPM_GLOBAL_LEGACY))}, node dir`,
          `global ${LEGACY_ZG} on PATH: ${existsSync(legacy) ? short(legacy) : "MISSING"}`,
        ],
        failures,
      };
    },
  },
  {
    id: "S3",
    name: `PI_ZG_BIN -> the ${LEGACY_ZG} binary`,
    expected: "one error naming PI_ZG_BIN, no fallback",
    async run(variant, ctx) {
      const app = freshProject("S3", variant);
      const installed = installTarball(app, variant, ctx.tgz);
      writePoison();
      const legacy = globalZg(NPM_GLOBAL_LEGACY);
      const probe = await inspect({
        env: ctx.env({
          PATH: joinPath(TRAP, POISON, ...basePath.dirs),
          PI_ZG_BIN: legacy,
        }),
        mirror: installed.mirror,
        root: app,
      });
      const error = await ensureBinaryError(probe.api);
      const failures = [];
      if (probe.bin !== null) {
        failures.push(
          `probe accepted ${short(probe.bin)}; a 0.2.x binary must be rejected`
        );
      }
      if (!String(probe.issue ?? "").includes(LEGACY_ZG)) {
        failures.push(`probeIssue does not name ${LEGACY_ZG}: ${probe.issue}`);
      }
      if (error === null || !error.includes("PI_ZG_BIN")) {
        failures.push(`error does not name PI_ZG_BIN: ${error}`);
      }
      if (error !== null && !error.includes(legacy)) {
        failures.push(`error does not name the override path: ${error}`);
      }
      if (readLog(POISON_LOG).length > 0) {
        failures.push(
          `fell back to zg on PATH: ${readLog(POISON_LOG).join("; ")}`
        );
      }
      if (readLog(TRAP_LOG).length > 0) {
        failures.push(
          `fallback install attempted: ${readLog(TRAP_LOG).join("; ")}`
        );
      }
      return {
        actual: `probe null, issue "${firstLine(probe.issue)}"; error "${firstLine(error)}"`,
        details: [
          `PI_ZG_BIN=${legacy} (${LEGACY_ZG})`,
          ...(error ? [error] : []),
        ],
        failures,
      };
    },
  },
  {
    id: "S4",
    name: "PI_ZG_BIN -> missing path",
    expected: "one error naming PI_ZG_BIN, no fallback",
    async run(variant, ctx) {
      const app = freshProject("S4", variant);
      const installed = installTarball(app, variant, ctx.tgz);
      writePoison();
      const missing = path.join(SCRATCH, "missing", "zg");
      const probe = await inspect({
        env: ctx.env({
          PATH: joinPath(TRAP, POISON, ...basePath.dirs),
          PI_ZG_BIN: missing,
        }),
        mirror: installed.mirror,
        root: app,
      });
      const error = await ensureBinaryError(probe.api);
      const failures = [];
      if (probe.bin !== null) {
        failures.push(
          `probe accepted ${short(probe.bin)}; a missing override must fail`
        );
      }
      if (error === null || !error.includes("PI_ZG_BIN")) {
        failures.push(`error does not name PI_ZG_BIN: ${error}`);
      }
      if (error !== null && !error.includes(missing)) {
        failures.push(`error does not name the override path: ${error}`);
      }
      if (readLog(POISON_LOG).length > 0) {
        failures.push(
          `fell back to zg on PATH: ${readLog(POISON_LOG).join("; ")}`
        );
      }
      if (readLog(TRAP_LOG).length > 0) {
        failures.push(
          `fallback install attempted: ${readLog(TRAP_LOG).join("; ")}`
        );
      }
      return {
        actual: `probe null; error "${firstLine(error)}"`,
        details: [`PI_ZG_BIN=${missing}`, ...(error ? [error] : [])],
        failures,
      };
    },
  },
  {
    id: "S5",
    name: "PI_ZG_BIN -> a global zg 0.3.x",
    expected: "the PI_ZG_BIN binary is used",
    async run(variant, ctx) {
      const app = freshProject("S5", variant);
      const installed = installTarball(app, variant, ctx.tgz);
      writePoison();
      const modern = globalZg(NPM_GLOBAL_MODERN);
      const probe = await inspect({
        env: ctx.env({
          PATH: joinPath(TRAP, POISON, ...basePath.dirs),
          PI_ZG_BIN: modern,
        }),
        mirror: installed.mirror,
        root: app,
      });
      const failures = [];
      if (probe.bin !== modern) {
        failures.push(
          `resolved ${short(probe.bin)}, expected PI_ZG_BIN ${short(modern)}`
        );
      }
      if (!isModern(probe.version)) {
        failures.push(`version ${probe.version}, expected 0.3.x`);
      }
      if (isBundled(probe.bin)) {
        failures.push("PI_ZG_BIN was ignored in favour of the bundled engine");
      }
      if (readLog(POISON_LOG).length > 0) {
        failures.push(
          `also tried zg on PATH: ${readLog(POISON_LOG).join("; ")}`
        );
      }
      const error = await ensureBinaryError(probe.api);
      if (error !== null) {
        failures.push(`ensureBinary failed: ${error}`);
      }
      return {
        actual: `${short(probe.bin)} (zg ${probe.version}), not the bundled engine`,
        details: [`PI_ZG_BIN=${modern}`],
        failures,
      };
    },
  },
  {
    id: "S6",
    name: `${LEGACY_EXTENSION} index -> 0.7.0 tgz over it`,
    expected: "bundled 0.3.x, old index detected and rebuilt",
    async run(variant, ctx) {
      const app = freshProject("S6", variant);
      // 1. The previous release, exactly as npm has it: pi-zgrep 0.6.0 with its
      // own bundled zg 0.2.2.
      mustRun("npm", installArgs(LEGACY_EXTENSION, variant), { cwd: app });
      const legacyMeta = readJSON(
        path.join(app, "node_modules", "@zvec", "zvec-grep", "package.json")
      );
      const binField = legacyMeta.bin;
      const binRel =
        typeof binField === "string" ? binField : (binField?.zg ?? "");
      const legacyCli = path.join(
        app,
        "node_modules",
        "@zvec",
        "zvec-grep",
        binRel
      );
      const work = path.join(app, "work");
      cpSync(path.join(REPO, "test", "fixtures", "sample-project"), work, {
        recursive: true,
      });
      const legacyVersion = firstLine(
        runNodeScript(legacyCli, ["--version"], { cwd: work }).out
      );
      // 2. Build the index with that 0.2.2 engine: the format 0.3.0 cannot read.
      runNodeScript(
        legacyCli,
        ["index", work, "--embedding", MODEL, "--mode", "direct"],
        { cwd: work, timeout: 900_000 }
      );
      const builtIndex = existsSync(
        path.join(work, ".zvec-grep", "manifest.json")
      );
      // 3. Upgrade in place with the tarball under test (what a user's
      // `pi install npm:pi-zgrep@0.7.0` does to the same tree).
      const installed = installTarball(app, variant, ctx.tgz);
      // 4. Drive the extension's own ensure/index path against that workspace.
      const probe = await inspect({
        env: ctx.env({ PATH: joinPath(TRAP, ...basePath.dirs) }),
        mirror: installed.mirror,
        root: work,
      });
      const before = await probe.runner.run(["--status", "--check-ready"]);
      const rebuildRequired = /rebuild required/iu.test(before.stdout);
      const ensure = await probe.api
        .ensureIndex()
        .catch((error) => ({ error: String(error?.message ?? error) }));
      const after = await probe.runner.run(["--status", "--check-ready"]);
      const failures = [];
      if (legacyVersion !== LEGACY_ZG) {
        failures.push(
          `0.6.0 bundled zg reported "${legacyVersion}", expected ${LEGACY_ZG}`
        );
      }
      if (!builtIndex) {
        failures.push("the 0.2.2 build left no .zvec-grep/manifest.json");
      }
      if (!installed.engine.startsWith("0.3.")) {
        failures.push(
          `upgrade left @zvec/zvec-grep ${installed.engine}, expected 0.3.x`
        );
      }
      if (!isBundled(probe.bin)) {
        failures.push(
          `resolved ${short(probe.bin)}, expected the bundled platform binary`
        );
      }
      if (!isModern(probe.version)) {
        failures.push(`bundled version ${probe.version}, expected 0.3.x`);
      }
      if (before.code === 0 || !rebuildRequired) {
        failures.push(
          `status before rebuild was code ${before.code} (${firstLine(before.stdout)}), expected "rebuild required"`
        );
      }
      if (ensure.error !== undefined) {
        failures.push(`ensureIndex failed: ${firstLine(ensure.error)}`);
      }
      if (after.code !== 0) {
        failures.push(
          `status after rebuild was code ${after.code} (${firstLine(after.stdout)})`
        );
      }
      if (/rebuild required/iu.test(after.stdout)) {
        failures.push(
          "status still reports rebuild required after ensureIndex"
        );
      }
      if (readLog(TRAP_LOG).length > 0) {
        failures.push(
          `fallback install attempted: ${readLog(TRAP_LOG).join("; ")}`
        );
      }
      return {
        actual: `${short(probe.bin)} (zg ${probe.version}); 0.2.2 index "${rebuildRequired ? "rebuild required" : "not detected"}" -> ensureIndex -> status ${after.code}`,
        details: [
          `0.6.0 bundled zg: ${legacyVersion}; index built at ${short(work)}/.zvec-grep`,
          `after upgrade: @zvec/zvec-grep ${installed.engine}`,
          `status before: code ${before.code} — ${statusSummary(before.stdout)}`,
          `status after: code ${after.code} — ${statusSummary(after.stdout)}`,
        ],
        failures,
      };
    },
  },
];

// --- table -----------------------------------------------------------------

const wrap = (text, width) => {
  const out = [];
  let line = "";
  for (const word of String(text).split(/\s+/u)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      out.push(line);
      line = word;
    }
  }
  out.push(line);
  return out.length > 0 ? out : [""];
};

const printTable = (rows) => {
  const headers = ["scenario", "expected", "actual", "result"];
  const cells = rows.map((row) => [
    `${row.id} ${row.name}`,
    row.expected,
    row.actual,
    row.failures.length === 0 ? "PASS" : "FAIL",
  ]);
  const widthFor = (i) =>
    Math.min(96, Math.max(headers[i].length, ...cells.map((c) => c[i].length)));
  const widths = headers.map((_, i) => widthFor(i));
  const bar = widths.map((w) => "-".repeat(w)).join("-+-");
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(" | "));
  console.log(bar);
  for (const rowCells of cells) {
    const wrapped = rowCells.map((text, i) => wrap(text, widths[i]));
    const height = Math.max(...wrapped.map((w) => w.length));
    for (let line = 0; line < height; line += 1) {
      console.log(
        wrapped.map((w, i) => (w[line] ?? "").padEnd(widths[i])).join(" | ")
      );
    }
  }
  console.log(bar);
};

// --- main -----------------------------------------------------------------

const main = async () => {
  const only = (process.env.ZG_UPGRADE_ONLY ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const scenarios = only.length
    ? SCENARIOS.filter((s) => only.includes(s.id))
    : SCENARIOS;

  console.log(`pi-zgrep upgrade matrix — scratch: ${SCRATCH}`);
  const tgz = packTarball();
  console.log(`package under test: ${path.basename(tgz)}\n`);

  const ctx = {
    env: (extra) => ({ ...env0(), ...extra }),
    tgz,
  };

  writeTrap();
  const needsLegacy = scenarios.some((s) => ["S2", "S3"].includes(s.id));
  const needsModern = scenarios.some((s) => s.id === "S5");
  if (needsLegacy) {
    console.log(
      `installing @zvec/zvec-grep@${LEGACY_ZG} into a scratch prefix…`
    );
    mustRun(
      "npm",
      [
        "install",
        "-g",
        `@zvec/zvec-grep@${LEGACY_ZG}`,
        "--no-audit",
        "--no-fund",
      ],
      {
        cwd: SCRATCH,
        env: { ...env0(), npm_config_prefix: NPM_GLOBAL_LEGACY },
      }
    );
  }
  if (needsModern) {
    console.log("installing @zvec/zvec-grep@0.3.0 into a scratch prefix…");
    mustRun(
      "npm",
      ["install", "-g", "@zvec/zvec-grep@0.3.0", "--no-audit", "--no-fund"],
      {
        cwd: SCRATCH,
        env: { ...env0(), npm_config_prefix: NPM_GLOBAL_MODERN },
      }
    );
  }
  if (needsLegacy || needsModern) {
    console.log("");
  }

  const rows = [];
  for (const scenario of scenarios) {
    for (const variant of VARIANTS) {
      // A fresh trap log per row: the marker must describe this run only.
      resetLog(TRAP_LOG);
      const started = Date.now();
      let result;
      try {
        result = await scenario.run(variant, ctx);
      } catch (error) {
        result = {
          actual: `harness error: ${firstLine(error?.message ?? error)}`,
          details: [String(error?.stack ?? error)],
          failures: [`threw: ${firstLine(error?.message ?? error)}`],
        };
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      rows.push({
        ...result,
        expected: scenario.expected,
        id: scenario.id,
        name: `${scenario.name} (${variant})`,
      });
      console.log(
        `${scenario.id}/${variant}: ${result.failures.length === 0 ? "PASS" : "FAIL"} (${seconds}s) — ${result.actual}`
      );
      // Each tree is a few hundred MB; drop it before the next install so the
      // run stays inside a CI runner's disk budget.
      if (!process.env.ZG_UPGRADE_KEEP) {
        rmSync(path.join(SCRATCH, scenario.id.toLowerCase()), {
          force: true,
          recursive: true,
        });
      }
    }
  }

  console.log("");
  printTable(rows);

  const details = rows.flatMap((row) => [
    ...row.details.map((line) => `${row.id}: ${line}`),
    ...row.failures.map((line) => `${row.id}: ✗ ${line}`),
  ]);
  console.log("");
  for (const line of details) {
    console.log(`  ${line}`);
  }

  const failed = rows.filter((row) => row.failures.length > 0);
  console.log(`\n${rows.length - failed.length}/${rows.length} scenarios PASS`);

  if (process.env.ZG_UPGRADE_KEEP) {
    console.log(`scratch kept at ${SCRATCH}`);
  } else {
    rmSync(SCRATCH, { force: true, recursive: true });
  }

  if (failed.length > 0) {
    console.log(
      `FAILED: ${failed.map((row) => `${row.id}/${row.name}`).join(", ")}`
    );
    process.exitCode = 1;
  }
};

await main();
