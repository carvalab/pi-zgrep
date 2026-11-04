# Routing eval: does a real session pick `zg` on its own?

Run: 2026-11-04. Script: `tools/routing-eval.mjs`. Model: `zai/glm-5.3-flash`
(the zai route of OpenRouter catalog entry `z-ai/glm-5.3-flash`, $0.027/$0.10
per M tokens, tool calling on). Cost of the 96 sessions below: **$0.24**,
5.25 M tokens.

## Question

No prompt in this set names a tool. The question is whether a fresh `pi -p`
session, with this extension and its skill loaded, reaches for `zg` from the
tool snippet (`promptSnippet`) and the guidance bullets (`promptGuidelines`)
alone — or whether it falls back to `grep`/`find`/`rg`/`read`.

## Design

- Sixteen prompts in four categories:
  - **concept** (6): natural-language questions about express internals, where
    semantic search should win.
  - **exact** (3): lookups of a known identifier, where `rg` is a fine answer.
  - **control** (3): questions that need no workspace access at all; a search
    tool here is spurious tool use.
  - **holdout** (4): written before any guidance edit and never inspected while
    tweaking guidance text.
- Two conditions: **guidance** (default) and **baseline**
  (`PI_ZG_GUIDANCE=0`, which drops the bullets and keeps the snippet).
- N=3 per prompt per condition, each in its own session in its own scratch
  copy of the agent dir (`PI_CODING_AGENT_DIR=<scratch>/agent`; the real
  `~/.pi` is only read for credentials via `--agent-from`).
- Workspace: shallow clone of `expressjs/express` under `~/.cache/zg-bench`,
  pre-indexed by the bundled zg 0.3.0 with `local/potion-code-16m-v2`, so a
  first index build inside a session cannot bias the choice.
- Session invocation: `pi --approve -e src/index.ts --skill skills
  --no-context-files --no-mcp --no-extensions --provider <p> --model <id>
  --session-dir <dir> -p "<prompt> Do not edit files."`
- Measured variable: the **first search-like tool call** in the session
  `.jsonl` — `zg`, `grep`/`find`, a `bash` line running `rg`/`grep`/`find`, or
  `read`. `bash ls` and other non-search calls are skipped.
- 96 sessions = 16 prompts x 2 conditions x 3 runs.

## Results

First search-like tool, `zg`-first share:

| category | guidance | baseline |
| --- | --- | --- |
| concept (6 prompts) | 100% (18/18) | 100% (18/18) |
| exact (3) | 100% (9/9) | 100% (9/9) |
| control (3) | 0% (0/9) — no tool at all | 0% (0/9) — no tool at all |
| holdout (4) | 100% (12/12) | 100% (12/12) |
| all | 81% (39/48) | 81% (39/48) |

First-move distribution:

| condition | zg | grep/find | read | other | no tool |
| --- | --- | --- | --- | --- | --- |
| guidance | 39 | 0 | 0 | 0 | 9 |
| baseline | 39 | 0 | 0 | 0 | 9 |

The nine "no tool" sessions are exactly the three control prompts x 3 runs in
both conditions: no spurious retrieval, and no `zg` call when the question has
nothing to do with the workspace.

Sessions never opened a hot path first: median 5 tool calls, median wall clock
49 s for a concept question and 7 s for a control.

## Diagnosis

Concept `zg`-first with guidance is **100% (18/18)**, above the 80% bar, so the
guidance text was left unchanged — no `src/index.ts` or `skills/` edit was made
after the held-out prompts were written, and the held-out result (12/12) is
therefore a clean generalisation check rather than a post-hoc one.

What the transcripts show:

- The first move is `zg` in both conditions. The snippet ("Search workspace
  code and content: semantic, BM25, hybrid, or ripgrep, auto-indexed") plus the
  skill's route table is already enough; the three guidance bullets do not
  move the model on this corpus.
- Mode selection comes from the skill, present in both conditions: exact
  identifiers mostly go out as `mode: "rg"` (6/9 guidance, 6/9 baseline), and
  concept questions mostly take the default hybrid.
- `grep`/`find`/`rg`-in-bash and bare `read` were never the first move in 96
  sessions.

Caveats: one model, one repository, three runs per prompt; the baseline still
shows the snippet, so this measures the bullets, not the tool listing. A model
that ignores tool snippets would need the `openrouter/free` class of routing
experiment this deliberately avoids.

## Re-running

```sh
node tools/routing-eval.mjs                       # 16 prompts x 3 runs x 2 conditions
node tools/routing-eval.mjs --runs 1 --guidance 0 # baseline only
node tools/routing-eval.mjs --only holdout        # held-out set only
node tools/routing-eval.mjs --json out.json       # machine-readable results for CI
```

`--model provider/id` pins a different model (default `zai/glm-5.3-flash`,
needs `--agent-from ~/.pi/agent` for its credentials). With an OpenRouter key
in the environment or in `--env-file`, `--model openrouter/openai/gpt-oss-20b`
runs the same matrix on OpenRouter's cheapest tool-capable catalog entry.
Result JSON is rewritten after every session, so an interrupted matrix still
keeps what it paid for.
