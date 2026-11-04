// Measures whether a model reaches for the `zg` tool on its own.
//
// The prompt-set never names a tool: six concept questions where semantic
// search should win, three exact-identifier lookups where rg is fine, three
// tasks that need no search at all (control for spurious tool use), and four
// held-out concept prompts. Each prompt runs in its own `pi -p` session with
// this package's extension and skill loaded; the session .jsonl is then read
// for the first search-like tool call, which is what "routing" means here.
//
// A run needs a real provider. With OPENROUTER_API_KEY (from ../.env or the
// environment) the reference condition is `--model openrouter/free`; any other
// configured provider works the same way via --model provider/id.
//
// Workspace: a shallow clone of expressjs/express in $ZG_BENCH (default
// ~/.cache/zg-bench), pre-indexed by the bundled zg 0.3.0 with
// local/potion-code-16m-v2 so index build time cannot bias the choice. The
// agent dir is a scratch dir: the machine's ~/.pi is never read or written,
// unless --agent-from copies credentials into it (auth.json, models-store.json)
// because the run needs an already-logged-in provider.
//
// Usage:
//   node tools/routing-eval.mjs                                  # 16 prompts x 3 runs x 2 conditions
//   node tools/routing-eval.mjs --guidance 0 --runs 1            # baseline only
//   node tools/routing-eval.mjs --only holdout                   # held-out set
//   node tools/routing-eval.mjs --model zai/glm-5.3-flash --agent-from ~/.pi/agent
//   node tools/routing-eval.mjs --json out.json                  # CI-readable result file
//   node tools/routing-eval.mjs --subset concept,holdout --threshold 80  # CI gate
//
// One cheap, tool-capable model is pinned in PINNED_MODEL. Do not use
// openrouter/free here: that alias answers with a different model per request,
// so the routing rate would mix harness behavior with whichever model replied.
// The pinned model below is the zai route of OpenRouter's `z-ai/glm-5.3-flash`
// ($0.027/$0.10 per M tokens, tool calling on) — OpenRouter itself has no key on
// this machine; set OPENROUTER_API_KEY and --model openrouter/openai/gpt-oss-20b
// to run the same matrix there. The key file defaults to ../.env (ZG_ENV_FILE
// overrides), the agent dir to a scratch copy seeded by --agent-from.
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const REPO_URL = "https://github.com/expressjs/express";
const EMBEDDING = "local/potion-code-16m-v2";

// --- prompts -----------------------------------------------------------------
// Written the way a user asks, never naming a tool. `concept` expects semantic
// search to win, `exact` is fine with rg, `control` needs no search at all.
export const PROMPTS = [
  {
    id: "c1",
    category: "concept",
    text: "Where does express decide which route handler runs for an incoming request?",
  },
  {
    id: "c2",
    category: "concept",
    text: "How do query string parameters get parsed before a handler sees them?",
  },
  {
    id: "c3",
    category: "concept",
    text: "Which part adds the ETag and freshness checks to a response?",
  },
  {
    id: "c4",
    category: "concept",
    text: "Where does the code decide whether a request body is JSON and read it?",
  },
  {
    id: "c5",
    category: "concept",
    text: "How does a sub-application get mounted under a path?",
  },
  {
    id: "c6",
    category: "concept",
    text: "Where is the response content type derived from a res.format call?",
  },
  { id: "e1", category: "exact", text: "Find every use of res.locals." },
  {
    id: "e2",
    category: "exact",
    text: "Find every occurrence of app.request.",
  },
  { id: "e3", category: "exact", text: "Where is mergeParams referenced?" },
  {
    id: "k1",
    category: "control",
    text: "From your own knowledge, no files: what does HTTP status 418 mean?",
  },
  {
    id: "k2",
    category: "control",
    text: "Explain the difference between 401 and 403 in two sentences, no tools.",
  },
  {
    id: "k3",
    category: "control",
    text: "Without looking at any file, write a one-line bash command that prints today's date.",
  },
  // Held out: written before any guidance change, never inspected while
  // editing the guidance text.
  {
    id: "h1",
    category: "holdout",
    text: "Where does express decide that a request's params should be percent-decoded?",
  },
  {
    id: "h2",
    category: "holdout",
    text: "How does the framework decide when to fall through to the next middleware?",
  },
  {
    id: "h3",
    category: "holdout",
    text: "Which file sets the default charset for text responses?",
  },
  {
    id: "h4",
    category: "holdout",
    text: "Where is the X-Powered-By header configured?",
  },
];

// --- args --------------------------------------------------------------------

// The pinned model: the cheapest model in OpenRouter's /api/v1/models catalog
// that advertises `tools`, reached through a provider that is actually wired up
// here (zai keeps the key in the pi agent dir). gpt-oss-20b is the alternative
// once OPENROUTER_API_KEY exists: --model openrouter/openai/gpt-oss-20b.
const PINNED_MODEL = "zai/glm-5.3-flash";

const parseArgs = (argv) => {
  const o = {
    agentFrom: null,
    concurrency: 4,
    envFile: process.env.ZG_ENV_FILE ?? null,
    guidance: "both",
    only: null,
    out: null,
    repeat: 3,
    threshold: null,
    models: [],
    timeout: 240_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--model") {
      o.models.push(next());
    } else if (a === "--runs" || a === "--repeat") {
      o.repeat = Number(next());
    } else if (a === "--concurrency") {
      o.concurrency = Number(next());
    } else if (a === "--guidance") {
      o.guidance = next();
    } else if (a === "--only" || a === "--subset") {
      o.only = next();
    } else if (a === "--threshold") {
      o.threshold = Number(next());
    } else if (a === "--json" || a === "--out") {
      o.out = next();
    } else if (a === "--env-file") {
      o.envFile = next();
    } else if (a === "--agent-from") {
      o.agentFrom = next();
    } else if (a === "--timeout") {
      o.timeout = Number(next());
    } else if (a === "--help" || a === "-h") {
      console.log(
        "node tools/routing-eval.mjs [--model provider/id] [--runs 3] [--guidance 1|0|both] [--subset concept,holdout] [--threshold 80] [--json file.json] [--env-file path] [--agent-from dir] [--concurrency 4] [--timeout ms]"
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (o.models.length === 0) {
    o.models.push(PINNED_MODEL);
  }
  return o;
};

const opts = parseArgs(process.argv.slice(2));

// --- key + bench root --------------------------------------------------------

const bench =
  process.env.ZG_BENCH ?? path.join(homedir(), ".cache", "zg-bench");
const envFile = opts.envFile ?? path.join(root, ".env");
if (!process.env.OPENROUTER_API_KEY && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
// A run without a key for its provider fails every session the same way, so
// stop before burning the matrix.
if (
  opts.models.some((m) => m.startsWith("openrouter/")) &&
  !process.env.OPENROUTER_API_KEY
) {
  console.error(
    `OPENROUTER_API_KEY is unset (checked ${envFile} and the environment); openrouter models cannot run.`
  );
  process.exit(2);
}

// --- workspace ---------------------------------------------------------------

// `zg` bins ship in the engine package; the extension resolves the same binary.
const zgBin = () => {
  const pkg = path.join(root, "node_modules/@zvec/zvec-grep");
  const { bin, version } = JSON.parse(
    readFileSync(path.join(pkg, "package.json"), "utf-8")
  );
  return { bin: path.join(pkg, bin.zg), version };
};

const ensureWorkspace = () => {
  const work = path.join(bench, "express");
  if (!existsSync(work)) {
    console.log(`cloning ${REPO_URL} into ${work}`);
    const clone = spawnSync("git", ["clone", "--depth", "1", REPO_URL, work], {
      encoding: "utf-8",
    });
    if (clone.status !== 0) {
      throw new Error(`clone failed: ${clone.stderr}`);
    }
  }
  // Pre-index with the bundled engine and one fixed embedding model, so no
  // run pays for (or is biased by) a first index build inside the session.
  if (!existsSync(path.join(work, ".zvec-grep"))) {
    const { bin, version } = zgBin();
    console.log(`indexing ${work} with zg ${version} (${EMBEDDING})`);
    const index = spawnSync(bin, ["--index", ".", "--embedding", EMBEDDING], {
      cwd: work,
      encoding: "utf-8",
      timeout: 900_000,
    });
    if (index.status !== 0) {
      throw new Error(`index failed: ${index.stderr || index.stdout}`);
    }
  }
  return work;
};

// --- agent dir ---------------------------------------------------------------

// Kept under the bench root rather than the system temp dir: a full run leaves
// one jsonl per session, and the transcripts are what a diagnosis reads.
const scratchRoot = path.join(bench, "routing-scratch");
mkdirSync(scratchRoot, { recursive: true });
const scratch = mkdtempSync(path.join(scratchRoot, "run-"));
const agentDir = path.join(scratch, "agent");
mkdirSync(agentDir, { recursive: true });
if (opts.agentFrom) {
  // Credentials for an already-logged-in provider. The source dir is only read.
  for (const name of ["auth.json", "models-store.json", "models.json"]) {
    const from = path.join(opts.agentFrom, name);
    if (existsSync(from)) {
      cpSync(from, path.join(agentDir, name));
    }
  }
}

// --- session -----------------------------------------------------------------

// A tool call is search-like when it queries the workspace: zg, the built-in
// grep/find, a bash line that runs a search binary, or a read of a file.
const SEARCH_CMD = /\b(rg|grep|ag|ack|fd|find|git\s+grep)\b/u;

export const classify = (name, args) => {
  if (name === "zg") {
    return "zg";
  }
  if (name === "grep" || name === "find") {
    return "search";
  }
  if (name === "read") {
    return "read";
  }
  if (name === "bash") {
    const command = typeof args?.command === "string" ? args.command : "";
    return SEARCH_CMD.test(command) ? "search" : "other";
  }
  return "other";
};

const readSession = (file) => {
  const lines = readFileSync(file, "utf-8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  // First *search-like* tool in the session: bash `ls` and friends are not a
  // routing choice, so they are skipped and counted separately.
  const firstTool = { args: null, kind: null, name: null };
  let cost = 0;
  let tokens = 0;
  let model = null;
  let otherTools = 0;
  let toolCalls = 0;
  for (const entry of lines) {
    const message = entry?.message;
    if (message?.role !== "assistant") {
      continue;
    }
    model ??= message.model ?? null;
    cost += message.usage?.cost?.total ?? 0;
    tokens += message.usage?.totalTokens ?? 0;
    for (const block of message.content ?? []) {
      if (block.type !== "toolCall") {
        continue;
      }
      toolCalls += 1;
      const kind = classify(block.name, block.arguments);
      if (kind === "other") {
        otherTools += 1;
      } else if (!firstTool.name) {
        firstTool.kind = kind;
        firstTool.name = block.name;
        firstTool.args = block.arguments ?? {};
      }
    }
  }
  return { ...firstTool, cost, model, otherTools, tokens, toolCalls };
};

// One pi -p session. Async so --concurrency actually overlaps provider latency.
const runSession = (args, env) =>
  new Promise((resolve) => {
    const child = spawn("pi", args, {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout);
    const done = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      done({ code: -1, stderr: String(error), stdout })
    );
    child.on("close", (code, signal) =>
      done({ code: code ?? (signal ? -1 : 0), signal, stderr, stdout })
    );
  });

const runOne = async ({ model, prompt, condition, repeat }) => {
  const provider = model.slice(0, model.indexOf("/"));
  const modelId = model.slice(model.indexOf("/") + 1);
  const sessionDir = path.join(
    scratch,
    "runs",
    `${condition}-${model.replace(/[^\w.-]+/gu, "_")}-${prompt.id}-${repeat}`
  );
  mkdirSync(sessionDir, { recursive: true });
  const args = [
    "--approve",
    "-e",
    path.join(root, "src/index.ts"),
    "--skill",
    path.join(root, "skills"),
    "--no-context-files",
    "--no-mcp",
    "--no-extensions",
    "--provider",
    provider,
    "--model",
    modelId,
    "--session-dir",
    sessionDir,
    "--name",
    `routing-${condition}-${prompt.id}`,
    "-p",
    `${prompt.text} Do not edit files.`,
  ];
  const env = {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
  };
  if (condition === "baseline") {
    // The documented opt-out: pi then shows the tool and its snippet, but none
    // of the guidance bullets.
    env.PI_ZG_GUIDANCE = "0";
  } else {
    delete env.PI_ZG_GUIDANCE;
  }
  const started = Date.now();
  const run = await runSession(args, env);
  const files = readdirSync(sessionDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".jsonl"));
  const sessionFile = files.length ? path.join(sessionDir, files[0]) : null;
  const session = sessionFile
    ? readSession(sessionFile)
    : { kind: null, name: null, cost: 0, tokens: 0 };
  return {
    ...session,
    condition,
    durationMs: Date.now() - started,
    exit: run.code,
    model,
    prompt: prompt.id,
    repeat,
    sessionFile,
    stderr: run.code === 0 ? undefined : (run.stderr ?? "").slice(-400),
  };
};

// --- matrix ------------------------------------------------------------------

const pick = () => {
  if (!opts.only) {
    return PROMPTS;
  }
  // A comma list, as CI passes it (`concept,holdout`): each entry is a category
  // name or a prompt id, so `--subset holdout` and `--subset c1,e2` both work.
  const wanted = opts.only.split(",").map((s) => s.trim());
  return PROMPTS.filter(
    (p) => wanted.includes(p.id) || wanted.includes(p.category)
  );
};

const conditions =
  opts.guidance === "both"
    ? ["guidance", "baseline"]
    : [opts.guidance === "0" ? "baseline" : "guidance"];

const workspace = ensureWorkspace();
const jobs = [];
for (const model of opts.models) {
  for (const condition of conditions) {
    for (const prompt of pick()) {
      for (let r = 1; r <= opts.repeat; r += 1) {
        jobs.push({ condition, model, prompt, repeat: r });
      }
    }
  }
}
if (jobs.length === 0) {
  // A subset that matches nothing would otherwise spend a key on zero sessions
  // and report INCONCLUSIVE, which reads like a provider flake.
  console.error(
    `--subset "${opts.only ?? ""}" matched no prompts; known categories: ${[...new Set(PROMPTS.map((p) => p.category))].join(", ")}, plus any prompt id`
  );
  process.exit(2);
}
console.log(
  `${jobs.length} runs: ${opts.models.length} model(s) x ${conditions.join("+")} x ${opts.repeat} repeat(s), concurrency ${opts.concurrency}`
);

const results = [];
const out =
  opts.out ??
  path.join(
    bench,
    `routing-eval-${new Date().toISOString().slice(0, 19)}.json`
  );
// Written after every run: a killed or rate-limited matrix still leaves the
// sessions it paid for.
const persist = () => {
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        conditions,
        date: new Date().toISOString(),
        models: opts.models,
        prompts: pick(),
        repeat: opts.repeat,
        results,
        totalCost: results.reduce((sum, r) => sum + r.cost, 0),
        workspace,
      },
      null,
      2
    )
  );
};
let cursor = 0;
let finished = 0;
const worker = async () => {
  while (cursor < jobs.length) {
    const job = jobs[cursor];
    cursor += 1;
    const r = await runOne(job);
    results.push(r);
    finished += 1;
    persist();
    console.log(
      `${String(finished).padStart(3)}/${jobs.length} ${job.condition.padEnd(8)} ${job.model.padEnd(24)} ${job.prompt.id} #${job.repeat} -> ${r.kind ?? "no-tool"}${r.name ? ` (${r.name})` : ""}${r.exit === 0 ? "" : ` [exit ${r.exit}]`}`
    );
  }
};
await Promise.all(
  Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker)
);

// --- report ------------------------------------------------------------------

const categories = [...new Set(pick().map((p) => p.category))];
const categoryOf = (id) => pick().find((p) => p.id === id)?.category;
const rate = (rows) => {
  if (rows.length === 0) {
    return "n/a";
  }
  const zgFirst = rows.filter((r) => r.kind === "zg").length;
  return `${((zgFirst / rows.length) * 100).toFixed(0)}% (${zgFirst}/${rows.length})`;
};
const rowsFor = (model, condition, category) =>
  results.filter(
    (r) =>
      r.model === model &&
      r.condition === condition &&
      (category === undefined || categoryOf(r.prompt) === category)
  );

for (const model of opts.models) {
  console.log(`\n${model} — first search-like tool, by category`);
  const table = [];
  for (const category of [...categories, "all"]) {
    const row = { category };
    for (const condition of conditions) {
      row[condition] = rate(
        rowsFor(model, condition, category === "all" ? undefined : category)
      );
    }
    table.push(row);
  }
  console.table(table);

  // What the non-zg first moves actually were, per condition.
  const kinds = ["zg", "search", "read", "other", "no-tool"];
  const detail = [];
  for (const condition of conditions) {
    const row = { condition };
    for (const kind of kinds) {
      row[kind] = rowsFor(model, condition).filter(
        (r) => (r.kind ?? "no-tool") === kind
      ).length;
    }
    detail.push(row);
  }
  console.table(detail);
}

const totalCost = results.reduce((sum, r) => sum + r.cost, 0);
const failures = results.filter((r) => r.exit !== 0);
console.log(
  `\nruns ${results.length}, failures ${failures.length}, total cost $${totalCost.toFixed(4)}, tokens ${results.reduce((sum, r) => sum + r.tokens, 0)}`
);
if (failures.length > 0) {
  console.log(
    `${failures.length} run(s) exited non-zero, first: ${failures[0].stderr ?? "no stderr"}`
  );
}

persist();
console.log(`results written to ${out}`);
console.log(`session transcripts kept in ${scratch}`);

// --- verdict (CI gate) -------------------------------------------------------

// Two exit behaviours, mirroring the pi integration job: a threshold breach or
// a session that failed inside this extension is a real failure (1). A provider
// that rate-limits, times out or 5xxs produces no routing observation at all, so
// those rows leave the denominator, and an empty denominator is INCONCLUSIVE
// (0, reason in the step summary) rather than a red build. Without --threshold
// this block only reports and the script exits as it always did.
const OUR_CODE = /(?:pi-zgrep|src[/\\]index\.ts|skills[/\\])/u;

const unusableReason = (row) => {
  if (row.exit === 0) {
    return null;
  }
  return OUR_CODE.test(row.stderr ?? "") ? "extension" : "provider";
};

const validRows = results.filter((row) => unusableReason(row) === null);
const extensionFailures = results.filter(
  (row) => unusableReason(row) === "extension"
);
const providerFlakes = results.filter(
  (row) => unusableReason(row) === "provider"
);

// The gate: `concept` whenever the subset contains it, on the shipped
// `guidance` condition when both conditions ran.
const gateCondition = conditions.includes("guidance")
  ? "guidance"
  : conditions[0];
const gateCategory = categories.includes("concept") ? "concept" : null;
const gateRows = validRows.filter(
  (row) =>
    row.condition === gateCondition &&
    (gateCategory === null || categoryOf(row.prompt) === gateCategory)
);
const zgFirst = gateRows.filter((row) => row.kind === "zg").length;
const pct = gateRows.length === 0 ? null : (zgFirst / gateRows.length) * 100;
const threshold = opts.threshold;

const decide = () => {
  if (threshold === null) {
    return {
      code: 0,
      kind: "REPORT",
      reason: "no --threshold, reporting only",
    };
  }
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    return {
      code: 2,
      kind: "ERROR",
      reason: `--threshold must be 0..100 (got ${threshold})`,
    };
  }
  if (extensionFailures.length > 0) {
    const first = extensionFailures[0];
    return {
      code: 1,
      kind: "FAIL",
      reason: `${extensionFailures.length} session(s) failed inside the extension: ${(first.stderr ?? "no stderr").slice(-300)}`,
    };
  }
  if (pct === null) {
    return {
      code: 0,
      kind: "INCONCLUSIVE",
      reason: `no usable session (${providerFlakes.length} provider flake(s))`,
    };
  }
  const label = `${gateCategory ?? "all"} zg-first ${pct.toFixed(0)}% (${zgFirst}/${gateRows.length})`;
  if (pct < threshold) {
    return {
      code: 1,
      kind: "FAIL",
      reason: `${label} is below the ${threshold}% threshold`,
    };
  }
  return {
    code: 0,
    kind: "PASS",
    reason: `${label} meets the ${threshold}% threshold`,
  };
};
const verdict = decide();

// Markdown for $GITHUB_STEP_SUMMARY. Same numbers as `console.table` above,
// minus the rows that produced no observation.
const mdRate = (rows) => {
  if (rows.length === 0) {
    return "n/a";
  }
  const hits = rows.filter((row) => row.kind === "zg").length;
  return `${((hits / rows.length) * 100).toFixed(0)}% (${hits}/${rows.length})`;
};
const mdRows = (condition, category) =>
  validRows.filter(
    (row) =>
      row.condition === condition &&
      (category === null || categoryOf(row.prompt) === category)
  );

const lines = [
  `### Routing eval — ${verdict.kind}`,
  "",
  verdict.reason,
  "",
  `\`${opts.models.join(", ")}\` · subset \`${opts.only ?? "all"}\` · ${opts.repeat} run(s) · ${conditions.join("+")}${providerFlakes.length > 0 ? ` · ${providerFlakes.length} provider flake(s) excluded` : ""}`,
  "",
  `| category | ${conditions.join(" | ")} |`,
  `| --- | ${conditions.map(() => "---").join(" | ")} |`,
];
for (const category of [...categories, "all"]) {
  const cells = conditions.map((condition) =>
    mdRate(mdRows(condition, category === "all" ? null : category))
  );
  lines.push(`| ${category} | ${cells.join(" | ")} |`);
}
lines.push(
  "",
  `Threshold: ${threshold === null ? "not enforced" : `${threshold}% on ${gateCategory ?? "all"} (${gateCondition})`}`
);

console.log(`\nverdict: ${verdict.kind} — ${verdict.reason}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`, {
    flag: "a",
  });
}
// Keep the verdict in the JSON so an uploaded artifact answers "why red?".
const artifact = JSON.parse(readFileSync(out, "utf-8"));
writeFileSync(out, JSON.stringify({ ...artifact, verdict }, null, 2));
process.exitCode = verdict.code;
