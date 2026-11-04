// Real pi integration: installs this repo the way a user does — `npm pack`
// then pi's own package installer — and runs one pi session that loads the
// INSTALLED package (no `-e src/index.ts`) and asks the model to search the
// fixture with the zg tool.
//
// What is asserted, in order:
//   1. the installed tree carries the per-platform engine
//      (node_modules/@zvec/zvec-grep-<platform>/bin/zg) and it runs, reporting
//      a 0.3.x version;
//   2. the session's zg toolResult is not an error;
//   3. that result's structured details name a hit on the fixture file.
//
// Needs OPENROUTER_API_KEY. The model is openrouter/free, which picks a free
// model that supports tool calling. Skipped (exit 0) when the key is absent, so
// a fork without the secret still passes CI — the assertions themselves are
// then self-checked against handcrafted session entries instead.
//
// PI_ZG_IT_NEGATIVE=1 runs the same session with PI_ZG_BIN pointing at a path
// that does not exist. PI_ZG_BIN is exclusive in the extension, so zg can only
// fail: this is the negative proof that the assertions above actually check the
// engine rather than passing on any session.
//
// The session runs in a scratch dir with its own agent dir, so it never reads
// or writes the machine's ~/.pi. The prompt forbids reading or editing files.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), "..");

// --- Session assertions ------------------------------------------------------
// Exported so the no-key path can prove them against handcrafted entries.

// Every entry of every .jsonl under `dir`, in file order. Sessions are JSONL,
// one entry object per line (docs/session-format.md); a line that does not
// parse means the format changed, so it throws instead of being skipped.
export const readSessionEntries = (dir) => {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) =>
      readFileSync(path.join(dir, name), "utf-8")
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line))
    );
};

// The zg toolResult messages a session recorded, in call order.
export const zgToolResults = (entries) =>
  entries
    .filter(
      (entry) =>
        entry?.type === "message" &&
        entry.message?.role === "toolResult" &&
        entry.message.toolName === "zg"
    )
    .map((entry) => entry.message);

const textOf = (message) =>
  (message?.content ?? [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text)
    .join("\n");

// Tool names the session declared to the model, read from the persisted prompt
// sections (plus the per-request tool diffs some sessions record). The session
// runs without `-e`, so `zg` appearing here means the installed package's
// extension registered it — that is what makes this an installed-package run.
export const declaredToolNames = (entries) => {
  const names = new Set();
  for (const entry of entries) {
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "system") {
      continue;
    }
    for (const tool of message.toolsAdded ?? []) {
      if (typeof tool?.name === "string") {
        names.add(tool.name);
      }
    }
    for (const section of Object.values(message.sections ?? {})) {
      // Only the tool list block counts: other sections also use "- name: text".
      const tools = /<tools>([\s\S]*?)<\/tools>/u.exec(
        typeof section === "string" ? section : ""
      );
      if (tools === null) {
        continue;
      }
      for (const match of tools[1].matchAll(/^- ([\w-]+): /gmu)) {
        names.add(match[1]);
      }
    }
  }
  return [...names];
};

export const zgToolDeclared = (entries) =>
  declaredToolNames(entries).includes("zg");

// What the session actually did, for the failure messages: which tools the
// model was offered and what it said instead of calling zg.
export const describeSession = (entries) => {
  const tools = declaredToolNames(entries);
  const said = entries
    .filter((entry) => entry.message?.role === "assistant")
    .map((entry) => textOf(entry.message))
    .join("\n")
    .trim();
  return `declared tools: ${tools.length > 0 ? tools.join(", ") : "(none)"}\nassistant said: ${said.slice(0, 600) || "(nothing)"}`;
};

// Throws unless the session made a successful zg call whose structured results
// include a hit on hello.ts. Returns that hit for the log line. `context` is
// appended to every message so a CI failure explains itself.
export const assertZgHit = (entries, context = "") => {
  const fail = (message) => (context ? `${message}\n${context}` : message);
  const results = zgToolResults(entries);
  assert.ok(
    results.length > 0,
    fail(
      "session has no zg tool result (the installed package's tool never ran)"
    )
  );
  const failed = results.find(
    (message) => message.isError === true || message.details?.isError === true
  );
  assert.ok(
    failed === undefined,
    fail(`zg tool result is an error: ${textOf(failed)}`)
  );
  const ok = results.find((message) => message.isError !== true);
  const hits = ok?.details?.results ?? ok?.structuredContent?.results ?? [];
  const hit = hits.find(
    (result) =>
      typeof result?.file === "string" && result.file.endsWith("hello.ts")
  );
  assert.ok(
    hit !== undefined,
    fail(
      `zg tool result has no hello.ts hit: ${JSON.stringify(hits).slice(0, 600)}`
    )
  );
  return hit;
};

// --- Run ---------------------------------------------------------------------

const main = () => {
  // A local .env (gitignored) carries the key for runs outside CI.
  const envFile = path.join(root, ".env");
  if (!process.env.OPENROUTER_API_KEY && existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  const key = process.env.OPENROUTER_API_KEY;
  const negative = process.env.PI_ZG_IT_NEGATIVE === "1";

  const scratch = mkdtempSync(path.join(tmpdir(), "pi-zg-pi-"));
  try {
    if (!key) {
      // No key: prove the assertions instead. Two handcrafted sessions in the
      // shape pi writes (a session dir of JSONL entries) — one with the hit the
      // real run asserts, one with the error result PI_ZG_BIN=missing produces.
      console.log(
        "OPENROUTER_API_KEY unset, skipping the pi integration run; proving the session assertions on handcrafted session files instead"
      );
      const promptEntry = {
        message: {
          role: "system",
          sections: {
            tools:
              "<tools>\n- zg: Search workspace code and content…\n</tools>",
          },
        },
        type: "message",
      };
      const writeSession = (name, entries) => {
        const dir = path.join(scratch, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, `${name}.jsonl`),
          `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`
        );
        return dir;
      };
      const hitDir = writeSession("handcrafted-hit", [
        promptEntry,
        {
          message: {
            content: [
              { text: "hello.ts:2-4\tfunction loadTheme", type: "text" },
            ],
            details: { results: [{ file: "hello.ts", lineStart: 2 }] },
            isError: false,
            role: "toolResult",
            toolName: "zg",
          },
          type: "message",
        },
      ]);
      const errorDir = writeSession("handcrafted-error", [
        promptEntry,
        {
          message: {
            content: [
              {
                text: "zg error: PI_ZG_BIN is set to /tmp/missing-zg but it cannot be run",
                type: "text",
              },
            ],
            details: { isError: true },
            isError: true,
            role: "toolResult",
            toolName: "zg",
          },
          type: "message",
        },
      ]);

      const hit = assertZgHit(readSessionEntries(hitDir));
      assert.ok(
        zgToolDeclared(readSessionEntries(hitDir)),
        "handcrafted hit session must declare the zg tool"
      );
      assert.throws(
        () => assertZgHit(readSessionEntries(errorDir)),
        /zg tool result is an error/u
      );
      assert.throws(() => assertZgHit([]), /no zg tool result/u);
      console.log(
        `pi integration assertions self-checked: ${hit.file} accepted, error session rejected`
      );
      return;
    }

    const work = path.join(scratch, "work");
    const agentDir = path.join(scratch, "agent");
    const packDir = path.join(scratch, "pack");
    const sessionDir = path.join(scratch, "sessions");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(packDir, { recursive: true });
    cpSync(path.join(root, "test/fixtures/sample-project"), work, {
      recursive: true,
    });

    // 1. Pack the repo and install that tarball through pi's own installer, so
    //    the session below loads exactly what `npm publish` would ship. The
    //    npm: prefix routes it through `npm install` into <agent dir>/npm (a
    //    bare path would be loaded in place, with no tree to inspect), and the
    //    spec keeps the package name (`npm:<name>@file:<tgz>`): pi resolves an
    //    npm source's install path from the name in the spec, so a nameless
    //    `npm:<tgz>` installs the tree and then never loads a resource from it.
    const pkgName = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf-8")
    ).name;
    const pack = spawnSync(
      "npm",
      ["pack", "--pack-destination", packDir, "--loglevel", "error"],
      { cwd: root, encoding: "utf-8" }
    );
    assert.equal(
      pack.status,
      0,
      `npm pack failed: ${pack.stderr ?? ""}${pack.error?.message ?? ""}`
    );
    const packed = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
    assert.equal(packed.length, 1, `npm pack wrote ${packed.join(", ")}`);
    const tgz = path.join(packDir, packed[0]);
    console.log(`pi integration: packed ${tgz}`);

    const piEnv = {
      ...process.env,
      // npm must not run the engine's postinstall: the point is that the
      // native payload arrives as an optional dependency, as for a user.
      npm_config_ignore_scripts: "true",
      PI_CODING_AGENT_DIR: agentDir,
    };
    const install = spawnSync("pi", ["install", `npm:${pkgName}@file:${tgz}`], {
      cwd: scratch,
      encoding: "utf-8",
      env: piEnv,
      timeout: 300_000,
    });
    assert.equal(
      install.status,
      0,
      `pi install failed: ${(install.stdout ?? "").slice(-2000)}\n${(install.stderr ?? "").slice(-2000)}`
    );

    // The installed package is the one pi will load; the engine must be in the
    // tree next to it, exactly where the extension looks for it.
    const modules = path.join(agentDir, "npm", "node_modules");
    const pkgDir = path.join(modules, pkgName);
    assert.ok(
      existsSync(path.join(pkgDir, "src", "index.ts")),
      `installed package missing at ${pkgDir}: ${readdirSync(modules).join(", ")}`
    );
    assert.ok(
      existsSync(path.join(pkgDir, "skills")),
      "installed package ships no skills/ (the run would need --skill)"
    );
    console.log(`pi integration: installed package ${pkgDir}`);

    const zvec = path.join(modules, "@zvec");
    const platformDirs = readdirSync(zvec).filter((name) =>
      /^zvec-grep-/u.test(name)
    );
    const zgBin = platformDirs
      .map((name) => path.join(zvec, name, "bin", "zg"))
      .find((candidate) => existsSync(candidate));
    assert.ok(
      zgBin !== undefined,
      `installed tree has no @zvec/zvec-grep-<platform>/bin/zg: ${readdirSync(zvec).join(", ")}`
    );
    const version = spawnSync(zgBin, ["--version"], { encoding: "utf-8" });
    assert.equal(
      version.status,
      0,
      `${zgBin} --version exited ${version.status}: ${version.stderr ?? ""}`
    );
    const reported = (version.stdout ?? "").trim();
    assert.match(reported, /^0\.3\./u, `engine reports ${reported}`);
    console.log(`pi integration: ${zgBin} --version -> ${reported}`);

    // 2. One session, loading the installed package: no -e, and no --skill
    //    because the package's pi manifest already ships skills/.
    const prompt = [
      "Use the zg tool, and only the zg tool, to search this workspace.",
      "Call it once with query 'where is the theme restored', mode hybrid, limit 3.",
      "Do not read or edit any file and do not run any other tool.",
      "Reply with the file path the tool returned and nothing else.",
    ].join(" ");
    if (negative) {
      const missing = path.join(scratch, "missing-zg");
      piEnv.PI_ZG_BIN = missing;
      console.log(
        `pi integration: PI_ZG_IT_NEGATIVE=1, running with PI_ZG_BIN=${missing}; this run must fail`
      );
    }
    const run = spawnSync(
      "pi",
      [
        "--approve",
        "--provider",
        "openrouter",
        "--model",
        // No --thinking flag: openrouter/free can route to a model that requires
        // reasoning, and "off" then fails with a 400 before the tool is called.
        "openrouter/free",
        "--session-dir",
        sessionDir,
        "--name",
        "pi-zgrep-integration",
        "-p",
        prompt,
      ],
      { cwd: work, encoding: "utf-8", env: piEnv, timeout: 240_000 }
    );

    const entries = readSessionEntries(sessionDir);
    const context = `${describeSession(entries)}\npi stdout: ${(run.stdout ?? "").slice(-800)}\npi stderr: ${(run.stderr ?? "").slice(-800)}`;
    // In the negative run the tool result is the whole point, so it is asserted
    // before the exit status: the failure has to name the zg error result.
    if (negative) {
      assertZgHit(entries, context);
    }
    assert.equal(
      run.status,
      0,
      `pi exited ${run.status} (${run.error?.message ?? "no spawn error"}):\n${context}`
    );
    assert.ok(
      zgToolDeclared(entries),
      `the installed package registered no zg tool in the session prompt\n${context}`
    );
    // 3. The structured result, not a substring of the log.
    const hit = assertZgHit(entries, context);
    console.log(
      `pi integration: session declared tools: ${declaredToolNames(entries).join(", ")}`
    );
    console.log(
      `pi integration: zg hit ${hit.file}:${hit.lineStart}${hit.lineEnd === undefined ? "" : `-${hit.lineEnd}`}`
    );
    // Unreachable while the assertions hold, but stated so a future edit that
    // weakens them cannot turn the negative run green.
    assert.ok(
      !negative,
      "PI_ZG_IT_NEGATIVE=1 passed the hit assertions: the negative proof is broken"
    );
    console.log(
      "pi integration passed: installed package's zg tool returned hello.ts"
    );
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === here) {
  main();
}
