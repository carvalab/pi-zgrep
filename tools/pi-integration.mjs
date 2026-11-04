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
// Needs OPENROUTER_API_KEY. The model is pinned (see MODELS) rather than
// openrouter/free: the router sometimes landed on a model that rejects a
// non-reasoning request with "400: Reasoning is mandatory" before any tool call,
// which failed this job for a reason that had nothing to do with the package.
// Skipped (exit 0) when the key is absent, so a fork without the secret still
// passes CI — the assertions themselves are then self-checked against
// handcrafted session entries instead.
//
// A failed session is classified before it is allowed to fail the job:
//   provider-side — HTTP 4xx/5xx from the provider, 429, a model that demands
//   reasoning, no assistant message, or a model that never called any tool — is
//   retried once on the backup model and, if that also fails provider-side, ends
//   as "INCONCLUSIVE: <reason>" with exit 0 plus a line in $GITHUB_STEP_SUMMARY:
//   the package was never exercised, so the run proves nothing either way.
//   extension-side — a zg tool result that is an error, a result without the
//   fixture hit, an install or version check that failed, no zg tool in the
//   prompt — always exits 1 and is never retried.
//
// PI_ZG_IT_NEGATIVE=1 runs the same session with PI_ZG_BIN pointing at a path
// that does not exist. PI_ZG_BIN is exclusive in the extension, so zg can only
// fail: this is the negative proof that the assertions above actually check the
// engine rather than passing on any session. It is extension-side, so it stays
// red: exit 1, never retried, never INCONCLUSIVE.
//
// PI_ZG_IT_MODEL, PI_ZG_IT_BACKUP_MODEL and PI_ZG_IT_THINKING override the pins.
//
// The session runs in a scratch dir with its own agent dir, so it never reads
// or writes the machine's ~/.pi. The prompt forbids reading or editing files.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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

// --- Models ------------------------------------------------------------------
// Pinned so the run depends on a model that advertises tool calling and on the
// reasoning level that model needs, not on whatever openrouter/free picks. Both
// pins list tools, tool_choice and reasoning in OpenRouter's catalog
// (https://openrouter.ai/api/v1/models), so a reasoning request is valid for
// them and no endpoint can answer "Reasoning is mandatory".
//
// Evidence, one session per model against the installed package (2026-11-04):
// nvidia/nemotron-3-ultra-550b-a55b:free called zg and hit hello.ts on the first
// attempt; openai/gpt-oss-120b did the same; google/gemma-4-31b-it:free answered
// 429 "temporarily rate-limited upstream" on its free endpoint (Google AI Studio)
// and only got there through the fallback, so it is not the primary.
export const MODELS = {
  // Free, 1M context, tools + tool_choice + reasoning, five upstream providers.
  primary:
    process.env.PI_ZG_IT_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
  // Cheapest paid model with tools and reasoning ($0.022/M prompt tokens), with a
  // wide provider pool, so a fallback run costs a fraction of a cent. It also runs
  // the negative proof: a throttled free endpoint would mask the engine failure.
  backup: process.env.PI_ZG_IT_BACKUP_MODEL || "openai/gpt-oss-120b",
};

// The reasoning level each model needs. Both reason by default on their
// OpenRouter endpoints; asking for reasoning explicitly is what keeps the request
// valid where an endpoint refuses a non-reasoning call.
export const THINKING = {
  "nvidia/nemotron-3-ultra-550b-a55b:free": "high",
  "openai/gpt-oss-120b": "high",
};

export const thinkingFor = (model) =>
  THINKING[model] ?? process.env.PI_ZG_IT_THINKING ?? "high";

// --- Failure classification ---------------------------------------------------
// Whose fault a failed session is. Provider-side means the package was never
// exercised (nothing was proven, so the run is inconclusive); extension-side
// means the package or the engine misbehaved (a real failure, red).
const HTTP_ERROR =
  /\b(?:HTTP[\s/]*)?(?:400|401|402|403|404|408|409|422|429|500|502|503|504|529)\b|"(?:code|status)"\s*:\s*(?:4\d\d|5\d\d)\b|rate.?limit/iu;
const ERROR_CONTEXT =
  /\b(?:error|errors|failed|failure|invalid|rejected|refused|denied|unavailable|overloaded|rate.?limit|too many|exceeded|timeout|status)\b/iu;
const REASONING_REQUIRED =
  /reasoning is mandatory|reasoning (?:is )?required/iu;
const LOAD_ERROR =
  /failed to load (?:the )?(?:extension|package)|cannot find module/iu;

// The first line of pi's own output that blames the provider, or null.
export const providerEvidence = (output) => {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const reasoning = lines.find((line) => REASONING_REQUIRED.test(line));
  if (reasoning !== undefined) {
    return `the model requires reasoning: ${reasoning.slice(0, 200)}`;
  }
  const http = lines.find(
    (line) => HTTP_ERROR.test(line) && ERROR_CONTEXT.test(line)
  );
  if (http !== undefined) {
    return `the provider returned an error: ${http.slice(0, 200)}`;
  }
  return null;
};

// null when the session proves the package works, otherwise
// { kind: "provider" | "extension", reason }.
export const evaluateRun = ({ status, output, entries }) => {
  const extensionFailure = (reason) => ({ kind: "extension", reason });
  const results = zgToolResults(entries);
  const errored = results.find(
    (message) => message.isError === true || message.details?.isError === true
  );
  if (errored !== undefined) {
    return extensionFailure(
      `zg tool result is an error: ${textOf(errored).slice(0, 400)}`
    );
  }
  const hits = results.flatMap(
    (message) =>
      message.details?.results ?? message.structuredContent?.results ?? []
  );
  const hit = hits.find(
    (result) =>
      typeof result?.file === "string" && result.file.endsWith("hello.ts")
  );
  if (results.length > 0 && hit === undefined) {
    return extensionFailure(
      `zg tool result has no hello.ts hit: ${JSON.stringify(hits).slice(0, 400)}`
    );
  }
  if (hit !== undefined) {
    // The engine answered correctly, so a nonzero exit is the package's fault.
    return status === 0
      ? null
      : extensionFailure(
          `pi exited ${status} after the zg tool returned the fixture:\n${output.slice(-800)}`
        );
  }

  // No zg tool result at all: decide whose fault that is.
  const loadFailure = output.split("\n").find((line) => LOAD_ERROR.test(line));
  if (loadFailure !== undefined) {
    return extensionFailure(
      `pi could not load the package: ${loadFailure.trim().slice(0, 300)}`
    );
  }
  if (entries.length > 0 && !zgToolDeclared(entries)) {
    return extensionFailure(
      "the session declared no zg tool: the installed package registered nothing"
    );
  }
  const stopped = entries.find(
    (entry) =>
      entry?.message?.role === "assistant" &&
      entry.message.stopReason === "error"
  );
  if (stopped !== undefined) {
    return {
      kind: "provider",
      reason: `provider error: ${String(stopped.message.errorMessage ?? "(no message)").slice(0, 300)}`,
    };
  }
  const evidence = providerEvidence(output);
  if (evidence !== null) {
    return { kind: "provider", reason: evidence };
  }
  const assistant = entries
    .filter((entry) => entry?.message?.role === "assistant")
    .map((entry) => entry.message);
  if (assistant.length === 0) {
    return {
      kind: "provider",
      reason: `no assistant message in the session (pi exited ${status})`,
    };
  }
  const calledTools = assistant.some((message) =>
    (message.content ?? []).some((block) => block?.type === "toolCall")
  );
  if (!calledTools) {
    const said = assistant
      .map((message) => textOf(message))
      .join(" ")
      .trim();
    return {
      kind: "provider",
      reason: `the model never called any tool (pi exited ${status}): ${said.slice(0, 300) || "(no text)"}`,
    };
  }
  return {
    kind: "provider",
    reason: `the model called other tools but never zg (pi exited ${status})`,
  };
};

// CI shows this line in the job summary, so a run that proves nothing is
// visible without opening the log.
const writeSummary = (line) => {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `${line}\n`);
  }
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

      // The classification that decides red vs INCONCLUSIVE is the part a
      // keyless run can still prove: each case below is the shape pi writes for
      // that failure, and `kind` says whether it may be retried.
      const assistant = (extra) => ({
        message: { role: "assistant", stopReason: "stop", ...extra },
        type: "message",
      });
      const zgResult = (entries) => ({
        message: {
          content: [{ text: "…", type: "text" }],
          details: { results: entries },
          isError: false,
          role: "toolResult",
          toolName: "zg",
        },
        type: "message",
      });
      const cases = [
        [
          "fixture hit",
          [promptEntry, zgResult([{ file: "hello.ts" }])],
          0,
          "",
          null,
        ],
        [
          "reasoning mandatory",
          [
            promptEntry,
            assistant({
              errorMessage: "400: Reasoning is mandatory",
              stopReason: "error",
            }),
          ],
          1,
          "",
          "provider",
        ],
        [
          "HTTP 502 in output",
          [promptEntry],
          1,
          "HTTP 502: upstream unavailable",
          "provider",
        ],
        ["no assistant message", [promptEntry], 1, "", "provider"],
        [
          "no tool call",
          [
            promptEntry,
            assistant({ content: [{ text: "Sorry, cannot.", type: "text" }] }),
          ],
          1,
          "",
          "provider",
        ],
        [
          "other tool only",
          [
            promptEntry,
            assistant({
              content: [
                { args: {}, id: "call_1", name: "read", type: "toolCall" },
              ],
              stopReason: "toolUse",
            }),
          ],
          1,
          "",
          "provider",
        ],
        [
          "no fixture hit",
          [promptEntry, zgResult([{ file: "other.ts" }])],
          1,
          "",
          "extension",
        ],
        [
          "no zg declared",
          [
            {
              message: {
                role: "system",
                sections: { tools: "<tools>\n- read: read a file\n</tools>" },
              },
              type: "message",
            },
          ],
          1,
          "",
          "extension",
        ],
      ];
      for (const [name, entries, status, output, expected] of cases) {
        const verdict = evaluateRun({ entries, output, status });
        assert.equal(
          verdict?.kind ?? null,
          expected,
          `classification of "${name}" must be ${expected ?? "green"}, got ${JSON.stringify(verdict)}`
        );
      }
      console.log(
        `pi integration assertions self-checked: ${hit.file} accepted, error session rejected, ${cases.length} classification cases confirmed`
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

    // 2. One session per attempt, each loading the installed package: no -e, and
    //    no --skill because the package's pi manifest already ships skills/. Each
    //    attempt gets its own session dir so two runs never share entries.
    const prompt = [
      "Use the zg tool, and only the zg tool, to search this workspace.",
      "Call it once with query 'where is the theme restored', mode hybrid, limit 3.",
      "Do not read or edit any file and do not run any other tool.",
      "Reply with the file path the tool returned and nothing else.",
    ].join(" ");
    const attempt = (label, model) => {
      const dir = path.join(sessionDir, label);
      console.log(
        `pi integration: ${label} run on ${model} (thinking ${thinkingFor(model)})`
      );
      const run = spawnSync(
        "pi",
        [
          "--approve",
          "--provider",
          "openrouter",
          "--model",
          model,
          "--thinking",
          thinkingFor(model),
          "--session-dir",
          dir,
          "--name",
          `pi-zgrep-integration-${label}`,
          "-p",
          prompt,
        ],
        { cwd: work, encoding: "utf-8", env: piEnv, timeout: 240_000 }
      );
      const entries = readSessionEntries(dir);
      const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}\n${run.error?.message ?? ""}`;
      return {
        context: `${describeSession(entries)}\npi stdout: ${(run.stdout ?? "").slice(-800)}\npi stderr: ${(run.stderr ?? "").slice(-800)}`,
        entries,
        failure: evaluateRun({ entries, output, status: run.status }),
        model,
      };
    };

    const reportPass = (run, how) => {
      // 3. The structured result, not a substring of the log.
      const hit = assertZgHit(run.entries, run.context);
      console.log(
        `pi integration: session declared tools: ${declaredToolNames(run.entries).join(", ")}`
      );
      console.log(
        `pi integration: zg hit ${hit.file}:${hit.lineStart}${hit.lineEnd === undefined ? "" : `-${hit.lineEnd}`}`
      );
      console.log(
        `pi integration passed (${how}): installed package's zg tool returned hello.ts`
      );
    };

    // Extension-side: the package genuinely failed. Red, and never retried.
    const reportExtensionFailure = (run, reason) => {
      console.error(
        `pi integration FAILED — extension-side, not retried (${run.model}): ${reason}\n${run.context}`
      );
      writeSummary(
        `pi integration failed (extension-side): ${run.model}: ${reason}`
      );
      process.exitCode = 1;
    };

    if (negative) {
      const missing = path.join(scratch, "missing-zg");
      piEnv.PI_ZG_BIN = missing;
      console.log(
        `pi integration: PI_ZG_IT_NEGATIVE=1, running with PI_ZG_BIN=${missing}; this run must fail and must not be retried`
      );
      // One attempt, no fallback: the proof is about the engine, not the model.
      // It runs on the backup model because a free endpoint that throttles would
      // fail before zg is ever called, which masks the engine rather than
      // proving it; the backup is the paid, reliable pin.
      const negativeModel =
        process.env.PI_ZG_IT_NEGATIVE_MODEL || MODELS.backup;
      const run = attempt("negative", negativeModel);
      if (run.failure === null) {
        throw new Error(
          "PI_ZG_IT_NEGATIVE=1 passed every assertion: the negative proof is broken"
        );
      }
      if (run.failure.kind === "extension") {
        // The proof holds: with a broken engine the hit assertions cannot pass.
        console.error(
          `pi integration negative proof held — extension-side failure, not retried: ${run.failure.reason}`
        );
        writeSummary(
          `pi integration negative proof held: ${run.failure.reason}`
        );
        process.exitCode = 1;
        return;
      }
      // The model never reached the engine, so nothing was proven. Still red,
      // with the reason, because the negative proof is an extension-side check.
      console.error(
        `pi integration negative proof NOT demonstrated — provider-side flake before the engine ran: ${run.failure.reason}; rerun\n${run.context}`
      );
      writeSummary(
        `pi integration negative proof not demonstrated (provider-side): ${run.failure.reason}`
      );
      process.exitCode = 1;
      return;
    }

    const first = attempt("primary", MODELS.primary);
    if (first.failure === null) {
      reportPass(first, first.model);
      return;
    }
    if (first.failure.kind === "extension") {
      reportExtensionFailure(first, first.failure.reason);
      return;
    }
    console.error(
      `pi integration: provider-side failure on ${first.model} (${first.failure.reason}); retrying once on ${MODELS.backup}`
    );

    const retry = attempt("backup", MODELS.backup);
    if (retry.failure === null) {
      reportPass(
        retry,
        `${retry.model} fallback after a provider-side failure on ${first.model}`
      );
      return;
    }
    if (retry.failure.kind === "extension") {
      reportExtensionFailure(retry, retry.failure.reason);
      return;
    }
    // Both models failed provider-side: the package was never exercised.
    const reason = `${first.model}: ${first.failure.reason}; ${MODELS.backup}: ${retry.failure.reason}`;
    console.error(
      `INCONCLUSIVE: ${reason}\nThe package was never exercised, so this run proves nothing either way; rerun the job.`
    );
    writeSummary(`INCONCLUSIVE: ${reason}`);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === here) {
  main();
}
