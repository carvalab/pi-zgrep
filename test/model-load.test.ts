// Regression for issue #6: `zg index` fails to load the local embedding model
// (MODEL2VEC_LOAD_FAILED, reported cause a uv_cwd ENOENT).
//
// Gated on ZG_TEST_MODEL=1: it drives the real engine and downloads the ~32 MiB
// model on a cold cache. The unit suite stays hermetic. CI runs it on every
// job.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { resolveLocalZgCli } from "../src/index.ts";

const ok = process.env.ZG_TEST_MODEL === "1";

(ok ? test : test.skip)(
  "zg index loads the local embedding model (issue #6)",
  { timeout: 600_000 },
  (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi-zg-model-"));
    writeFileSync(path.join(dir, "hello.ts"), "export const ready = true;\n");
    t.after(() => rmSync(dir, { force: true, recursive: true }));

    // The packaged engine is a JS entry; run it under this process's node, the
    // same way the extension spawns it.
    const cli = resolveLocalZgCli(
      fileURLToPath(new URL("../src", import.meta.url))
    );
    assert.ok(cli, "packaged @zvec/zvec-grep CLI not found — run npm ci first");
    const [cmd, prefix] = cli.endsWith(".js")
      ? [process.execPath, [cli]]
      : [cli, []];

    // --mode direct: load the model in this process. With a daemon running
    // (any dev machine), auto mode hands the build to it, which tests the
    // daemon's model load instead and prints a different summary.
    const index = spawnSync(
      cmd,
      [...prefix, "index", dir, "--debug", "--mode", "direct"],
      {
        cwd: dir,
        encoding: "utf-8",
        timeout: 540_000,
      }
    );
    const out = `${index.stdout ?? ""}\n${index.stderr ?? ""}`;
    assert.equal(
      index.status,
      0,
      `zg index failed on ${process.platform}/${process.arch} node ${process.version}:\n${out}`
    );
    // The reported failure prints "Workspace index: failed" before the
    // MODEL2VEC_LOAD_FAILED block. Exit 0 alone is not enough: a build that
    // indexed nothing still exits 0.
    assert.doesNotMatch(out, /Workspace index: failed|MODEL2VEC_LOAD_FAILED/u);
    assert.match(out, /files\s+1 scanned/u);
  }
);
