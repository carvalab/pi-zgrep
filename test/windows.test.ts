import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseIndexCommandArgs } from "../src/args.ts";
import { makeRunner } from "../src/index.ts";
import { parseQueryOutput } from "../src/parse.ts";

test("empty indexed groups parse as empty results instead of format errors", () => {
  assert.deepEqual(
    parseQueryOutput(
      "query groups (1):\nQ1 [supplemental]: absent\nhits: 0\n\nNo matches.\n"
    ),
    { results: [] }
  );
});

test("indexed paths retain spaces, drive letters and ranking attributes", () => {
  for (const file of [
    "docs/file name.md",
    "C:\\Work Folder\\file name.ts",
    "C:/Work Folder/file name.ts",
  ]) {
    const text = `query groups (1):\nQ1 [primary]: sample\nhits: 1\n#1 score=0.8 matchedBy=fts+vector ${file}:12-14\nsource:\n12\tfunction retry() {}\n`;
    const parsed = parseQueryOutput(text);
    assert.ok("results" in parsed);
    assert.equal(parsed.results[0].file, file);
    assert.equal(parsed.results[0].score, 0.8);
    assert.equal(parsed.results[0].lineEnd, 14);
  }
});

test("rg paths retain spaces, Unicode and drive letters across groups", () => {
  const first = "C:\\Work Folder\\código.ts";
  const second = "docs/my notes.md";
  const parsed = parseQueryOutput(
    `${first}\n  2:\tfirst match\n  3-\tcontext\n--\n${second}\n  8: second match\n`
  );
  assert.ok("results" in parsed);
  assert.deepEqual(
    parsed.results.map((hit) => hit.file),
    [first, second]
  );
});

test("index command preserves quoted roots and option values without shell expansion", () => {
  const root = "C:\\Work Folder\\project";
  const parsed = parseIndexCommandArgs(
    `"${root}" --embedding local/potion-code-16m-v2 -g "src/**/*.ts" --mode direct --future-option "value & $literal"`,
    (p) => p === root
  );
  assert.deepEqual(parsed, {
    args: [
      root,
      "--embedding",
      "local/potion-code-16m-v2",
      "-g",
      "src/**/*.ts",
      "--mode",
      "direct",
      "--future-option",
      "value & $literal",
    ],
    ok: true,
  });
  assert.deepEqual(
    parseIndexCommandArgs("--embedding local/potion-code-16m-v2", () => false),
    { args: ["--embedding", "local/potion-code-16m-v2"], ok: true }
  );
  assert.deepEqual(parseIndexCommandArgs("'unclosed"), { ok: false });
});

test("JS override forwards spaces and shell metacharacters literally; cancellation kills the child", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi zg runner "));
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, "fake engine.cjs");
  writeFileSync(
    file,
    'if(process.argv[2]==="wait"){setTimeout(()=>{},30000)}else{console.log(JSON.stringify(process.argv.slice(2)))}'
  );
  const runner = makeRunner({
    cwd: dir,
    env: { ...process.env, PI_ZG_BIN: file },
  });
  const arg = 'path with spaces & $literal | < > %PATH% "quotes"';
  const result = await runner.run([arg]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), [arg]);
  const controller = new AbortController();
  const cancellable = makeRunner({
    cwd: dir,
    env: { ...process.env, PI_ZG_BIN: file },
    signal: controller.signal,
  });
  const pending = cancellable.run(["wait"]);
  controller.abort();
  const stopped = await pending;
  assert.notEqual(stopped.code, 0);
  assert.throws(() => cancellable.run(["wait"]), /aborted/iu);
});

test(
  "Windows npm CMD shim executes without changing the real global installation",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), "pi zg npm "));
    t.after(() => rmSync(dir, { force: true, recursive: true }));
    const log = path.join(dir, "install.json");
    const cli = path.join(dir, "fake npm.cjs");
    writeFileSync(
      cli,
      'require("node:fs").writeFileSync(process.env.TEST_INSTALL_LOG,JSON.stringify(process.argv.slice(2)))'
    );
    writeFileSync(
      path.join(dir, "npm.cmd"),
      `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`
    );
    await makeRunner({
      cwd: dir,
      env: { ...process.env, PATH: dir, Path: dir, TEST_INSTALL_LOG: log },
    }).install();
    const { readFileSync } = await import("node:fs");
    assert.deepEqual(JSON.parse(readFileSync(log, "utf-8")), [
      "install",
      "-g",
      "@zvec/zvec-grep",
    ]);
  }
);
