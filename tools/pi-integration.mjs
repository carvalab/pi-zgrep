// Real pi integration: loads this package's extension and skill into a pi
// session and asks the model to search the fixture with the zg tool.
//
// Needs OPENROUTER_API_KEY. The model is openrouter/free, which picks a free
// model that supports tool calling. Skipped (exit 0) when the key is absent,
// so a fork without the secret still passes CI.
//
// The session runs in a scratch dir with its own agent dir, so it never reads
// or writes the machine's ~/.pi. The prompt forbids reading or editing files;
// the assertion is that the session log contains a zg tool call that returned
// the fixture file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A local .env (gitignored) carries the key for runs outside CI.
const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (!process.env.OPENROUTER_API_KEY && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.log("OPENROUTER_API_KEY unset, skipping the pi integration run");
  process.exit(0);
}

const root = fileURLToPath(new URL("..", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "pi-zg-pi-"));
const work = path.join(scratch, "work");
const agentDir = path.join(scratch, "agent");
const sessionDir = path.join(scratch, "sessions");
cpSync(path.join(root, "test/fixtures/sample-project"), work, {
  recursive: true,
});

const prompt = [
  "Use the zg tool, and only the zg tool, to search this workspace.",
  "Call it once with query 'where is the theme restored', mode hybrid, limit 3.",
  "Do not read or edit any file and do not run any other tool.",
  "Reply with the file path the tool returned and nothing else.",
].join(" ");

const run = spawnSync(
  "pi",
  [
    "--approve",
    "-e",
    path.join(root, "src/index.ts"),
    "--skill",
    path.join(root, "skills"),
    "--provider",
    "openrouter",
    "--model",
    "openrouter/free",
    "--thinking",
    "off",
    "--session-dir",
    sessionDir,
    "--name",
    "pi-zgrep-integration",
    "-p",
    prompt,
  ],
  {
    cwd: work,
    encoding: "utf-8",
    timeout: 240_000,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      OPENROUTER_API_KEY: key,
    },
  }
);

const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const logs = readdirSync(sessionDir, { recursive: true })
  .map(String)
  .filter((name) => name.endsWith(".jsonl"))
  .map((name) => readFileSync(path.join(sessionDir, name), "utf-8"))
  .join("\n");

try {
  assert.equal(
    run.status,
    0,
    `pi exited ${run.status} (${run.error?.message ?? "no spawn error"}):\n${output}`
  );
  assert.match(
    logs,
    /"name"\s*:\s*"zg"/u,
    `session log has no zg tool call:\n${output}`
  );
  assert.match(
    logs,
    /hello\.ts/u,
    `zg tool result does not mention the fixture file:\n${logs.slice(-4000)}`
  );
  console.log("pi integration passed: zg tool called, hello.ts returned");
} finally {
  rmSync(scratch, { force: true, recursive: true });
}
