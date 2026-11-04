// Does pi actually put our guidance in front of the model?
//
// The unit tests in guidance.test.ts prove the strings exist; nothing there
// proves pi *renders* them. pi drops a tool from the `<tools>` section when the
// tool has no promptSnippet, and drops promptGuidelines unless the tool is
// active and non-hidden — so a refactor in either repo can silently remove the
// nudge without failing any other test.
//
// This builds a real AgentSession through the public SDK with the extension
// loaded from this package's own `pi.extensions` entry, in a scratch cwd and
// scratch agentDir. No model, no credentials, no network, no real ~/.pi: an
// empty agentDir makes createAgentSession report "no models available" and the
// system prompt is still built. Expected strings are imported from src, so
// editing the wording keeps this green while dropping it from the prompt does
// not.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { guidanceLines, PROMPT_SNIPPET } from "../src/index.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

// The way pi itself loads us: whatever `pi.extensions` ships in package.json.
const packageManifest = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf-8")
) as { pi: { extensions: string[] } };
const extensionEntry = path.join(
  packageRoot,
  packageManifest.pi.extensions[0] ?? ""
);

interface Rendered {
  prompt: string;
  tools: string[];
}

const renderSessionPrompt = async (): Promise<Rendered> => {
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-zg-prompt-cwd-"));
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-zg-prompt-agent-"));
  try {
    const loader = new DefaultResourceLoader({
      additionalExtensionPaths: [extensionEntry],
      agentDir,
      cwd,
      // Discovery outside the package would make the prompt depend on the
      // machine; the scratch dirs alone decide what is loaded.
      noContextFiles: true,
      noPromptTemplates: true,
      noSkills: true,
      noThemes: true,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      agentDir,
      cwd,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    try {
      return {
        prompt: session.systemPrompt,
        tools: session.getActiveToolNames(),
      };
    } finally {
      session.dispose();
    }
  } finally {
    // Windows keeps a directory alive briefly after the last handle closes.
    for (const dir of [cwd, agentDir]) {
      rmSync(dir, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 100,
      });
    }
  }
};

// Only the named section: a snippet rendered elsewhere would not reach the
// model the way pi intends.
const section = (prompt: string, name: string): string => {
  const match = prompt.match(
    new RegExp(`<${name}>\\n(?<body>[\\s\\S]*?)\\n</${name}>`, "u")
  );
  assert.ok(
    match?.groups?.body !== undefined,
    `no <${name}> section in prompt`
  );
  return match.groups.body;
};

const occurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// Rule bodies without their bullet marker, in render order.
const bullets = (body: string): string[] =>
  body
    .split("\n")
    .filter((rule) => rule.startsWith("- "))
    .map((rule) => rule.slice(2));

// Whitespace-insensitive form: pi de-dupes on trim() only, so a copy that
// differs by an interior space survives into the prompt as a second nudge. The
// model reads the same sentence twice; the wording barely matters.
const normalize = (rule: string): string =>
  rule.trim().replaceAll(/\s+/gu, " ");

const distinct = (rules: string[]): string[] => [
  ...new Set(rules.map(normalize)),
];

// One session serves the three render assertions; each guidance line is checked
// against the same prompt.
const rendered = await renderSessionPrompt();
const toolsSection = section(rendered.prompt, "tools");
const rulesSection = section(rendered.prompt, "rules");

test("pi loads the extension and lists the zg tool as active", () => {
  assert.ok(
    rendered.tools.includes("zg"),
    `zg not in active tools: ${JSON.stringify(rendered.tools)}`
  );
});

test("the promptSnippet is rendered inside the tools section", (t) => {
  t.diagnostic(`<tools>\n${toolsSection}\n</tools>`);
  assert.ok(
    toolsSection.includes(`- zg: ${PROMPT_SNIPPET}`),
    `tools section lacks "- zg: ${PROMPT_SNIPPET}"`
  );
  // Without a snippet pi omits the tool entirely, so one hit is the contract.
  assert.equal(occurrences(rendered.prompt, PROMPT_SNIPPET), 1);
});

test("every guidance line is rendered exactly once in the rules section", (t) => {
  t.diagnostic(`<rules>\n${rulesSection}\n</rules>`);
  for (const line of guidanceLines()) {
    assert.equal(
      occurrences(rulesSection, line),
      1,
      `guidance line missing from (or duplicated in) <rules>: ${line}`
    );
    // pi de-dupes rules by trimmed text, so an exact repeat is collapsed and
    // harmless; anything the model actually reads twice is not.
    assert.equal(occurrences(rendered.prompt, line), 1);
  }
  // Counting the expected lines alone would miss a near-duplicate that escaped
  // pi's trim-only de-dupe ("the same sentence, one space apart"). Trimming and
  // collapsing whitespace on both sides makes the comparison the one that
  // matters: each nudge reaches the model exactly once.
  // The rendered side is not de-duped: two bullets that collapse to the same
  // sentence are exactly the defect this catches, and neither is "expected".
  assert.deepEqual(
    bullets(rulesSection)
      .filter((rule) => rule.includes("zg"))
      .map(normalize),
    distinct(guidanceLines())
  );
});

test("PI_ZG_GUIDANCE opt-out drops the guidelines but keeps the tool", async () => {
  const previous = process.env.PI_ZG_GUIDANCE;
  process.env.PI_ZG_GUIDANCE = "0";
  let optedOut: Rendered;
  try {
    optedOut = await renderSessionPrompt();
  } finally {
    if (previous === undefined) {
      delete process.env.PI_ZG_GUIDANCE;
    } else {
      process.env.PI_ZG_GUIDANCE = previous;
    }
  }
  assert.ok(
    optedOut.tools.includes("zg"),
    `zg must stay active when guidance is off: ${JSON.stringify(optedOut.tools)}`
  );
  const optedOutRules = section(optedOut.prompt, "rules");
  for (const line of guidanceLines()) {
    assert.equal(occurrences(optedOut.prompt, line), 0);
  }
  // The snippet is tool documentation, not guidance: it must survive.
  assert.ok(
    section(optedOut.prompt, "tools").includes(`- zg: ${PROMPT_SNIPPET}`)
  );
  // Control: the rules section is still populated, so the absences above are
  // opt-out and not an empty section. Structural on purpose — asserting pi's own
  // default wording would fail the suite on a harmless pi reword.
  assert.ok(bullets(optedOutRules).length > 0, "rules section is empty");
});
