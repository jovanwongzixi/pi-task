/**
 * Unit tests for task extension pure helpers.
 *
 * Run: npx tsx .pi/extensions/task/helpers.test.ts
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseResultXml,
  extractTag,
  formatMs,
  parseIdTimestamp,
  shellQuote,
  buildTmuxSplitWindowArgs,
  chooseTmuxSplitDirection,
  formatBackgroundReceipt,
  formatTaskBatchDetails,
  formatTaskBatchReceipt,
  TASK_BACKGROUND_DEFAULT,
  TASK_BATCH_MAX_TASKS,
  TASK_BATCH_MIN_TASKS,
  TASK_BATCH_TOOL_DESCRIPTION,
  TASK_PROMPT_INSTRUCTIONS,
  TASK_TOOL_DESCRIPTION,
  countToolUses,
  readRecentToolCalls,
  summarizeArgs,
  validateTaskBatchSize,
  validateTaskBatchTasks,
  findPiDir,
  loadAgentsFromDir,
  discoverAgents,
  formatAgentList,
  type AgentConfig,
} from "../src/helpers.js";

// ─── extractTag ──────────────────────────────────────────────────────────────

{
  const t = "extractTag returns content between tags";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<foo>bar</foo>", re), "bar", t);
}

{
  const t = "extractTag trims whitespace";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<foo>  bar  </foo>", re), "bar", t);
}

{
  const t = "extractTag returns empty string when no match";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<baz>bar</baz>", re), "", t);
}

{
  const t = "extractTag handles multiline content";
  const re = /<foo>([\s\S]*?)<\/foo>/i;
  assert.equal(extractTag("<foo>line1\nline2</foo>", re), "line1\nline2", t);
}

// ─── parseResultXml ──────────────────────────────────────────────────────────

{
  const t = "parseResultXml parses all XML fields";
  const raw = [
    "<status>success</status>",
    "<summary>Did the thing</summary>",
    "<findings>Found a bug at src/foo.ts:42</findings>",
    "<evidence>Tests pass</evidence>",
    "<confidence>high</confidence>",
  ].join("\n");
  const r = parseResultXml(raw);
  assert.equal(r.status, "success", t + " status");
  assert.equal(r.summary, "Did the thing", t + " summary");
  assert.equal(r.findings, "Found a bug at src/foo.ts:42", t + " findings");
  assert.equal(r.evidence, "Tests pass", t + " evidence");
  assert.equal(r.confidence, "high", t + " confidence");
}

{
  const t = "parseResultXml returns unknown status when no XML tags present";
  const r = parseResultXml("just plain text");
  assert.equal(r.status, "unknown", t + " status");
  assert.equal(r.summary, "just plain text", t + " summary");
  assert.equal(r.findings, "", t + " findings");
  assert.equal(r.raw, "just plain text", t + " raw");
}

{
  const t = "parseResultXml preserves plain text summaries";
  const longText = "x".repeat(600);
  const r = parseResultXml(longText);
  assert.equal(r.summary, longText, t);
}

{
  const t = "parseResultXml handles partial XML (status only)";
  const r = parseResultXml("<status>failure</status>\nSomething broke");
  assert.equal(r.status, "failure", t + " status");
  assert.equal(r.summary, "", t + " summary");
}

{
  const t = "parseResultXml handles case-insensitive tags";
  const r = parseResultXml("<STATUS>partial</STATUS>\n<SUMMARY>ok</SUMMARY>");
  assert.equal(r.status, "partial", t + " status");
  assert.equal(r.summary, "ok", t + " summary");
}

// ─── formatMs ────────────────────────────────────────────────────────────────

{
  const t = "formatMs returns ms for sub-second";
  assert.equal(formatMs(500), "500ms", t);
}

{
  const t = "formatMs returns seconds for 1-59s";
  assert.equal(formatMs(1500), "1.5s", t);
}

{
  const t = "formatMs returns minutes for 60s+";
  assert.equal(formatMs(90_000), "1m 30s", t);
}

{
  const t = "formatMs handles exact minute";
  assert.equal(formatMs(120_000), "2m 0s", t);
}

{
  const t = "formatMs handles zero";
  assert.equal(formatMs(0), "0ms", t);
}

// ─── parseIdTimestamp ────────────────────────────────────────────────────────

{
  const t = "parseIdTimestamp extracts base36 timestamp from id";
  const ts = Date.now();
  const id = `${ts.toString(36)}-abcd`;
  assert.equal(parseIdTimestamp(id), ts, t);
}

{
  const t =
    "parseIdTimestamp falls back to Date.now() when split yields empty string";
  const before = Date.now();
  const result = parseIdTimestamp("-");
  const after = Date.now();
  assert.ok(result >= before && result <= after, t);
}

{
  const t = "parseIdTimestamp handles empty string";
  const before = Date.now();
  const result = parseIdTimestamp("");
  const after = Date.now();
  assert.ok(result >= before && result <= after, t);
}

// ─── shellQuote ──────────────────────────────────────────────────────────────

{
  const t = "shellQuote wraps in single quotes";
  assert.equal(shellQuote("hello"), "'hello'", t);
}

{
  const t = "shellQuote escapes single quotes";
  assert.equal(shellQuote("it's"), "'it'\"'\"'s'", t);
}

{
  const t = "shellQuote handles empty string";
  assert.equal(shellQuote(""), "''", t);
}

{
  const t = "shellQuote preserves double quotes inside";
  assert.equal(shellQuote('say "hi"'), "'say \"hi\"'", t);
}

// ─── countToolUses ───────────────────────────────────────────────────────────

{
  const t = "countToolUses returns zeros for nonexistent dir";
  const r = countToolUses("/nonexistent/path");
  assert.equal(r.toolUses, 0, t + " toolUses");
  assert.equal(r.turns, 0, t + " turns");
}

{
  const t = "countToolUses counts tool calls from JSONL";
  const dir = mkdtempSync(join(tmpdir(), "task-test-count-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall" },
            { type: "toolCall" },
            { type: "text", text: "ok" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "user", content: "hello" },
      }),
      "not json",
      "",
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = countToolUses(dir);
    assert.equal(r.toolUses, 3, t + " toolUses");
    assert.equal(r.turns, 2, t + " turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "countToolUses handles multiple JSONL files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-count-multi-"));
  try {
    writeFileSync(
      join(dir, "a.jsonl"),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "toolCall" }] },
      }),
    );
    writeFileSync(
      join(dir, "b.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }, { type: "toolCall" }],
        },
      }),
    );

    const r = countToolUses(dir);
    assert.equal(r.toolUses, 3, t + " toolUses");
    assert.equal(r.turns, 2, t + " turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "countToolUses matches session_info name to filter by session";
  const dir = mkdtempSync(join(tmpdir(), "task-test-session-info-"));
  try {
    const jsonl = [
      JSON.stringify({ type: "session_info", name: "old-session" }),
      JSON.stringify({ type: "session_info", name: "new-session" }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }],
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const rNew = countToolUses(dir, "new-session");
    assert.equal(rNew.toolUses, 1, t + " new-session toolUses");
    assert.equal(rNew.turns, 1, t + " new-session turns");

    const rOld = countToolUses(dir, "old-session");
    assert.equal(rOld.toolUses, 0, t + " old-session toolUses");
    assert.equal(rOld.turns, 0, t + " old-session turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "countToolUses filters out entries before sinceMs";
  const dir = mkdtempSync(join(tmpdir(), "task-test-count-since-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }],
        },
        timestamp: "2024-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall" }, { type: "toolCall" }],
        },
        timestamp: "2025-01-01T00:00:00.000Z",
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = countToolUses(dir, undefined, Date.parse("2024-06-01T00:00:00.000Z"));
    assert.equal(r.toolUses, 2, t + " toolUses");
    assert.equal(r.turns, 1, t + " turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── summarizeArgs ──────────────────────────────────────────────────────────

{
  const t = "summarizeArgs returns path for read/write/edit";
  assert.equal(
    summarizeArgs("read", { path: "/tmp/foo.ts" }),
    "/tmp/foo.ts",
    t,
  );
  assert.equal(
    summarizeArgs("write", { file_path: "/x.ts" }),
    "/x.ts",
    t + " file_path",
  );
  assert.equal(summarizeArgs("edit", { path: "/a/b/c" }), "/a/b/c", t);
}

{
  const t = "summarizeArgs returns command for bash";
  assert.equal(summarizeArgs("bash", { command: "npm test" }), "npm test", t);
  assert.equal(summarizeArgs("bash", { cmd: "ls -la" }), "ls -la", t + " cmd");
}

{
  const t = "summarizeArgs returns query for search tools";
  assert.equal(
    summarizeArgs("websearch", { query: "MCP spec 2026" }),
    "MCP spec 2026",
    t,
  );
  assert.equal(
    summarizeArgs("codesearch", { query: "MCP" }),
    "MCP",
    t + " codesearch",
  );
}

{
  const t = "summarizeArgs returns url for fetch tools";
  assert.equal(
    summarizeArgs("web_fetch", { url: "https://example.com" }),
    "https://example.com",
    t,
  );
  assert.equal(
    summarizeArgs("webclaw_scrape", { url: "https://x.com" }),
    "https://x.com",
    t + " webclaw",
  );
}

{
  const t = "summarizeArgs returns count for batch tools";
  assert.equal(
    summarizeArgs("webclaw_batch", { urls: ["a", "b", "c"] }),
    "3 urls",
    t,
  );
}

{
  const t = "summarizeArgs returns count for task_batch";
  assert.equal(
    summarizeArgs("task_batch", { tasks: [{}, {}, {}] }),
    "3 tasks",
    t,
  );
}

{
  const t = "summarizeArgs falls back to first string for unknown tool";
  assert.equal(summarizeArgs("custom_tool", { foo: "bar", n: 42 }), "bar", t);
}

{
  const t = "summarizeArgs returns empty for non-object args";
  assert.equal(summarizeArgs("read", null), "", t);
  assert.equal(summarizeArgs("read", undefined), "", t + " undefined");
  assert.equal(summarizeArgs("read", "string"), "", t + " string");
}

{
  const t = "summarizeArgs returns empty when no string args present";
  assert.equal(summarizeArgs("read", { n: 1, b: true }), "", t);
}

// ─── readRecentToolCalls ─────────────────────────────────────────────────────

{
  const t = "readRecentToolCalls returns zeros and empty for nonexistent dir";
  const r = readRecentToolCalls("/nonexistent/path");
  assert.equal(r.toolUses, 0, t + " toolUses");
  assert.equal(r.turns, 0, t + " turns");
  assert.deepEqual(r.recent, [], t + " recent");
}

{
  const t = "readRecentToolCalls marks calls without toolResult as in_progress";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "websearch",
              arguments: { query: "MCP" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.toolUses, 1, t + " toolUses");
    assert.equal(r.turns, 1, t + " turns");
    assert.equal(r.recent.length, 1, t + " recent length");
    assert.equal(r.recent[0].name, "websearch", t + " name");
    assert.equal(r.recent[0].detail, "MCP", t + " detail");
    assert.equal(r.recent[0].status, "in_progress", t + " status");
    assert.equal(r.recent[0].id, "c1", t + " id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls matches toolResult and marks done";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-done-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/foo.ts" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", isError: false },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.recent.length, 1, t + " recent length");
    assert.equal(r.recent[0].status, "done", t + " status");
    assert.equal(r.recent[0].detail, "/foo.ts", t + " detail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls marks isError results as error";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-err-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "bash",
              arguments: { command: "false" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        message: { role: "toolResult", toolCallId: "c1", isError: true },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.recent[0].status, "error", t + " status");
    assert.equal(r.recent[0].detail, "false", t + " detail");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls respects limit and returns most recent calls";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-limit-"));
  try {
    const blocks: string[] = [];
    for (let i = 0; i < 20; i++) {
      blocks.push(
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: `c${i}`,
                name: "bash",
                arguments: { command: `echo ${i}` },
              },
            ],
          },
        }),
      );
      blocks.push(
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: `c${i}`, isError: false },
        }),
      );
    }
    writeFileSync(join(dir, "session.jsonl"), blocks.join("\n"));

    const r = readRecentToolCalls(dir, 5);
    assert.equal(r.toolUses, 20, t + " total toolUses");
    assert.equal(r.recent.length, 5, t + " recent length");
    // Last 5 should be c15..c19
    assert.equal(r.recent[0].detail, "echo 15", t + " first recent");
    assert.equal(r.recent[4].detail, "echo 19", t + " last recent");
    assert.equal(r.recent[0].status, "done", t + " status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls walks multiple JSONL files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-multi-"));
  try {
    writeFileSync(
      join(dir, "a.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/a" },
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(dir, "b.jsonl"),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c2",
              name: "read",
              arguments: { path: "/b" },
            },
          ],
        },
      }) +
        "\n" +
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: "c2", isError: false },
        }),
    );

    const r = readRecentToolCalls(dir);
    assert.equal(r.toolUses, 2, t + " total toolUses");
    assert.equal(r.recent.length, 2, t + " recent length");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls skips toolCalls without id";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-noid-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall" }, // no id
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/x" },
            },
          ],
        },
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    // toolUses counts both (per existing countToolUses contract), but recent only includes id'd ones
    assert.equal(r.toolUses, 2, t + " toolUses counts both");
    assert.equal(r.recent.length, 1, t + " recent only id'd");
    assert.equal(r.recent[0].id, "c1", t + " id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls tolerates malformed lines";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-bad-"));
  try {
    const jsonl = [
      "not json",
      "",
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/x" },
            },
          ],
        },
      }),
      "{this is also broken",
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir);
    assert.equal(r.toolUses, 1, t + " toolUses");
    assert.equal(r.recent.length, 1, t + " recent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "readRecentToolCalls filters out entries before sinceMs";
  const dir = mkdtempSync(join(tmpdir(), "task-test-recent-since-"));
  try {
    const jsonl = [
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c1",
              name: "read",
              arguments: { path: "/old" },
            },
          ],
        },
        timestamp: "2024-01-01T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "c2",
              name: "read",
              arguments: { path: "/a" },
            },
            {
              type: "toolCall",
              id: "c3",
              name: "bash",
              arguments: { command: "ls" },
            },
          ],
        },
        timestamp: "2025-01-01T00:00:00.000Z",
      }),
    ].join("\n");
    writeFileSync(join(dir, "session.jsonl"), jsonl);

    const r = readRecentToolCalls(dir, 12, undefined, Date.parse("2024-06-01T00:00:00.000Z"));
    assert.equal(r.toolUses, 2, t + " toolUses");
    assert.equal(r.turns, 1, t + " turns");
    assert.equal(r.recent.length, 2, t + " recent length");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── findPiDir ───────────────────────────────────────────────────────────────

{
  const t = "findPiDir finds .pi in parent directory";
  const root = mkdtempSync(join(tmpdir(), "task-test-findpi-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir);
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });

    assert.equal(findPiDir(nested), piDir, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "findPiDir returns null when no .pi exists";
  const root = mkdtempSync(join(tmpdir(), "task-test-findpi-null-"));
  try {
    assert.equal(findPiDir(join(root, "a", "b")), null, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const t = "findPiDir handles cwd inside .pi directory itself";
  const root = mkdtempSync(join(tmpdir(), "task-test-findpi-inside-"));
  try {
    const piDir = join(root, ".pi");
    mkdirSync(piDir);
    // cwd is the .pi dir itself — should find .pi in parent
    assert.equal(findPiDir(piDir), piDir, t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── loadAgentsFromDir ───────────────────────────────────────────────────────

{
  const t = "loadAgentsFromDir returns empty for nonexistent dir";
  const r = loadAgentsFromDir("/nonexistent/path", "project");
  assert.equal(r.length, 0, t);
}

{
  const t = "loadAgentsFromDir parses agent markdown files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-agents-"));
  try {
    writeFileSync(
      join(dir, "explore.md"),
      [
        "---",
        "description: Read-only codebase explorer",
        "model: gpt-4o",
        "tools: read, grep",
        "disallowed_tools: edit, write",
        "---",
        "",
        "# Explore Agent",
        "You explore code.",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "worker.md"),
      [
        "---",
        "description: Fast implementer",
        "thinking: high",
        "---",
        "",
        "# Worker Agent",
        "You implement code.",
      ].join("\n"),
    );

    const agents = loadAgentsFromDir(dir, "user");
    assert.equal(agents.length, 2, t + " count");

    const explore = agents.find((a) => a.name === "explore");
    assert.ok(explore, t + " explore exists");
    assert.equal(
      explore!.description,
      "Read-only codebase explorer",
      t + " description",
    );
    assert.equal(explore!.model, "gpt-4o", t + " model");
    assert.ok(
      explore!.disallowedTools?.includes("edit"),
      t + " disallowed edit",
    );
    assert.deepEqual(explore!.tools, ["read", "grep"], t + " tools");
    assert.ok(
      explore!.disallowedTools?.includes("write"),
      t + " disallowed write",
    );
    assert.ok(
      explore!.disallowedTools?.includes("xai_web_search"),
      t + " disallowed xai",
    );
    assert.equal(explore!.source, "user", t + " source");
    assert.match(explore!.body, /# Explore Agent/, t + " body");

    const worker = agents.find((a) => a.name === "worker");
    assert.ok(worker, t + " worker exists");
    assert.equal(worker!.thinking, "high", t + " thinking");
    assert.ok(
      worker!.disallowedTools?.includes("xai_generate_text"),
      t + " default xai disallow",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "loadAgentsFromDir skips files without description";
  const dir = mkdtempSync(join(tmpdir(), "task-test-agents-nodesc-"));
  try {
    writeFileSync(
      join(dir, "no-desc.md"),
      ["---", "model: gpt-4o", "---", "Body without description."].join("\n"),
    );
    writeFileSync(
      join(dir, "has-desc.md"),
      ["---", "description: Has one", "---", "Body."].join("\n"),
    );

    const agents = loadAgentsFromDir(dir, "project");
    assert.equal(agents.length, 1, t + " count");
    assert.equal(agents[0].name, "has-desc", t + " name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const t = "loadAgentsFromDir skips non-md files";
  const dir = mkdtempSync(join(tmpdir(), "task-test-agents-nonmd-"));
  try {
    writeFileSync(join(dir, "readme.txt"), "not an agent");
    writeFileSync(
      join(dir, "agent.md"),
      "---\ndescription: Real agent\n---\nBody.",
    );

    const agents = loadAgentsFromDir(dir, "project");
    assert.equal(agents.length, 1, t);
    assert.equal(agents[0].name, "agent", t + " name");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── formatAgentList ─────────────────────────────────────────────────────────

{
  const t = "formatAgentList returns 'none available' for empty";
  assert.equal(formatAgentList([]), "none available", t);
}

{
  const t = "formatAgentList formats agent entries";
  const agents: AgentConfig[] = [
    {
      name: "explore",
      description: "Read-only explorer",
      body: "",
      source: "project",
      path: "/a",
    },
    {
      name: "worker",
      description: "Fast implementer",
      body: "",
      source: "user",
      path: "/b",
    },
  ];
  const r = formatAgentList(agents);
  assert.match(r, /explore \(project\): Read-only explorer/, t + " explore");
  assert.match(r, /worker \(user\): Fast implementer/, t + " worker");
}

// ─── Integration: discoverAgents with fixture ────────────────────────────────

{
  const t = "discoverAgents merges project and user agents, project overrides";
  const root = mkdtempSync(join(tmpdir(), "task-test-discover-"));
  try {
    const piDir = join(root, ".pi");
    const projDir = join(piDir, "agents");
    const userDir = join(root, "user-agents");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });

    // User agent
    writeFileSync(
      join(userDir, "explore.md"),
      "---\ndescription: User explore\n---\nUser body.",
    );
    // Same name in project — should override
    writeFileSync(
      join(projDir, "explore.md"),
      "---\ndescription: Project explore\n---\nProject body.",
    );
    // Only in user
    writeFileSync(
      join(userDir, "scout.md"),
      "---\ndescription: Scout agent\n---\nScout body.",
    );

    // Temporarily override HOME so getGlobalAgentDir picks up our fixture
    const origHome = process.env.HOME;
    process.env.HOME = root;
    // Move user agents to the expected global location
    const globalDir = join(root, ".pi", "agent", "agents");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, "explore.md"),
      "---\ndescription: User explore\n---\nUser body.",
    );
    writeFileSync(
      join(globalDir, "scout.md"),
      "---\ndescription: Scout agent\n---\nScout body.",
    );

    try {
      const { agents } = discoverAgents(projDir); // cwd inside .pi
      const explore = agents.find((a) => a.name === "explore");
      assert.ok(explore, t + " explore exists");
      assert.equal(
        explore!.description,
        "Project explore",
        t + " project overrides user",
      );
      assert.equal(explore!.source, "project", t + " source is project");

      const scout = agents.find((a) => a.name === "scout");
      assert.ok(scout, t + " scout exists");
      assert.equal(scout!.source, "user", t + " scout from user");
    } finally {
      if (origHome !== undefined) process.env.HOME = origHome;
      else delete process.env.HOME;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ─── Task tool hardening contracts ───────────────────────────────────────────

{
  const t = "chooseTmuxSplitDirection allocates narrow panes vertically";
  assert.equal(chooseTmuxSplitDirection(120, 40), "-v", t);
}

{
  const t = "chooseTmuxSplitDirection allocates wide panes horizontally";
  assert.equal(chooseTmuxSplitDirection(200, 40), "-h", t);
}

{
  const t =
    "buildTmuxSplitWindowArgs starts task command directly, without send-keys";
  const command = "cd '/tmp/safe path' && echo $(must-not-run) && echo `nope`";
  assert.deepEqual(
    buildTmuxSplitWindowArgs("/tmp/safe path", command, "-v"),
    [
      "split-window",
      "-v",
      "-P",
      "-F",
      "#{pane_id}",
      "-c",
      "/tmp/safe path",
      command,
    ],
    t,
  );
}

{
  const t = "buildTmuxSplitWindowArgs targets the pane that was measured";
  assert.deepEqual(
    buildTmuxSplitWindowArgs("/work", "echo ok", "-h", "%7"),
    [
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "%7",
      "-c",
      "/work",
      "echo ok",
    ],
    t,
  );
}

{
  const t = "formatBackgroundReceipt returns visible task launch details";
  const receipt = formatBackgroundReceipt({
    taskId: "task-123",
    agentType: "explore",
    backend: "herdr",
    paneId: "w1:p2",
    sessionName: "pi-task-task-123",
    artifactDir: "/tmp/.pi/tasks/task-123",
  });
  assert.ok(receipt.includes("Started task task-123"), t + " includes task id");
  assert.ok(receipt.includes("explore"), t + " includes agent type");
  assert.ok(receipt.includes("pi-task-task-123"), t + " includes session");
  assert.ok(
    receipt.includes("/tmp/.pi/tasks/task-123"),
    t + " includes artifact dir",
  );
  assert.ok(
    receipt.includes("completion notification"),
    t + " explains notification",
  );
}

{
  const t = "validateTaskBatchSize accepts supported bounds";
  assert.deepEqual(
    validateTaskBatchSize(TASK_BATCH_MIN_TASKS),
    { ok: true, count: TASK_BATCH_MIN_TASKS },
    t + " min",
  );
  assert.deepEqual(
    validateTaskBatchSize(TASK_BATCH_MAX_TASKS),
    { ok: true, count: TASK_BATCH_MAX_TASKS },
    t + " max",
  );
}

{
  const t = "validateTaskBatchSize rejects outside supported bounds";
  const empty = validateTaskBatchSize(0);
  assert.equal(empty.ok, false, t + " empty ok");
  assert.equal(empty.count, 0, t + " empty count");
  assert.match(empty.error, /at least 1 task/, t + " empty message");

  const tooMany = validateTaskBatchSize(TASK_BATCH_MAX_TASKS + 1);
  assert.equal(tooMany.ok, false, t + " too many ok");
  assert.equal(tooMany.count, TASK_BATCH_MAX_TASKS + 1, t + " too many count");
  assert.match(tooMany.error, /at most 12 tasks/, t + " too many message");
}

{
  const t = "validateTaskBatchTasks normalizes valid task items";
  const result = validateTaskBatchTasks([
    {
      agent_type: " explore ",
      prompt: " inspect files ",
      description: " inspect ",
    },
  ]);

  assert.equal(result.ok, true, t + " ok");
  assert.equal(result.count, 1, t + " count");
  assert.deepEqual(
    result.ok ? result.tasks[0] : undefined,
    {
      agent_type: "explore",
      prompt: "inspect files",
      description: "inspect",
    },
    t + " task",
  );
}

{
  const t = "validateTaskBatchTasks reports item validation failures";
  const notArray = validateTaskBatchTasks({ tasks: [] });
  assert.equal(notArray.ok, false, t + " not array");
  assert.match(notArray.error, /array/, t + " not array message");

  const missingPrompt = validateTaskBatchTasks([
    { agent_type: "explore", prompt: "", description: "scan" },
  ]);
  assert.equal(missingPrompt.ok, false, t + " missing prompt");
  assert.match(missingPrompt.error, /task 1 requires a non-empty prompt/, t);

  const itemBackend = validateTaskBatchTasks([
    {
      agent_type: "explore",
      prompt: "scan",
      description: "scan",
      backend: "herdr",
    },
  ]);
  assert.equal(itemBackend.ok, false, t + " item backend");
  assert.match(
    itemBackend.error,
    /must not include backend/,
    t + " backend message",
  );

  const itemConversation = validateTaskBatchTasks([
    {
      agent_type: "explore",
      prompt: "scan",
      description: "scan",
      conversation_id: "resume-me",
    },
  ]);
  assert.equal(itemConversation.ok, false, t + " item conversation");
  assert.match(
    itemConversation.error,
    /must not include task_id or conversation_id/,
    t + " conversation message",
  );
}

{
  const t = "formatTaskBatchReceipt returns visible launch details";
  const receipt = formatTaskBatchReceipt([
    {
      taskId: "task-a",
      agentType: "explore",
      description: "scan helpers",
      backend: "herdr",
      paneId: "w1:p2",
      sessionName: "task-task-a",
      sessionDir: "/tmp/.pi/artifacts/sessions/task-a",
      artifactDir: "/tmp/.pi/artifacts",
    },
    {
      taskId: "task-b",
      agentType: "reviewer",
      description: "review tests",
      backend: "sdk",
      sessionName: "task-task-b",
      sessionDir: "/tmp/.pi/artifacts/sessions/task-b",
      artifactDir: "/tmp/.pi/artifacts",
    },
  ]);

  assert.ok(receipt.includes("Started 2 background tasks"), t + " heading");
  assert.ok(receipt.includes("1. task-a (explore)"), t + " first task");
  assert.ok(receipt.includes("Pane: w1:p2"), t + " pane");
  assert.ok(
    receipt.includes("Session directory: /tmp/.pi/artifacts/sessions/task-a"),
    t + " session dir",
  );
  assert.ok(receipt.includes("2. task-b (reviewer)"), t + " second task");
  assert.ok(
    receipt.includes("Completion notifications"),
    t + " notification guidance",
  );
}

{
  const t = "formatTaskBatchDetails returns serializable batch details";
  const details = formatTaskBatchDetails([
    {
      taskId: "task-a",
      agentType: "explore",
      description: "scan helpers",
      backend: "tmux",
      paneId: "%7",
      sessionName: "task-task-a",
      sessionDir: "/tmp/.pi/artifacts/sessions/task-a",
      artifactDir: "/tmp/.pi/artifacts",
    },
  ]);

  assert.equal(details.batch, true, t + " batch");
  assert.equal(details.background, true, t + " background");
  assert.equal(details.task_count, 1, t + " count");
  assert.deepEqual(
    details.tasks[0],
    {
      task_id: "task-a",
      agent_type: "explore",
      description: "scan helpers",
      backend: "tmux",
      pane_id: "%7",
      session_name: "task-task-a",
      session_dir: "/tmp/.pi/artifacts/sessions/task-a",
      artifact_dir: "/tmp/.pi/artifacts",
      background: true,
    },
    t + " task detail",
  );
}

{
  const t = "task_batch description documents limits and background behavior";
  assert.ok(
    TASK_BATCH_TOOL_DESCRIPTION.includes("Launch multiple background task agents"),
    t + " background",
  );
  assert.ok(
    TASK_BATCH_TOOL_DESCRIPTION.includes(`${TASK_BATCH_MIN_TASKS}-${TASK_BATCH_MAX_TASKS}`),
    t + " limits",
  );
}

{
  const t =
    "task tool description matches background default and verification policy";
  assert.equal(TASK_BACKGROUND_DEFAULT, true, t + " default is true");
  assert.ok(
    TASK_TOOL_DESCRIPTION.includes("Background is the default"),
    t + " documents background default",
  );
  assert.ok(
    !TASK_TOOL_DESCRIPTION.includes("Foreground is the default"),
    t + " does not claim foreground default",
  );
  assert.ok(
    TASK_TOOL_DESCRIPTION.includes("Do not trust delegated output blindly"),
    t + " requires verification",
  );
}

{
  const t = "task prompt instructions use JSONL final-message results";
  assert.ok(
    TASK_PROMPT_INSTRUCTIONS.includes("final assistant message IS the result"),
    t + " final message",
  );
  assert.ok(
    TASK_PROMPT_INSTRUCTIONS.includes("session JSONL"),
    t + " mentions JSONL",
  );
  assert.ok(
    TASK_PROMPT_INSTRUCTIONS.includes("Do not write a RESULT.md file"),
    t + " avoids result files",
  );
  assert.ok(
    !TASK_PROMPT_INSTRUCTIONS.includes("<summary>"),
    t + " avoids XML tags",
  );
}

// ─── findJsonlSessionByName ──────────────────────────────────────────────────

{
  const t = "findJsonlSessionByName matches the latest session_info entry";
  const root = mkdtempSync(join(tmpdir(), "task-test-findjsonl-"));
  try {
    const piDir = join(root, ".pi");
    const sessionsDir = join(piDir, "artifacts", "sessions");
    mkdirSync(sessionsDir, { recursive: true });

    const { findJsonlSessionByName } = await import("../src/conversation.js");

    const jsonl = [
      JSON.stringify({ type: "session_info", name: "parent-session" }),
      JSON.stringify({ type: "session_info", name: "forked-session" }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    ].join("\n");
    writeFileSync(join(sessionsDir, "forked-session.jsonl"), jsonl);

    const found = findJsonlSessionByName(piDir, "forked-session", "explore");
    assert.ok(found, t + " found");
    assert.equal(found?.sessionName, "forked-session", t + " name");
    assert.equal(found?.agentType, "explore", t + " agent type");

    const notFound = findJsonlSessionByName(piDir, "parent-session", "explore");
    assert.equal(notFound, undefined, t + " parent name should not match latest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("ALL TASK HELPER TESTS PASSED");

            {
              const { readTaskBlock, writeTaskBlock, listTaskBlocks, getTasksFilePath } =
                await import("../src/conversation.js");
              const os = await import("node:os");
              const fs = await import("node:fs/promises");
              const { join } = await import("node:path");
              const tmpDir = await fs.mkdtemp(join(os.tmpdir(), "pitask-test-"));
              try {
                // Initially empty.
                assert.equal(listTaskBlocks(tmpDir).size, 0);
                assert.equal(readTaskBlock(tmpDir, "abc123"), undefined);

                // Write a block, then read it back.
                writeTaskBlock({
                  piDir: tmpDir,
                  taskId: "abc123",
                  status: "done",
                  updated: "2026-06-23T00:00:00.000Z",
                  body: "#### Result\n\nhello",
                });
                const block = readTaskBlock(tmpDir, "abc123");
                assert.equal(block?.status, "done");
                assert.ok(block?.body.includes("hello"));

                // listTaskBlocks returns the same block.
                const all = listTaskBlocks(tmpDir);
                assert.equal(all.size, 1);
                assert.ok(all.has("abc123"));

                // TASKS.md file exists at the expected path.
                assert.ok(
                  (await fs.stat(getTasksFilePath(tmpDir))).isFile(),
                );
              } finally {
                await fs.rm(tmpDir, { recursive: true, force: true });
              }
            }

    {
      const { normalizeConversationId } = await import("../src/conversation.js");
      assert.equal(normalizeConversationId(" research-ai "), "research-ai");
              assert.equal(normalizeConversationId(undefined), undefined);
              assert.throws(
                () => normalizeConversationId("research/ai"),
                    /conversation_id/,
                  );
            }
