// End-to-end test against the real `zg` binary. Skipped unless
// ZG_TEST_E2E=1 (run with `npm run test:e2e` or
// `ZG_TEST_E2E=1 node --test test/e2e.test.ts`).
//
// Each test copies test/fixtures/sample-project into a fresh scratch
// directory and reindexes locally — no network, the embedding model is
// already cached from the fixture capture. The fixture's hello.ts
// declares `loadTheme()`, which is the only indexed symbol, so any
// route that resolves "hello.ts" or "loadTheme" is a relevant hit.
//
// Observed real `zg` v0.2.1 behavior (captured 2026 against the global
// install on this machine):
//   - `zg status --check-ready` exits 1 with "Workspace index is not
//     ready (state: undecided)" on a fresh dir. Good — the probe
//     assertion below relies on status !== 0.
//   - `zg index` is required before any indexed query route (fts/
//     vector/hybrid). It is NOT required for `--rg` (rg walks files
//     directly), but we index anyway to keep the test hermetic.
//   - `zg query <q> --limit N --preview short --mode auto` works for
//     hybrid/fts/vector routes and matches hello.ts for the canned
//     queries below.
//   - `zg query --rg <pattern> --limit N` returns ripgrep-shaped output
//     (file path then `line: <content>` lines) — does NOT include
//     "hello.ts" and "loadTheme" in any structured way other than the
//     filename and the matched line itself, which is enough for the
//     lenient `/hello\.ts|loadTheme/u` assertion.
//   - `--rg` REJECTS `--preview` and `--mode` ("--preview is not
//     supported with --rg; use -A/-B/-C for rg context"). buildQueryArgs
//     drops those flags for rg (see src/args.ts), and the e2e loop
//     therefore passes only `--limit N` (plus `-g *.ts`) for the rg
//     slot, so it works as-is.
//   - `zg query` with no query and no --hybrid/--fts/--vector is
//     rejected ("zg query requires a query or --hybrid/--fts/--vector
//     route"). The "hybrid" slot therefore carries an explicit
//     positional query — hybrid is the default route when a positional
//     query is supplied.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildQueryArgs } from "../src/args.ts";

const ok = process.env.ZG_TEST_E2E === "1";
const scratch = (): string => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-e2e-`);
  cpSync(
    fileURLToPath(new URL("fixtures/sample-project", import.meta.url)),
    dir,
    { recursive: true }
  );
  return dir;
};

(ok ? test : test.skip)(
  "e2e: probe, index, hybrid query finds hello.ts",
  (t) => {
    const dir = scratch();
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const probe = spawnSync("zg", ["status", "--check-ready"], {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.ifError(probe.error);
    assert.notEqual(probe.status, 0, "fresh scratch dir must not be ready");
    const index = spawnSync("zg", ["index"], { cwd: dir, encoding: "utf-8" });
    assert.equal(index.status, 0, `zg index failed: ${index.stderr}`);
    const r = spawnSync(
      "zg",
      buildQueryArgs({
        limit: 5,
        mode: "hybrid",
        preview: "short",
        query: "where is the theme restored",
      }),
      { cwd: dir, encoding: "utf-8" }
    );
    assert.equal(r.status, 0, `zg query failed: ${r.stderr}`);
    assert.match(r.stdout, /hello\.ts/u);
  }
);

(ok ? test : test.skip)("e2e: all four routes return hits", (t) => {
  const dir = scratch();
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const index = spawnSync("zg", ["index"], { cwd: dir, encoding: "utf-8" });
  assert.equal(index.status, 0, `zg index failed: ${index.stderr}`);
  // Every route's argv is built by buildQueryArgs, so the e2e doubles
  // as a smoke test of the builder against the real binary. rg omits
  // --preview/--mode/--refresh internally; we still pass preview:
  // "none" because QueryInput requires it. glob: "*.ts" on the rg slot
  // exercises the -g branch on the non-indexed path.
  const modes = [
    {
      mode: "hybrid",
      preview: "short",
      query: "where is the theme restored",
    },
    { mode: "fts", preview: "none", query: "loadTheme" },
    {
      mode: "vector",
      preview: "none",
      query: "restore user theme at startup",
    },
    { glob: "*.ts", mode: "rg", preview: "none", query: "loadTheme" },
  ] as const;
  for (const m of modes) {
    const r = spawnSync("zg", buildQueryArgs({ limit: 5, ...m }), {
      cwd: dir,
      encoding: "utf-8",
    });
    assert.equal(
      r.status,
      0,
      `route ${m.mode} exited ${r.status}: ${r.stderr}`
    );
    assert.match(
      r.stdout,
      /hello\.ts|loadTheme/u,
      `route ${m.mode} returned no relevant hit`
    );
  }
});
