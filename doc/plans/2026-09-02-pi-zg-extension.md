# pi-zg Implementation Plan

> **REQUIRED SUB-SKILL:** Use the subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Ship `pi-zg@0.1.0` — a pi extension exposing one `zg` tool (semantic/BM25/hybrid/rg search via the global `zg` CLI), with auto-install, auto-index, agent guidance, CI, and npm release plumbing.

**Architecture:** Thin TypeScript pi package (jiti, no build). `src/index.ts` registers the tool, two commands, and guidance; `src/args.ts` builds CLI args; `src/zg.ts` resolves/installs the binary and ensures the index; `src/parse.ts` parses zg's text output. All zg interaction spawns the CLI with array args (`shell: false`).

**Tech Stack:** TypeScript (jiti-loaded), `typebox` for tool schemas, `node:test`, ultracite (Oxlint + Oxfmt), GitHub Actions.

**Spec:** `/home/pacman/Work/pi-zg/doc/specs/2026-09-02-pi-zg-extension.md`

**Verification:** `npm run lint && npm run format:check && npm run typecheck && npm run test` (repo root). E2E: `ZG_TEST_E2E=1 npm run test`.

---

## Files

**Create:**
- `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE` (MIT)
- ultracite config (`npx ultracite init` output — `.oxlintrc.json` and/or ultracite config file)
- `src/index.ts`, `src/zg.ts`, `src/args.ts`, `src/parse.ts`
- `test/args.test.ts`, `test/parse.test.ts`, `test/ensure.test.ts`, `test/guidance.test.ts`, `test/e2e.test.ts`
- `test/fixtures/` (captured `zg --help`, `zg query --help`, `zg status --help`, real query output, real status output)
- `README.md`, `CONTRIBUTING.md`
- `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Modify:** none (greenfield). **Delete:** none.

## Conventions

- Commit messages: imperative subject, humanized per `~/.pi/agent/AGENTS.md`.
- Branch: work continues on `brainstorm/pi-zg-v0.1` (spec already committed there).
- Scoped test command: `node --test test/<file>.test.ts` (after Task 1 adds the `test` script, plain `node --test <file>` works; TS loads via jiti only inside pi — tests import compiled-free TS? **No:** `node --test` does not load TS. Tests run through the `test` script: `node --test` with Node 24 type-stripping enabled (`node --test "test/*.test.ts"` works on Node ≥22.6 with `--experimental-strip-types` default-on in 23+; Node 24 strips types natively). Import extension in tests: `import ... from "../src/args.ts"` (explicit `.ts` extension required by type stripping).

## Wave 1 — Bootstrap

Parallel-safe: Tasks 1–3 own disjoint files. Tasks 1 and 3 both invoke npm (local install vs global install); npm's cache is concurrency-safe, so this is not a blocking contention.

### Task 1: Repo scaffold, package manifest, ultracite toolchain

**TDD scenario:** Trivial change — use judgment (mechanical scaffold).

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Repo, tooling, publish" L93, § "Repo, tooling, publish" L94, § "Repo, tooling, publish" L96

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, ultracite-generated lint/format config

- [ ] **Step 1: Create the GitHub repo and push the existing branch**

  ```bash
  cd /home/pacman/Work/pi-zg
  gh repo create carvalab/pi-zg --public --source . --push
  ```

  Expected: repo exists at github.com/carvalab/pi-zg, branch `brainstorm/pi-zg-v0.1` pushed.

- [ ] **Step 2: Write `package.json`**

  ```json
  {
    "name": "pi-zg",
    "version": "0.1.0",
    "description": "zg (zvec-grep) semantic search for the pi coding agent: one tool, semantic + BM25 + hybrid + ripgrep, auto-indexed.",
    "keywords": ["pi", "pi-package", "pi-extension", "zg", "zvec-grep", "semantic-search", "ai-agent"],
    "license": "MIT",
    "type": "module",
    "repository": { "type": "git", "url": "git+https://github.com/carvalab/pi-zg.git" },
    "bugs": { "url": "https://github.com/carvalab/pi-zg/issues" },
    "homepage": "https://github.com/carvalab/pi-zg#readme",
    "engines": { "node": ">=22" },
    "files": ["src", "README.md", "LICENSE"],
    "publishConfig": { "access": "public" },
    "pi": { "extensions": ["./src/index.ts"] },
    "scripts": {
      "lint": "oxlint src test",
      "format": "oxfmt src test",
      "format:check": "oxfmt --check src test",
      "typecheck": "tsc --noEmit",
      "test": "node --test \"test/*.test.ts\"",
      "test:e2e": "ZG_TEST_E2E=1 node --test \"test/*.test.ts\""
    },
    "peerDependencies": {
      "@earendil-works/pi-coding-agent": "*",
      "typebox": "*"
    },
    "devDependencies": {
      "@types/node": "^24.0.0",
      "typescript": "^5.5.0"
    }
  }
  ```

- [ ] **Step 3: Write `tsconfig.json` (typecheck only)**

  ```json
  {
    "compilerOptions": {
      "target": "ES2023",
      "module": "NodeNext",
      "moduleResolution": "NodeNext",
      "allowImportingTsExtensions": true,
      "noEmit": true,
      "strict": true,
      "skipLibCheck": true,
      "types": ["node"]
    },
    "include": ["src/**/*.ts", "test/**/*.ts"]
  }
  ```

  Note: `typebox` and `@earendil-works/pi-coding-agent` are peerDeps; for local typecheck/install run `npm install --save-peer @earendil-works/pi-coding-agent@* typebox@*` is NOT valid — instead run `npm install` then `npm install --no-save @earendil-works/pi-coding-agent typebox` so typecheck resolves them without publishing them as deps.

- [ ] **Step 4: Write `.gitignore`** — `node_modules/`, `*.tgz`, `.DS_Store`.

- [ ] **Step 5: Write `LICENSE`** — MIT, holder `carvalab`, year 2026.

- [ ] **Step 6: Initialize ultracite with the oxc stack**

  Run `npx ultracite init`. If the installed version offers an Oxlint + Oxfmt provider, select it and keep the generated config. If it cannot offer oxlint/oxfmt (or init cannot run non-interactively), fall back: `npm install -D oxlint oxfmt` and write a minimal `.oxlintrc.json` (`{ "extends": ["recommended"] }`... verify against `npx oxlint --help`; keep defaults if the schema differs). The scripts in Step 2 already target `oxlint`/`oxfmt` directly, so both paths converge.

- [ ] **Step 7: Install and verify the toolchain**

  Run: `npm install && npm run lint && npm run typecheck`
  Expected: exit 0 (no source files yet — lint/typecheck pass trivially; adjust script globs if a tool errors on empty input).

- [ ] **Step 8: Preserve the spec's exact manifest literals** — the spec (L96) pins these strings; verify each appears verbatim in `package.json` (JSON spelling differs — this bullet is the mapping): `name: pi-zg`, `version: 0.1.0`, `keywords: ["pi-package","pi","zg","zvec-grep","semantic-search","ai-agent"]`, `pi.extensions: ["./src/index.ts"]`, `engines.node >=22`, peerDeps `@earendil-works/pi-coding-agent` + `typebox` with range `"*"`.

- [ ] **Step 9: Format & commit**

  ```bash
  npx oxfmt src test 2>/dev/null; git add -A
  git commit -m "Scaffold package, toolchain (ultracite/oxc), CI scripts"
  ```

### Task 2: CI and release workflows

**TDD scenario:** Trivial change — use judgment (mechanical workflow files).

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Repo, tooling, publish" L95, § "Repo, tooling, publish" L97

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

  ```yaml
  name: CI
  on:
    push: { branches: [main] }
    pull_request:
  jobs:
    ci:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 24 }
        - run: npm install
        - run: npm run lint
        - run: npm run format:check
        - run: npm run typecheck
        - run: npm run test
  ```

  Note: `branches: [main]` — after ship merges the work branch, main carries CI. Also run on the work branch pushes: use `branches: [main, 'brainstorm/**']` if desired; keep simple (PR-triggered covers the work branch).

- [ ] **Step 2: Write `.github/workflows/release.yml`**

  ```yaml
  name: Release
  on:
    push: { tags: ["v*"] }
  jobs:
    publish:
      runs-on: ubuntu-latest
      # First publish (0.1.0) requires NPM_TOKEN; after the trusted publisher
      # is attached on npmjs.com, add id-token: write and remove the token.
      environment: npm
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with: { node-version: 24, registry-url: "https://registry.npmjs.org" }
        - run: npm install
        - run: npm run lint && npm run typecheck && npm run test
        - run: npm publish
          env:
            NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
  ```

  Spec literals this task must carry (from L95/L97): commit messages and release PR descriptions run through the `humanizer` skill per `~/.pi/agent/AGENTS.md` (repeat this line as a comment at the top of both workflow files); the `pi-zg@0.0.0` reservation may already exist — the publish step is idempotent per release; `NPM_TOKEN` is the first-publish secret; after the trusted publisher is attached, switch to `id-token: write` (already named in the file comment).

- [ ] **Step 3: Commit**

  ```bash
  git add .github && git commit -m "Add CI and release workflows"
  ```

### Task 3: Install zg and capture compat fixtures

**TDD scenario:** Trivial change — use judgment (fixture capture; the artifacts ARE the deliverable).

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Components" L63

**Files:**
- Create: `test/fixtures/zg-version.txt`, `test/fixtures/help-query.txt`, `test/fixtures/help-status.txt`, `test/fixtures/query-output.txt`, `test/fixtures/status-notready.txt`, `test/fixtures/status-ready.txt`, `test/fixtures/sample-project/hello.ts`

- [ ] **Step 1: Install the engine globally (real auto-install path)**

  Run: `npm install -g @zvec/zvec-grep && zg --version | tee test/fixtures/zg-version.txt`
  Expected: version ≥ 0.2 printed. If this fails, STOP with BLOCKED — every later task depends on real fixtures.

- [ ] **Step 2: Capture help output (arg-builder tripwire input)**

  ```bash
  zg query --help > test/fixtures/help-query.txt 2>&1
  zg status --help > test/fixtures/help-status.txt 2>&1
  ```

- [ ] **Step 3: Create a tiny sample project and build its index**

  Write `test/fixtures/sample-project/hello.ts`:

  ```ts
  // Theme preference hydration happens at startup in loadTheme().
  export function loadTheme(): string {
    return "dark";
  }
  ```

  Then, from a scratch copy OUTSIDE the repo (index stores per-root state; do not index the pi-zg repo itself):

  ```bash
  SCRATCH=$(mktemp -d) && cp -r test/fixtures/sample-project "$SCRATCH/" && cd "$SCRATCH/sample-project"
  git init -q . && git add -A && git -c user.email=t@t -c user.name=t commit -qm init
  zg status --check-ready; echo "exit=$?" | tee "$OLDPWD/test/fixtures/status-notready-exit.txt"
  zg status > "$OLDPWD/test/fixtures/status-notready.txt" 2>&1
  zg index 2>&1 | tail -5 > "$OLDPTH/test/fixtures/index-output.txt" || true
  zg status > "$OLDPWD/test/fixtures/status-ready.txt" 2>&1
  ```

  (Fix the intentional `$OLDPTH` typo when typing: `$OLDPWD`. Keep `status-notready-exit.txt` — the exit code line is part of the fixture set.)

- [ ] **Step 4: Capture real query output in all four routes**

  From the same scratch dir:

  ```bash
  zg query "where is the theme restored" --limit 10 --preview short > "$OLDPWD/test/fixtures/query-output.txt" 2>&1
  zg query --fts "loadTheme" --limit 5 > /dev/null && echo fts-ok
  zg query --vector "restore user theme at startup" --limit 5 > /dev/null && echo vector-ok
  zg query --rg "loadTheme" --limit 5 > /dev/null && echo rg-ok
  ```

  Expected: `query-output.txt` non-empty and contains `hello.ts`; the three route checks print ok. If the default (non-`--human`) output is empty or error-shaped, retry with `--human` and note it in `test/fixtures/NOTES.md` (the parser task then targets whichever format is real — record what you observed). These fixtures feed `src/parse.ts` (Task 5) and the arg-builder tripwire (Task 4).

- [ ] **Step 5: Commit**

  ```bash
  cd /home/pacman/Work/pi-zg && git add test/fixtures && git commit -m "Capture zg compat fixtures (help, status, query)"
  ```

## Wave 2 — Core units

Depends on Wave 1 (fixtures exist; package.json toolchain works). Tasks 4–6 own disjoint files.

### Task 4: Arg builder (`src/args.ts`)

**TDD scenario:** New feature — full TDD cycle.

**Files:**
- Create: `src/args.ts`, `test/args.test.ts`

- [ ] **Step 1: Write the failing test** — reads the captured help fixture and asserts the builder only emits flags that exist in it. The mapping implemented here (from spec § "Components" L61, owned by Task 7's tool): hybrid → positional query; fts → `--fts`; vector → `--vector`; rg → `--rg`; `--limit`; `--preview`; glob → `-g`; type → `-t`; transport `--mode auto` on every call; `--refresh wait` on demand.

  ```ts
  // test/args.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { buildQueryArgs, buildIndexArgs, buildStatusArgs } from "../src/args.ts";

  const help = readFileSync(new URL("./fixtures/help-query.txt", import.meta.url), "utf8");

  test("hybrid route uses positional query", () => {
    assert.deepEqual(
      buildQueryArgs({ query: "where is the theme restored", mode: "hybrid", limit: 10, preview: "short" }),
      ["query", "where is the theme restored", "--limit", "10", "--preview", "short", "--mode", "auto"],
    );
  });
  test("fts/vector/rg routes use their flags, rg skips indexing upstream", () => {
    assert.deepEqual(
      buildQueryArgs({ query: "loadTheme", mode: "fts", limit: 5, preview: "none" }),
      ["query", "--fts", "loadTheme", "--limit", "5", "--preview", "none", "--mode", "auto"],
    );
    assert.ok(buildQueryArgs({ query: "q", mode: "vector", limit: 1, preview: "short" }).includes("--vector"));
    assert.ok(buildQueryArgs({ query: "q", mode: "rg", limit: 1, preview: "short" }).includes("--rg"));
  });
  test("refresh wait and filters append", () => {
    const args = buildQueryArgs({ query: "q", mode: "hybrid", limit: 5, preview: "short", refresh: "wait", glob: "*.ts", type: "ts" });
    assert.ok(args.includes("--refresh") && args.includes("wait"));
    assert.deepEqual(args.slice(args.indexOf("-g"), args.indexOf("-g") + 2), ["-g", "*.ts"]);
    assert.deepEqual(args.slice(args.indexOf("-t"), args.indexOf("-t") + 2), ["-t", "ts"]);
  });
  test("every emitted flag exists in the captured zg query help (input tripwire)", () => {
    const known = new Set(["query", "--fts", "--vector", "--rg", "--hybrid", "--limit", "--preview", "--mode", "--refresh", "-g", "--iglob", "-t", "-T", "--fuse"]);
    for (const a of buildQueryArgs({ query: "q", mode: "vector", limit: 3, preview: "short", refresh: "wait", glob: "*.ts", type: "ts" })) {
      if (a.startsWith("-")) assert.ok(known.has(a) && help.includes(a), `flag ${a} not in captured help`);
    }
  });
  test("index/status builders", () => {
    assert.deepEqual(buildIndexArgs(["--rebuild"]), ["index", "--rebuild"]);
    assert.deepEqual(buildStatusArgs(), ["status", "--check-ready"]);
  });
  ```

  Adjust exact expected arrays if Step 3 reveals a different real flag set — the captured help is the contract; keep the tripwire test.

- [ ] **Step 2: Run, confirm failure** — `npm run test 2>&1 | grep args` → FAIL (module not found).

- [ ] **Step 3: Implement `src/args.ts`**

  ```ts
  export type QueryMode = "hybrid" | "fts" | "vector" | "rg";
  export interface QueryInput {
    query: string; mode: QueryMode; limit: number; preview: "short" | "none";
    refresh?: "auto" | "wait"; glob?: string; type?: string;
  }
  export function buildQueryArgs(i: QueryInput): string[] {
    const args = ["query"];
    if (i.mode === "fts") args.push("--fts", i.query);
    else if (i.mode === "vector") args.push("--vector", i.query);
    else if (i.mode === "rg") args.push("--rg", i.query);
    else args.push(i.query);
    args.push("--limit", String(i.limit), "--preview", i.preview, "--mode", "auto");
    if (i.refresh === "wait") args.push("--refresh", "wait");
    if (i.glob) args.push("-g", i.glob);
    if (i.type) args.push("-t", i.type);
    return args;
  }
  export const buildIndexArgs = (extra: string[] = []): string[] => ["index", ...extra];
  export const buildStatusArgs = (): string[] => ["status", "--check-ready"];
  ```

  Cross-check each flag against `test/fixtures/help-query.txt`; if a flag differs upstream (`--preview` values, route flag names), fix the builder AND the test together — the fixture wins.

- [ ] **Step 4: Run, confirm pass** — `node --test test/args.test.ts` → all PASS.

- [ ] **Step 5: Format & lint** — `npm run format && npm run lint` → clean.

- [ ] **Step 6: Commit** — `git add src/args.ts test/args.test.ts && git commit -m "Add zg arg builder with help-fixture tripwire"`

### Task 5: Output parser (`src/parse.ts`)

**TDD scenario:** New feature — full TDD cycle (fixture first — already captured in Task 3).

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Components" L63, § "Error handling and edge cases" L82

**Files:**
- Create: `src/parse.ts`, `test/parse.test.ts`

- [ ] **Step 1: Write the failing test** — contract: parse the captured default output; on miss return raw.

  ```ts
  // test/parse.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { readFileSync } from "node:fs";
  import { parseQueryOutput, parseStatusOutput, renderResults } from "../src/parse.ts";

  const q = () => readFileSync(new URL("./fixtures/query-output.txt", import.meta.url), "utf8");
  const s = () => readFileSync(new URL("./fixtures/status-ready.txt", import.meta.url), "utf8");

  test("parses captured hybrid output into results", () => {
    const r = parseQueryOutput(q());
    assert.equal("results" in r, true, `parse missed; got ${JSON.stringify(r).slice(0, 200)}`);
    if ("results" in r) {
      assert.ok(r.results.length > 0);
      assert.ok(r.results[0].file.includes("hello.ts"), `first hit should be the sample file: ${JSON.stringify(r.results[0])}`);
      assert.ok(typeof r.results[0].lineStart === "number");
    }
  });
  test("parse miss returns raw, never fabricates", () => {
    const r = parseQueryOutput("total garbage\nnot a zg listing\n");
    assert.deepEqual(r, { raw: "total garbage\nnot a zg listing\n" });
  });
  test("status parser extracts ready/freshness, miss returns raw", () => {
    // input shape comes from the captured `zg status` fixture
    const ready = parseStatusOutput(s());
    assert.equal(ready.raw === undefined, true);
    const miss = parseStatusOutput("??");
    assert.equal(miss.raw, "??");
  });
  test("rendering is ripgrep-style lines under a freshness note", () => {
    const out = renderResults({ results: [{ file: "src/a.ts", lineStart: 3, lineEnd: 7, score: 0.9, snippet: "export function loadTheme" }], freshness: "fresh" });
    assert.match(out, /fresh/);
    assert.match(out, /src\/a\.ts:3-7\s+0\.9\s+export function loadTheme/);
  });
  ```

  If Step 4 shows the real listing carries different fields (no score, path only), adjust the interface AND assertions together — the fixture defines truth; `lineStart`/`lineEnd` may be a single line number.

- [ ] **Step 2: Run, confirm failure** — `node --test test/parse.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/parse.ts`** — read `test/fixtures/query-output.txt` and write the smallest regex/line grammar that parses exactly that shape (group headers, `path:line` entries, scores — whatever the fixture shows). Required exported shape:

  ```ts
  export interface ZgResult { file: string; lineStart: number; lineEnd?: number; score?: number; snippet?: string; }
  export type QueryParse = { results: ZgResult[]; freshness?: "fresh" | "possibly_stale" } | { raw: string };
  export function parseQueryOutput(text: string): QueryParse { /* grammar from fixture; ANY mismatch -> { raw: text } */ }
  export type StatusParse = { ready: boolean; freshness?: string } | { raw: string };
  export function parseStatusOutput(text: string): StatusParse { /* from status fixtures; miss -> { raw: text } */ }
  export function renderResults(p: Exclude<QueryParse, { raw: string }>): string {
    // line 1: freshness note, e.g. "zg results (fresh):" — possibly_stale must survive verbatim
    // then: `${file}:${lineStart}${lineEnd ? "-" + lineEnd : ""}  ${score ?? ""}  ${snippet?.split("\n")[0] ?? ""}`
  }
  ```

  Parse-miss callers render the raw text prefixed with a hint to run `/zg-status` and file an issue (spec L82). If the captured default output turns out to be the `--human` shape, retarget the grammar to it and record that in `test/fixtures/NOTES.md`.

- [ ] **Step 4: Run, confirm pass** — `node --test test/parse.test.ts` → PASS (all four).

- [ ] **Step 5: Format & lint** — `npm run format && npm run lint` → clean.

- [ ] **Step 6: Commit** — `git add src/parse.ts test/parse.test.ts && git commit -m "Add zg output parser with fixture-driven fallback"`

### Task 6: Binary resolver + ensure chain (`src/zg.ts`)

**TDD scenario:** New feature — full TDD cycle (mocked spawn).

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Components" L57, § "Components" L59, § "Testing approach" L89, § "Error handling and edge cases" L80, § "Error handling and edge cases" L83, § "Error handling and edge cases" L85

**Files:**
- Create: `src/zg.ts`, `test/ensure.test.ts`

- [ ] **Step 1: Write the failing test** — inject a fake runner; cover the named states and locks.

  ```ts
  // test/ensure.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { createZg, type Runner } from "../src/zg.ts";

  function fakeRunner(over: Partial<Runner> = {}): Runner & { calls: string[][] } {
    const calls: string[][] = [];
    return Object.assign({
      calls,
      probe: async () => "/usr/bin/zg",
      run: async (args: string[]) => { calls.push(args); return { code: 0, stdout: "", stderr: "" }; },
      stream: async (args: string[], _o?: { onUpdate?: (s: string) => void }) => { calls.push(args); return { code: 0 }; },
      install: async () => { calls.push(["<install>"]); },
      startServer: async () => { calls.push(["server", "on"]); },
    }, over) as Runner & { calls: string[][] };
  }

  test("ready index: no index command runs", async () => {
    const r = fakeRunner();
    const zg = createZg(r, { root: "/x" });
    await zg.ensureIndex();
    assert.deepEqual(r.calls, []);
  });
  test("cold index builds once under parallel calls, then starts daemon once", async () => {
    const r = fakeRunner({ probeStatus: async () => ({ code: 1, stdout: "not ready", stderr: "" }) });
    const zg = createZg(r, { root: "/x" });
    await Promise.all([zg.ensureIndex(), zg.ensureIndex(), zg.ensureIndex()]);
    const builds = r.calls.filter(c => c[0] === "index");
    const servers = r.calls.filter(c => c[0] === "server");
    assert.equal(builds.length, 1, "parallel cold-start calls must share one build");
    assert.equal(servers.length, 1, "daemon started once after first build");
  });
  test("failed build memo: second ensure surfaces status text instead of rebuilding", async () => {
    let n = 0;
    const r = fakeRunner({
      probeStatus: async () => ({ code: 1, stdout: "index error: model download failed", stderr: "" }),
      run: async (args: string[]) => { if (args[0] === "index") { n++; return { code: 1, stdout: "", stderr: "boom" }; } return { code: 0, stdout: "", stderr: "" }; },
    });
    const zg = createZg(r, { root: "/x" });
    const e1 = await zg.ensureIndex();
    const e2 = await zg.ensureIndex();
    assert.equal(n, 1, "must not rebuild after a failed attempt this session");
    assert.match(String(e2?.error ?? ""), /model download failed|boom/);
  });
  test("install lock: parallel resolves install once", async () => {
    let installs = 0;
    const r = fakeRunner({ probe: async () => null, install: async () => { installs++; } });
    const zg = createZg(r, { root: "/x" });
    await Promise.all([zg.ensureBinary(), zg.ensureBinary()]);
    assert.equal(installs, 1);
  });
  test("PI_ZG_BIN set but probe fails -> error naming the var, no install", async () => {
    const r = fakeRunner({ probe: async () => null, install: async () => { throw new Error("should not install"); } });
    const zg = createZg(r, { root: "/x", env: { PI_ZG_BIN: "/nope/zg" } });
    await assert.rejects(zg.ensureBinary(), /PI_ZG_BIN/);
  });
  ```

- [ ] **Step 2: Run, confirm failure** — `node --test test/ensure.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `src/zg.ts`**

  ```ts
  import { spawn } from "node:child_process";

  export interface RunResult { code: number; stdout: string; stderr: string; }
  export interface Runner {
    probe(): Promise<string | null>;                       // resolved binary path or null
    run(args: string[]): Promise<RunResult>;               // buffered run (status/help)
    stream(args: string[], o?: { onUpdate?: (s: string) => void; signal?: AbortSignal; cwd?: string }): Promise<{ code: number }>;
    install(): Promise<void>;                              // npm -g (bun fallback), streams progress
    startServer(): Promise<void>;                          // detached `zg server on`, best-effort
    probeStatus?(): Promise<RunResult>;                    // overridable for tests; default = run(statusArgs)
  }
  export interface ZgOpts { root: string; env?: Record<string, string | undefined>; signal?: AbortSignal; }

  const nonEmpty = (v?: string) => typeof v === "string" && v.length > 0;

  export function createZg(runner: Runner, opts: ZgOpts) {
    let installP: Promise<unknown> | undefined;
    let buildP: Promise<unknown> | undefined;
    let serverStarted = false;
    const failedRoots = new Set<string>();

    async function ensureBinary(): Promise<string> {
      const bin = await runner.probe();
      if (bin) return bin;
      if (nonEmpty(opts.env?.PI_ZG_BIN)) throw new Error(`PI_ZG_BIN=${opts.env!.PI_ZG_BIN} is set but zg is not executable there. Fix the path or unset PI_ZG_BIN.`);
      if (nonEmpty(opts.env?.PI_ZG_AUTO_INSTALL)) throw new Error("zg is not installed. Install it with: npm install -g @zvec/zvec-grep");
      installP ??= runner.install().finally(() => { installP = undefined; });
      await installP;
      const again = await runner.probe();
      if (!again) throw new Error("zg install finished but the binary is still not on PATH. Try: npm install -g @zvec/zvec-grep");
      return again;
    }

    async function ensureIndex(): Promise<{ error?: string }> {
      const st = runner.probeStatus ? await runner.probeStatus() : await runner.run(["status", "--check-ready"]);
      if (st.code === 0) return {};
      if (failedRoots.has(opts.root)) return { error: `zg index is not ready (previous build attempt failed). zg status said: ${st.stdout || st.stderr}` };
      failedRoots.add(opts.root);
      buildP ??= (async () => {
        const res = await runner.stream(["index"], { onUpdate: opts.signal ? undefined : undefined, signal: opts.signal, cwd: opts.root });
        if (res.code !== 0) throw new Error(`zg index failed: see zg status output`);
      })().finally(() => { buildP = undefined; });
      try { await buildP; } catch (e) { return { error: (e as Error).message }; }
      failedRoots.delete(opts.root);
      if (!serverStarted && !nonEmpty(opts.env?.PI_ZG_SERVER)) {
        serverStarted = true;
        runner.startServer().catch(() => {});  // ponytail: fire-and-forget daemon start; add health surfacing in /zg-status if users report issues
      }
      return {};
    }

    return { ensureBinary, ensureIndex };
  }
  ```

  (Pass `onUpdate` through from the tool layer in `opts` when wiring Task 7 — extend `ZgOpts` with `onUpdate?: (s: string) => void` and hand it to `runner.stream`. The daemon-start lock is the `serverStarted` flag; the build lock is `buildP`; the install lock is `installP`. The version-warning probe (<0.2 → warn once) lives in `ensureBinary` via a `run(["--version"])` check — warn only, never fail.)

  Spec literals this task must carry (verify each appears in the shipped code or its comments):

  - From L57 (resolver): the probe runs `zg --version` with a 10s timeout; opt-out convention is `PI_ZG_AUTO_INSTALL=1` (any non-empty value); bun `add -g` is the fallback when npm is absent; install progress surfaces via `ctx.ui.setStatus("pi-zg", …)`.
  - From L59 (index ensure): the probe command is `zg status --check-ready` (build and query run with `cwd: ctx.cwd`); after the first successful build, fire `zg server on` once — background refresh, watcher updates, hourly reconciliation and model reuse are the daemon's job per upstream `docs/06-server.md` § Refresh behavior; keep the upstream ponytail marker: `# ponytail: fire-and-forget daemon start; add health surfacing in /zg-status if users report issues` (TS comments use `//`, keep the text verbatim after it).
  - From L80: rg is the indexless escape hatch — `mode=rg` skips `ensureIndex` entirely.
  - From L83: aborts propagate through `signal` and kill the running child.
  - From L85: offline first build fails on the embedding-model download; surface zg's error verbatim.
  - From L89 (test shape): tests use `node:test` with a mocked runner covering the named states `unresolved → probing → installing → indexing → ready`; the real-engine integration is gated on `ZG_TEST_E2E=1`; the arg-builder tripwire input is the captured `--help` output.

- [ ] **Step 4: Run, confirm pass** — `node --test test/ensure.test.ts` → PASS.

- [ ] **Step 5: Format & lint** — `npm run format && npm run lint` → clean.

- [ ] **Step 6: Commit** — `git add src/zg.ts test/ensure.test.ts && git commit -m "Add zg resolver and index ensure chain with locks"`

## Wave 3 — Extension wire-up

Solo: Task 7 consumes the APIs introduced by Tasks 4, 5, and 6 (named-blocker justification: `buildQueryArgs`, `parseQueryOutput`/`renderResults`/`parseStatusOutput`, `createZg`).

Depends on Wave 2: all three modules.

### Task 7: Extension factory (`src/index.ts`) + guidance

**TDD scenario:** New feature — TDD for guidance; registration verified by typecheck + e2e in Task 9.

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Components" L61, § "Components" L65, § "Components" L67, § "Error handling and edge cases" L79, § "Error handling and edge cases" L81, § "Error handling and edge cases" L84

**Files:**
- Create: `src/index.ts`, `test/guidance.test.ts`

- [ ] **Step 1: Write the failing guidance test**

  ```ts
  // test/guidance.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { guidanceText, shouldInjectGuidance } from "../src/index.ts";

  test("guidance names the four routes and the fallback rule", () => {
    const t = guidanceText();
    assert.match(t, /hybrid/); assert.match(t, /fts/); assert.match(t, /vector/); assert.match(t, /rg/);
    assert.match(t, /zero results/); assert.match(t, /possibly_stale/);
  });
  test("opt-out: any non-empty value disables, unset/empty enables", () => {
    assert.equal(shouldInjectGuidance({}), true);
    assert.equal(shouldInjectGuidance({ PI_ZG_GUIDANCE: "" }), true);
    assert.equal(shouldInjectGuidance({ PI_ZG_GUIDANCE: "1" }), false);
    assert.equal(shouldInjectGuidance({ PI_ZG_GUIDANCE: "0" }), false);
  });
  ```

- [ ] **Step 2: Run, confirm failure** — `node --test test/guidance.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/index.ts`**

  ```ts
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  import { Type } from "typebox";
  import { buildQueryArgs, buildIndexArgs, buildStatusArgs, type QueryMode } from "./args.ts";
  import { parseQueryOutput, parseStatusOutput, renderResults } from "./parse.ts";
  import { createZg, type Runner } from "./zg.ts";

  export const guidanceText = () =>
    [
      "Code/content search: prefer the `zg` tool before grep/find.",
      "- mode=hybrid (default) for intent or natural-language questions; mode=fts for known symbols/identifiers; mode=vector for paraphrases; mode=rg for exact literal/regex.",
      "- Fall back to grep/find only when (1) zg returns zero results, (2) the zg tool errors, or (3) results report possibly_stale for content just edited this session.",
    ].join("\n");
  export const shouldInjectGuidance = (env: Record<string, string | undefined>) => !nonEmpty(env.PI_ZG_GUIDANCE);
  const nonEmpty = (v?: string) => typeof v === "string" && v.length > 0;

  export default function (pi: ExtensionAPI) {
    const makeRunner = (): Runner => { /* spawn-based Runner: probe = `where zg` via `zg --version` (10s timeout, ENOENT->null), run/stream = spawn array-args shell:false collecting stdout/stderr + line onUpdate, install = `npm install -g @zvec/zvec-grep` with bun `add -g` fallback (stream to setStatus), startServer = detached spawn(["server","on"]) */ };

    pi.registerTool({
      name: "zg",
      label: "zg",
      description: "Local-first semantic + BM25 + hybrid + ripgrep search over this workspace. PREFER zg over grep/find for code and content search; use mode=rg for exact matches zg misses.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query (natural language, symbol, or regex for mode=rg)" }),
        mode: Type.Optional(Type.Union([Type.Literal("hybrid"), Type.Literal("fts"), Type.Literal("vector"), Type.Literal("rg")], { description: "Search route; default hybrid", default: "hybrid" })),
        limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 50)", default: 10, minimum: 1, maximum: 50 })),
        glob: Type.Optional(Type.String({ description: "Glob filter, e.g. *.ts" })),
        type: Type.Optional(Type.String({ description: "File type filter, e.g. ts" })),
        refresh: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("wait")], { description: "wait = update the index and wait (use for just-edited content)", default: "auto" })),
        preview: Type.Optional(Type.Union([Type.Literal("short"), Type.Literal("none")], { description: "Snippet preview; default short", default: "short" })),
      }),
      async execute(_id, params, signal, onUpdate, ctx) {
        const env = (p: string) => process.env[p];
        const runner = makeRunner();
        const zg = createZg(runner, { root: ctx.cwd, env: process.env as Record<string, string | undefined>, signal, onUpdate });
        const bin = await zg.ensureBinary(); // throws with the exact manual command on failure
        if (params.mode !== "rg") {
          const idx = await zg.ensureIndex();
          if (idx.error) return { content: [{ type: "text", text: `zg error: ${idx.error}` }], details: { isError: true } };
        }
        const args = buildQueryArgs({
          query: params.query, mode: (params.mode ?? "hybrid") as QueryMode,
          limit: Math.min(params.limit ?? 10, 50), preview: params.preview ?? "short",
          refresh: params.refresh, glob: params.glob, type: params.type,
        });
        if (params.refresh === "wait") args.push("--refresh", "wait");
        const res = await runner.run(args); // cwd: ctx.cwd, signal
        const parsed = parseQueryOutput(res.stdout);
        const text = "raw" in parsed
          ? `zg output (unparsed — upstream format may have changed; file an issue at carvalab/pi-zg):\n${parsed.raw}`
          : renderResults(parsed);
        return { content: [{ type: "text", text }], details: parsed };
      },
    });

    pi.registerCommand("zg-index", {
      description: "Build/refresh the zg index for this workspace (pass-through args, e.g. /zg-index --rebuild)",
      handler: async (args, ctx) => {
        ctx.ui.setStatus("pi-zg", "indexing…");
        ctx.ui.notify("zg index started", "info");
        const runner = makeRunner();
        const res = await runner.stream(buildIndexArgs(args ? args.split(/\s+/) : []), {
          cwd: ctx.cwd, onUpdate: (line) => ctx.ui.setStatus("pi-zg", line.slice(0, 80)),
        });
        ctx.ui.notify(res.code === 0 ? "zg index finished" : "zg index failed", res.code === 0 ? "info" : "error");
        return res.code === 0 ? "index updated" : `zg index failed (exit ${res.code}) — run /zg-status for details`;
      },
    });

    pi.registerCommand("zg-status", {
      description: "Show zg binary, index readiness, and daemon state",
      handler: async (_args, ctx) => {
        const runner = makeRunner();
        const lines: string[] = [];
        const st = await runner.run(buildStatusArgs()); // cwd: ctx.cwd
        const parsed = parseStatusOutput(st.stdout);
        lines.push(`index: ${st.code === 0 ? "ready" : "not ready"}${"freshness" in parsed && parsed.freshness ? ` (${parsed.freshness})` : ""}`);
        if ("raw" in parsed) lines.push(parsed.raw);
        else lines.push(`daemon: see 'zg server status' — pi-zg leaves it to zg`);
        return lines.join("\n");
      },
    });

    pi.on("before_agent_start", (event) => {
      if (!shouldInjectGuidance(process.env as Record<string, string | undefined>)) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${guidanceText()}` };
    });
  }
  ```

  Implementation notes for `makeRunner` (fill in this file, no new module): `probe()` = spawn `["--version"]` with 10s timeout; ENOENT/timeout → null (timeout → null only when probing PATH; the PI_ZG_BIN error path in `createZg` handles the set-but-broken case); `run()` buffers stdout/stderr with `cwd` + `signal`; `stream()` forwards each stdout line to `onUpdate`/`ctx.ui.setStatus`; `install()` streams `npm install -g @zvec/zvec-grep` progress (bun fallback on npm ENOENT); version <0.2 → one-shot warning appended to first tool result text.

  Spec literals this task must carry (verify each appears in the shipped code or its comments):

  - From L61 (tool + mapping): the schema params `query`, `mode`, `limit`, `glob`, `type`, `refresh`, `preview` with values `hybrid`/`fts`/`vector`/`rg`, `auto`/`wait`, `short`/`none`; the route flags `--fts`, `--vector`, `--rg`, `--limit`, `--preview`, `-g`, `-t`; transport `--mode auto` on every call; `--refresh wait` appended when the agent needs post-edit freshness (in code: `refresh: "wait"` maps to the flag pair); the arg-builder tripwire inputs are the captured `zg query --help` and `zg status --help` outputs; rendered content lines follow `path:line-start-line-end  score  first-snippet-line`.
  - From L65 (commands): register `/zg-index [args…]` (pass-through); progress via `ctx.ui.setStatus("pi-zg", …)` per line, `ctx.ui.notify` milestones, handler return as summary; `/zg-status` one-line fields with raw `zg status` text appended on parse miss.
  - From L67 (guidance): hook is `before_agent_start`, appended text mutates `event.systemPrompt`; `PI_ZG_GUIDANCE` non-empty = off; fallback rule names zero results, tool error, `possibly_stale` on just-edited content.
  - From L79: install/no-package-manager failure returns the exact manual command.
  - From L81: `--mode auto` + daemon reconciliation for routine drift; `refresh: "wait"` as the explicit escape hatch; `possibly_stale` surfaced.
  - From L84: non-workspace/empty-repo errors from zg surface verbatim.

- [ ] **Step 4: Run, confirm pass** — `node --test test/guidance.test.ts` → PASS; `npm run typecheck` → clean (proves registration API shapes).

- [ ] **Step 5: Format & lint** — `npm run format && npm run lint` → clean.

- [ ] **Step 6: Commit** — `git add src/index.ts test/guidance.test.ts && git commit -m "Add zg tool, commands, and agent guidance"`

## Wave 4 — Docs + end-to-end

Parallel-safe: Task 8 (docs only) and Task 9 (code+test) own disjoint files.

### Task 8: README and CONTRIBUTING

**TDD scenario:** Doc-only task.

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Documentation impact" L101, § "Error handling and edge cases" L80, § "Out of scope (v0.1.0)" L107

**Files:**
- Create: `README.md`, `CONTRIBUTING.md`

- [ ] **Step 1: Write `README.md`** — sections, in order: title + one-line pitch; badges (npm version, CI, license MIT, node ≥22) linking to the right URLs; "What is zg?" 2-liner crediting `zvec-ai/zvec-grep` (Apache-2.0 upstream, link); **Install** (`pi install npm:pi-zg`, try-before-install `pi -e npm:pi-zg`, note the auto-install of the `zg` engine and the env opt-outs); **Agent-facing tools** (`zg` with the parameter table from the spec § "Components" L61); **Commands** (`/zg-index`, `/zg-status`); **How it behaves** (auto-index on first query, daemon handoff, guidance injection + `PI_ZG_GUIDANCE` opt-out — one short paragraph each); **Configuration** (env var table: `PI_ZG_BIN`, `PI_ZG_AUTO_INSTALL`, `PI_ZG_GUIDANCE`, `PI_ZG_SERVER` — all "non-empty value = active" except `PI_ZG_BIN` = path); **Troubleshooting** (install failure → manual command; offline first index; `mode=rg` works without an index; parse-miss → run `/zg-status` and file an issue; **Windows: not supported in 0.1.0** — the resolver spawns `zg` directly with `shell: false` and cannot launch npm's `.cmd` shims); **Out of scope in 0.1.0** (no override of native grep/find, no MCP-client mode, no custom TUI, no `@`-mention autocomplete, no bundled skills, no remote embeddings); **Development** (clone, `npm install`, `npm run test`, `ZG_TEST_E2E=1 npm run test:e2e`, fixtures note); License (MIT).

- [ ] **Step 2: Write `CONTRIBUTING.md`** — short: branch off main, conventional commits not required but humanized imperative messages, `npm run verify`-equivalent (the four commands) must pass, fixture regen instructions (`ZG_TEST_E2E` and Task 3's capture commands), PRs welcome.

- [ ] **Step 3: Commit** — `git add README.md CONTRIBUTING.md && git commit -m "Add README and contributing guide"`

### Task 9: End-to-end with the real engine

**TDD scenario:** New feature — integration test gated on `ZG_TEST_E2E=1`.

**Spec:** doc/specs/2026-09-02-pi-zg-extension.md § "Data flow" L69-L75

**Files:**
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the e2e test** — skipped unless `ZG_TEST_E2E=1`; indexes the scratch sample project (copy `test/fixtures/sample-project` to a fresh temp dir, as in Task 3) and queries through the REAL chain.

  ```ts
  // test/e2e.test.ts
  import { test } from "node:test";
  import assert from "node:assert/strict";
  import { cpSync, mkdtempSync, readFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { spawnSync } from "node:child_process";

  const ok = process.env.ZG_TEST_E2E === "1";
  const scratch = () => {
    const dir = join(mkdtempSync(join(tmpdir(), "pi-zg-e2e-")), "sample-project");
    cpSync(new URL("./fixtures/sample-project", import.meta.url).pathname, dir, { recursive: true });
    return dir;
  };

  (ok ? test : test.skip)("e2e: probe, index, hybrid query finds hello.ts", () => {
    const dir = scratch();
    const probe = spawnSync("zg", ["status", "--check-ready"], { cwd: dir, encoding: "utf8" });
    assert.notEqual(probe.status, 0, "fresh scratch dir must not be ready");
    spawnSync("zg", ["index"], { cwd: dir, stdio: "inherit" });
    const r = spawnSync("zg", ["query", "where is the theme restored", "--limit", "5", "--preview", "short", "--mode", "auto"], { cwd: dir, encoding: "utf8" });
    assert.match(r.stdout, /hello\.ts/);
  });
  ```

  This is the spec's § "Data flow" chain end to end: the agent's `zg { query: "where is theme restored", mode: "hybrid", limit: 10 }` becomes the spawn below (tests use spawnSync with `cwd` playing the role of `ctx.cwd`); `status --check-ready` probes, `zg index` builds, the `zg query "where is theme restored" --limit 10 --preview short --mode auto` shape (here limit 5) runs, and parsing yields `file:line` results the agent reads natively.

  Then add a sibling test that exercises `src/index.ts`'s exported pieces the same way if trivially importable; the tool execute path itself is exercised by the manual smoke in Step 3.

- [ ] **Step 2: Run the e2e** — `npm run test:e2e` → PASS (real zg; model already cached from Task 3).

- [ ] **Step 3: Manual smoke in a real pi session** — `cd /tmp && pi -e /home/pacman/Work/pi-zg` then ask "where is the theme restored in the sample project?" with the tool available; confirm the `zg` tool fires and results render. (Evidence for the verify phase.)

- [ ] **Step 4: Full verification suite** — `npm run lint && npm run format:check && npm run typecheck && npm run test` → exit 0.

- [ ] **Step 5: Commit** — `git add test/e2e.test.ts && git commit -m "Add gated e2e test against the real zg engine"`

## Spec coverage

| anchor | requirement (short) | owner |
|---|---|---|
| § "Components" L57 | resolver order PI_ZG_BIN → PATH → install; env-var error semantics; install lock | Task 6 |
| § "Components" L59 | check-ready probe; build lock; session build-attempt memo; daemon start once + opt-out; model download surfaced | Task 6 |
| § "Components" L61 | tool schema (query/mode/limit/glob/type/refresh/preview); route mapping; transport-vs-route axes; details JSON + rendered text | Task 7 |
| § "Components" L63 | parser fixture contract; raw fallback, never fabricate; status fixture contract | Task 3, Task 5 |
| § "Components" L65 | /zg-index progress UX (setStatus + notify + summary); /zg-status render shape | Task 7 |
| § "Components" L67 | guidance text, fallback definition, PI_ZG_GUIDANCE non-empty=off | Task 7 |
| § "Data flow" L69-L75 | end-to-end chain resolve → index → query → parse → read | Task 9 |
| § "Error handling and edge cases" L79 | install failure → exact manual command | Task 7 |
| § "Error handling and edge cases" L80 | huge-repo progress/abort/resume; mode=rg indexless escape hatch | Task 6, Task 8 |
| § "Error handling and edge cases" L81 | stale drift via daemon; refresh wait escape hatch; possibly_stale surfaced | Task 7 |
| § "Error handling and edge cases" L82 | parse miss → raw passthrough + /zg-status hint | Task 5 |
| § "Error handling and edge cases" L83 | abort kills child via signal | Task 6 |
| § "Error handling and edge cases" L84 | non-workspace errors surfaced verbatim | Task 7 |
| § "Error handling and edge cases" L85 | offline first index error surfaced verbatim | Task 6 |
| § "Testing approach" L89 | node:test units; named states; fixture tripwires both ends; gated e2e; CI Node 24 | Task 6 |
| § "Repo, tooling, publish" L93 | gh repo create carvalab/pi-zg --public at implementation start | Task 1 |
| § "Repo, tooling, publish" L94 | ultracite → oxlint/oxfmt from minute zero; lint/format/typecheck/test scripts | Task 1 |
| § "Repo, tooling, publish" L95 | humanizer for commit messages and release PR descriptions | Task 2 |
| § "Repo, tooling, publish" L96 | package.json manifest shape (name, version, keywords, pi.extensions, peerDeps, engines) | Task 1 |
| § "Repo, tooling, publish" L97 | npm publish flow: NPM_TOKEN first, OIDC after trusted publisher | Task 2 |
| § "Documentation impact" L101 | README.md + CONTRIBUTING.md introduced | Task 8 |
| § "Out of scope (v0.1.0)" L107 | Windows unsupported documented (shell:false, .cmd); scope limits named in README | Task 8 |
| - | mechanical: CI + release workflows | Task 2 |
| - | mechanical: arg builder helper | Task 4 |
| - | mechanical: capture fixtures from real engine | Task 3 |
| - | mechanical: gated e2e against real zg | Task 9 |
| § "Out of scope (v0.1.0)" L107 | no grep/find override, no MCP client, no custom TUI, no autocomplete, no bundled skills, no remote embeddings in 0.1.0 | waived: out of scope per spec |
