// End-to-end tests against the real zg 0.3.0 engine. Skipped unless
// ZG_TEST_E2E=1 (run with `npm run test:e2e`).
//
// 0.3.0 behavior these tests pin (verified against the bundled native binary):
//   - the CLI is flag-shaped: `--index`, `--status --check-ready`,
//     `--hybrid|--fts|--vector <query>`, `--rg <pattern>`, `--server on|off|status`.
//     The 0.2.x subcommands (query/index/status) are gone.
//   - `--rg` rejects the indexed options (--preview/--mode/--refresh), so
//     buildQueryArgs drops them; see src/args.ts.
//   - a fresh directory is not ready (`--status --check-ready` exits non-zero)
//     and needs one `--index` before the indexed routes answer.
//
// The fixture's hello.ts declares `loadTheme()`, the only indexed symbol, so
// every route below finds it. No network: the embedding model is already
// cached from the fixture capture.
//
// Three install scenarios live here because they need the real packages:
// (a) `npm pack` + `npm install --ignore-scripts` still resolves the engine
//     through the per-platform optional dependency (the postinstall stub stays
//     un-materialized), and a real query through the runner returns results;
// (b) an old `zg` first on PATH must lose to the bundled 0.3.0 engine;
// (c) PI_ZG_BIN pointing at that old `zg` is a single clear error — no
//     fallback to the bundled engine, no PATH lookup, no install.

import assert from "node:assert/strict";
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
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildIndexArgs,
  buildQueryArgs,
  buildStatusArgs,
} from "../src/args.ts";
import { makeRunner, resolveLocalEngine } from "../src/index.ts";
import { createZg } from "../src/zg.ts";

const ok = process.env.ZG_TEST_E2E === "1";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const scratch = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-e2e-`);
  cpSync(
    fileURLToPath(new URL("fixtures/sample-project", import.meta.url)),
    dir,
    { recursive: true }
  );
  return dir;
};

// A real `zg` 0.2.1 stand-in: it answers `--version` with 0.2.1 and logs every
// argv[1] it receives, so a test can prove it was (or was not) executed.
const makeOldZg = (dir: string, log: string): string => {
  const bin = path.join(dir, "zg");
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(
    bin,
    `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\ncase "$1" in\n  --version) echo "0.2.1" ;;\n  *) exit 1 ;;\nesac\nexit 0\n`
  );
  chmodSync(bin, 0o755);
  return bin;
};

// `npm run test:e2e` exports its own npm_config_* environment (notably a
// project-scoped npm_config_allow_scripts, which npm 11 rejects as
// EALLOWSCRIPTS inside a child install). Strip those so the child npm is a
// clean, plain install.
const npmEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) =>
        value !== undefined && !key.toLowerCase().startsWith("npm_config_")
    )
  ) as Record<string, string>;

const indexThenQuery = async (
  runner: ReturnType<typeof makeRunner>,
  dir: string
): Promise<void> => {
  const index = await runner.stream(buildIndexArgs(), { cwd: dir });
  assert.equal(index.code, 0, `zg --index failed (exit ${index.code})`);
  const routes = [
    {
      mode: "hybrid",
      preview: "short",
      query: "where is the theme restored",
    },
    { mode: "fts", preview: "none", query: "loadTheme" },
    { mode: "vector", preview: "none", query: "restore user theme" },
    { glob: "*.ts", mode: "rg", preview: "none", query: "loadTheme" },
  ] as const;
  for (const route of routes) {
    // Sequential on purpose: one engine, four routes, readable failures.
    // oxlint-disable-next-line no-await-in-loop
    const res = await runner.run(buildQueryArgs({ limit: 5, ...route }));
    assert.equal(
      res.code,
      0,
      `route ${route.mode} exited ${res.code}: ${res.stderr}`
    );
    assert.match(
      res.stdout,
      /hello\.ts|loadTheme/u,
      `route ${route.mode} returned no relevant hit:\n${res.stdout}`
    );
  }
};

// Regression, live 2026-10-16: a stray ~/Dev/.zvec-grep captured every repo
// below it. Upstream walks up to the nearest index with no repo boundary, and
// its builds skip nested git repos, so the child reported "ready" and every
// semantic query returned the parent's files. The ensure chain must build
// the child its own index (explicit root) and the query must then hit it.
(ok ? test : test.skip)(
  "e2e: a repo under an indexed parent folder gets its own index",
  async (t) => {
    const parent = mkdtempSync(`${tmpdir()}/pi-zg-e2e-parent-`);
    t.after(() => rmSync(parent, { force: true, recursive: true }));
    writeFileSync(
      path.join(parent, "notes.ts"),
      "export const gardenPlan = 'tomato harvest schedule';\n"
    );
    const child = path.join(parent, "repo");
    mkdirSync(path.join(child, ".git"), { recursive: true });
    cpSync(
      fileURLToPath(new URL("fixtures/sample-project", import.meta.url)),
      child,
      { recursive: true }
    );
    const env = { ...process.env, PI_ZG_SERVER: "1" };
    const bundledZg = resolveLocalEngine(REPO_ROOT).cli;
    assert.ok(bundledZg, "this checkout must ship the platform engine");
    // 0.3.0 CLI: `--index [root]` / `--status --check-ready`, no subcommands.
    const parentIndex = spawnSync(bundledZg, ["--index", parent], {
      cwd: parent,
      encoding: "utf-8",
      env,
    });
    assert.equal(parentIndex.status, 0, `parent index: ${parentIndex.stderr}`);
    const before = spawnSync(bundledZg, ["--status", "--check-ready"], {
      cwd: child,
      encoding: "utf-8",
      env,
    });
    assert.equal(before.status, 0, "precondition: upstream reports ready");

    const runner = makeRunner({ cwd: child, env });
    const zg = createZg(runner, { env, root: child });
    assert.deepEqual(await zg.ensureIndex(), {});
    assert.ok(existsSync(path.join(child, ".zvec-grep", "manifest.json")));

    const r = await runner.run(
      buildQueryArgs({
        limit: 5,
        mode: "hybrid",
        preview: "short",
        query: "where is the theme restored",
      })
    );
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /hello\.ts/u);
    assert.doesNotMatch(r.stdout, /notes\.ts/u, "parent's file leaked in");
  }
);

(ok ? test : test.skip)(
  "e2e: cold repo builds through the chain with an explicit root, then stays trusted",
  async (t) => {
    const dir = scratch();
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const env = { ...process.env, PI_ZG_SERVER: "1" };
    const runner = makeRunner({ cwd: dir, env });
    const lines: string[] = [];
    const zg = createZg(runner, {
      env,
      onUpdate: (s) => lines.push(s),
      root: dir,
    });
    assert.deepEqual(await zg.ensureIndex(), {});
    assert.ok(existsSync(path.join(dir, ".zvec-grep", "manifest.json")));
    // Second call: status ready on our own index, no rebuild.
    lines.length = 0;
    assert.deepEqual(await zg.ensureIndex(), {});
    assert.deepEqual(lines, [], "ready index must not rebuild");
  }
);

(ok ? test : test.skip)(
  "e2e: bundled 0.3.0 engine indexes the fixture and every route answers",
  async (t) => {
    const dir = scratch();
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const bundled = resolveLocalEngine(REPO_ROOT).cli;
    assert.ok(bundled, "this checkout must ship the platform engine");

    const runner = makeRunner({ cwd: dir, env: { ...process.env } });
    assert.equal(await runner.probe(), bundled);
    assert.match(runner.version?.() ?? "", /^0\.3\.0/u);
    await indexThenQuery(runner, dir);
  }
);

// First-time user on a fresh clone: empty workspace, empty ZVEC_GREP_HOME (no
// global config, no cached model), no ZVEC_GREP_EMBEDDING/PI_ZG_EMBEDDING. zg
// refuses to create an index from a non-interactive query
// (crates/zg/src/main.rs:620-625), so the extension's own build has to name the
// model — that is the whole of the first-index fix — and the query that follows
// must return hits.
(ok ? test : test.skip)(
  "e2e: fresh workspace and fresh home auto-index and answer a query",
  async (t) => {
    const bundled = resolveLocalEngine(REPO_ROOT).cli;
    assert.ok(bundled, "this checkout must ship the platform engine");

    const home = mkdtempSync(`${tmpdir()}/pi-zg-fresh-home-`);
    const dir = scratch();
    t.after(() => {
      rmSync(dir, { force: true, recursive: true });
      rmSync(home, { force: true, recursive: true });
    });

    // Nothing may smuggle a model in: no configured default, no shared model
    // cache, no daemon carried over from the developer's session.
    const stripped = new Set([
      "ZVEC_GREP_EMBEDDING",
      "ZVEC_GREP_MODEL_CACHE",
      "ZVEC_GREP_MODE",
      "ZVEC_GREP_DEVICE",
      "PI_ZG_EMBEDDING",
      "PI_ZG_MODE",
      "PI_ZG_SERVER",
    ]);
    const env = Object.fromEntries([
      ...Object.entries(process.env).filter(([key]) => !stripped.has(key)),
      ["ZVEC_GREP_HOME", home],
    ]);

    const runner = makeRunner({ cwd: dir, env });
    const zg = createZg(runner, { env, root: dir });
    const idx = await zg.ensureIndex();
    if (idx.error !== undefined) {
      // Offline (or proxy-blocked) machine: the model cannot be fetched. The
      // emitted arguments are pinned by test/args.test.ts, so skipping here
      // loses no coverage of the fix itself.
      assert.match(
        String(idx.error),
        /download|network|connect|offline|proxy|tls|timed? ?out/iu,
        `unexpected first-index failure: ${idx.error}`
      );
      t.skip(`model download unavailable: ${idx.error}`);
      return;
    }

    const status = await runner.run(buildStatusArgs());
    assert.equal(status.code, 0, `index not ready: ${status.stdout}`);
    assert.match(
      status.stdout,
      /Embedding\s+local\/potion-code-16m-v2/u,
      `first index did not use the built-in model:\n${status.stdout}`
    );

    const res = await runner.run(
      buildQueryArgs({
        limit: 5,
        mode: "fts",
        preview: "none",
        query: "loadTheme",
      })
    );
    assert.equal(res.code, 0, `query exited ${res.code}: ${res.stderr}`);
    assert.match(res.stdout, /hello\.ts|loadTheme/u, `no hits:\n${res.stdout}`);
  }
);

(ok ? test : test.skip)(
  "e2e: npm install --ignore-scripts still resolves the engine and a query returns hits",
  async (t) => {
    const tmp = mkdtempSync(`${tmpdir()}/pi-zg-pack-`);
    t.after(() => rmSync(tmp, { force: true, recursive: true }));

    const pack = spawnSync(
      "npm",
      ["pack", "--pack-destination", tmp, "--silent"],
      { cwd: REPO_ROOT, encoding: "utf-8", env: npmEnv() }
    );
    assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
    const tarball = path.join(
      tmp,
      pack.stdout.trim().split("\n").pop()?.trim() ?? ""
    );
    assert.ok(existsSync(tarball), `no tarball at ${tarball}`);

    writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ name: "pi-zgrep-e2e-host", private: true })
    );
    // --ignore-scripts is the npm-12 default for dependencies (RFC 0054) and
    // is what pi's installer effectively gets: the meta package's postinstall
    // never runs, so bin/zg.exe stays the "not materialized" stub. The engine
    // must still be found in the optional per-platform package.
    // --legacy-peer-deps keeps npm from reaching for the pi host package,
    // which this test does not need.
    const install = spawnSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        tarball,
      ],
      { cwd: tmp, encoding: "utf-8", env: npmEnv() }
    );
    assert.equal(install.status, 0, `npm install failed: ${install.stderr}`);

    const stub = path.join(
      tmp,
      "node_modules",
      "@zvec",
      "zvec-grep",
      "bin",
      "zg.exe"
    );
    assert.ok(existsSync(stub), "install must leave the meta package in place");
    assert.match(
      readFileSync(stub, "utf-8"),
      /not materialized/u,
      "expected the un-materialized install stub (proves the platform package is what gets used)"
    );

    // Resolve exactly as the installed package does at runtime: it walks up
    // from its own src/ directory into the host's node_modules.
    const installedSrc = path.join(tmp, "node_modules", "pi-zgrep", "src");
    const engine = resolveLocalEngine(installedSrc);
    assert.ok(
      engine.cli,
      `installed package found no engine: ${engine.problems}`
    );
    assert.ok(
      engine.cli.startsWith(path.join(tmp, "node_modules")),
      `engine must come from the install, got ${engine.cli}`
    );

    const dir = scratch();
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const runner = makeRunner({
      cwd: dir,
      env: { ...process.env },
      resolveEngine: () => resolveLocalEngine(installedSrc),
    });
    assert.equal(await runner.probe(), engine.cli);
    await indexThenQuery(runner, dir);
  }
);

(ok ? test : test.skip)(
  "e2e: a 0.2.1 zg first on PATH loses to the bundled 0.3.0 engine",
  async (t) => {
    const tmp = mkdtempSync(`${tmpdir()}/pi-zg-path-`);
    t.after(() => rmSync(tmp, { force: true, recursive: true }));
    const log = path.join(tmp, "calls.log");
    const oldZg = makeOldZg(tmp, log);
    const bundled = resolveLocalEngine(REPO_ROOT).cli;
    assert.ok(bundled, "this checkout must ship the platform engine");

    const dir = scratch();
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const runner = makeRunner({
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${path.dirname(oldZg)}:${process.env.PATH ?? ""}`,
      },
    });

    assert.equal(await runner.probe(), bundled);
    assert.match(runner.version?.() ?? "", /^0\.3\.0/u);
    assert.ok(
      !existsSync(log),
      "the 0.2.x binary on PATH must not be executed at all"
    );
  }
);

(ok ? test : test.skip)(
  "e2e: PI_ZG_BIN pointing at a 0.2.1 zg is one clear error, no fallback",
  async (t) => {
    const tmp = mkdtempSync(`${tmpdir()}/pi-zg-bin-`);
    t.after(() => rmSync(tmp, { force: true, recursive: true }));
    const log = path.join(tmp, "calls.log");
    const oldZg = makeOldZg(tmp, log);

    const dir = scratch();
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const env = { ...process.env, PI_ZG_BIN: oldZg };
    const runner = makeRunner({ cwd: dir, env });
    const zg = createZg(runner, { env, root: dir });

    await assert.rejects(zg.ensureBinary(), (error: Error) => {
      const { message } = error;
      assert.ok(
        message.includes("PI_ZG_BIN"),
        `error must name the variable: ${message}`
      );
      assert.ok(
        message.includes(oldZg),
        `error must name the path: ${message}`
      );
      assert.match(message, /0\.2\.1/u);
      assert.match(message, /0\.3\.0/u);
      return true;
    });
    // No fallback of any kind ran: the fake only ever saw `--version`, and
    // nothing built an index.
    assert.deepEqual(readFileSync(log, "utf-8").split("\n").filter(Boolean), [
      "--version",
    ]);
    assert.ok(!existsSync(path.join(dir, ".zvec-grep")));
  }
);
