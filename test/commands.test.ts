// Command/tool handlers that spawn: hermetic via a fake `zg` shell script in
// PI_ZG_BIN (exclusive candidate). Two contracts are pinned here:
//   - /zg-index probes before it spawns anything, so a 0.2.x binary on PATH
//     never receives `--status`/`--index` (it would read them as queries).
//   - the zg tool surfaces upstream stderr on a non-zero query exit instead of
//     parsing an empty stdout into an "unparsed" body.

import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { registerZgIndexCommand, registerZgTool } from "../src/index.ts";

type Notify = (message: string, type?: string) => void;

interface FakeCtx {
  cwd: string;
  ui: {
    notify: Notify;
    setStatus: (key: string, text: string | undefined) => void;
  };
}

const makeFakeZg = (dir: string, script: string): string => {
  const bin = path.join(dir, "zg");
  writeFileSync(bin, script);
  chmodSync(bin, 0o755);
  return bin;
};

const withTempDir = async (
  fn: (dir: string) => Promise<void>
): Promise<void> => {
  const dir = mkdtempSync(`${tmpdir()}/pi-zg-commands-`);
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

const withPiZgBin = async (
  bin: string,
  fn: () => Promise<void>
): Promise<void> => {
  const previous = process.env.PI_ZG_BIN;
  process.env.PI_ZG_BIN = bin;
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.PI_ZG_BIN;
    } else {
      process.env.PI_ZG_BIN = previous;
    }
  }
};

interface CapturedCommand {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

const captureIndexCommand = (): CapturedCommand => {
  let captured: CapturedCommand | undefined;
  registerZgIndexCommand({
    registerCommand: (name: string, def: CapturedCommand): void => {
      if (name === "zg-index") {
        captured = def;
      }
    },
  } as unknown as Parameters<typeof registerZgIndexCommand>[0]);
  assert.ok(captured, "registerZgIndexCommand must register `zg-index`");
  return captured;
};

interface CapturedTool {
  name: string;
  execute: (
    id: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown
  ) => Promise<unknown>;
}

const captureZgTool = (): CapturedTool => {
  let captured: CapturedTool | undefined;
  registerZgTool({
    registerTool: (def: CapturedTool): void => {
      captured = def;
    },
  } as unknown as Parameters<typeof registerZgTool>[0]);
  assert.ok(captured, "registerZgTool must register the `zg` tool");
  return captured;
};

test("/zg-index bails on an older binary without spawning a build", async () => {
  await withTempDir(async (dir) => {
    const log = path.join(dir, "calls.log");
    // A real 0.2.x stand-in: answers `--version` with 0.2.1 and logs argv[1],
    // so the assertion below can prove no `--status`/`--index` ever ran.
    const bin = makeFakeZg(
      dir,
      `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\ncase "$1" in\n  --version) echo "0.2.1" ;;\nesac\nexit 0\n`
    );
    await withPiZgBin(bin, async () => {
      const command = captureIndexCommand();
      const notes: string[] = [];
      const statuses: (string | undefined)[] = [];
      const ctx: FakeCtx = {
        cwd: dir,
        ui: {
          notify: (message: string): void => {
            notes.push(message);
          },
          setStatus: (_key: string, text: string | undefined): void => {
            statuses.push(text);
          },
        },
      };
      await command.handler("--rebuild", ctx);

      const spawned = readFileSync(log, "utf-8").split("\n").filter(Boolean);
      assert.deepEqual(
        spawned,
        ["--version"],
        "only the version probe may spawn; no --status/--index build"
      );
      assert.deepEqual(statuses, [], "a rejected binary must not set a status");
      assert.equal(notes.length, 1);
      assert.match(
        notes[0],
        /0\.2\.1 — zg 0\.3\.0 or newer is required/u,
        `expected the version gate to be named; got ${notes[0]}`
      );
    });
  });
});

test("zg tool reports upstream stderr when the query exits non-zero", async () => {
  await withTempDir(async (dir) => {
    const bin = makeFakeZg(
      dir,
      '#!/bin/sh\ncase "$1" in\n  --version) echo "0.3.0"; exit 0 ;;\nesac\necho "error: unexpected argument \'--fts\' found" >&2\nexit 2\n'
    );
    await withPiZgBin(bin, async () => {
      const tool = captureZgTool();
      const ctx: FakeCtx = {
        cwd: dir,
        ui: { notify: (): void => undefined, setStatus: (): void => undefined },
      };
      // mode=rg skips ensureIndex, so the failing spawn is the query itself.
      const res = (await tool.execute(
        "call-1",
        { mode: "rg", query: "loadTheme" },
        undefined,
        undefined,
        ctx
      )) as { content: { text: string }[]; details?: { isError?: boolean } };

      assert.equal(
        res.details?.isError,
        true,
        "a failed query is a tool error"
      );
      assert.match(
        res.content[0].text,
        /^zg error \(exit 2\): error: unexpected argument/u,
        `expected stderr to be surfaced; got ${res.content[0].text}`
      );
    });
  });
});
