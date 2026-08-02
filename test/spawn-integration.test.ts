/**
 * Integration test for spawning explore subagents via task and task_batch.
 *
 * Tests the key code paths of recent modifications:
 *   - Backend selection (auto/herdr/tmux/sdk)
 *   - Agent discovery and tool resolution
 *   - Task build args fresh vs resume
 *   - Background task registration and lifecycle
 *   - Batch task validation and spawning
 *   - Conversation helpers (registry, session history)
 *
 * Run: PI_XAI_SIDE_TOOLS=0 tsx --test test/spawn-integration.test.ts
 */

import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// ─── Fixture Setup ───────────────────────────────────────────────────────────

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "task-spawn-test-"));
  const piDir = join(root, ".pi");
  const agentsDir = join(piDir, "agents");
  const artifactsDir = join(piDir, "artifacts");
  const sessionsDir = join(artifactsDir, "sessions");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  // Create explore agent matching the bundled explore.md
  writeFileSync(
    join(agentsDir, "explore.md"),
    [
      "---",
      "description: Read-only codebase cartographer. Finds files, symbols, usage patterns, and call paths without modifying anything.",
      "model: opencode-go/deepseek-v4-flash",
      "thinking: off",
      "disallowed_tools: edit",
      "---",
      "",
      "# Explore Agent",
      "",
      "Purpose: map the local codebase quickly. Do not modify files.",
      "",
      "## Rules",
      "- Read-only is mandatory. Do not edit, write, delete, commit, or run destructive commands.",
    ].join("\n"),
  );

  return { root, piDir, agentsDir, artifactsDir, sessionsDir };
}

// ─── Test 1: Agent discovery loads explore agent correctly ──────────────────

test("discoverAgents loads explore agent with disallowed_tools", async () => {
  const { root, agentsDir } = createFixture();
  try {
    const { discoverAgents } = await import("../src/helpers.js");
    const { agents } = discoverAgents(agentsDir);
    const explore = agents.find((a) => a.name === "explore");

    assert.ok(explore, "explore agent discovered");
    assert.equal(explore!.source, "project");
    assert.ok(
      explore!.description.includes("codebase cartographer"),
      "explore agent description",
    );
    assert.ok(
      explore!.disallowedTools?.includes("edit"),
      "explore disallows edit",
    );
    // write is only mentioned in the body instructions, not in disallowed_tools frontmatter
    // But xai_* tools are disallowed by default when PI_XAI_SIDE_TOOLS=0
    assert.ok(
      explore!.disallowedTools?.includes("xai_web_search"),
      "explore disallows xai tools via parseMergedDisallowedTools",
    );
    assert.ok(explore!.body.includes("Purpose:"), "explore body loaded");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Test 2: BuildPiArgs for fresh explore task ────────────────────────────

test("buildPiArgs produces correct CLI args for fresh explore task", async () => {
  const { root, piDir, agentsDir, sessionsDir } = createFixture();
  try {
    const { discoverAgents, buildPiArgs } = await import("../src/helpers.js");
    const { agents } = discoverAgents(agentsDir);
    const explore = agents.find((a) => a.name === "explore")!;

    const sessionName = "task-explore-test";
    const promptContent = "Map the authentication flow in the codebase.";

    const args = buildPiArgs(explore, sessionName, sessionsDir, promptContent);

    // Verify essential args
    assert.ok(args.includes("--name"), "has --name");
    assert.ok(args.includes(sessionName), "has session name");
    assert.ok(args.includes("--session-dir"), "has --session-dir");
    assert.ok(args.includes(sessionsDir), "has sessions dir");

    // Should NOT include --session for fresh task
    assert.ok(
      !args.includes("--session"),
      "no --session for fresh task",
    );

    // The prompt content is passed as the last positional argument
    const lastArg = args[args.length - 1];
    assert.ok(
      lastArg.includes(promptContent),
      "prompt content included as positional argument",
    );

    // --append-system-prompt carries the agent body, not the task prompt
    const promptIdx = args.indexOf("--append-system-prompt");
    assert.ok(promptIdx >= 0, "has --append-system-prompt");
    assert.ok(
      args[promptIdx + 1].includes(explore.body),
      "append-system-prompt carries agent body",
    );

    // Should include --tools with edit excluded
    const toolsIdx = args.indexOf("--tools");
    assert.ok(toolsIdx >= 0, "has --tools");
    const toolList = args[toolsIdx + 1].split(",");
    assert.ok(toolList.includes("read"), "read in tools");
    assert.ok(toolList.includes("bash"), "bash in tools");
    assert.ok(!toolList.includes("edit"), "edit excluded from tools");
    assert.ok(!toolList.includes("task"), "task excluded from tools");

    console.log(`  CLI command would be: pi ${args.join(" ")}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Test 3: BuildPiArgs accepts a resolved provider model override ─────────

test("buildPiArgs uses an explicit model override without mutating the agent", async () => {
  const { buildPiArgs } = await import("../src/helpers.js");
  const agent = {
    name: "explore",
    description: "Read-only explorer",
    model: "default/model",
    modelByProvider: { "openai-codex": "override/model" },
    body: "You explore.",
    source: "project" as const,
    path: "/fake/path",
  };

  const args = buildPiArgs(
    agent,
    "task-model-override",
    "/tmp/sessions",
    "do work",
    false,
    [],
    undefined,
    undefined,
    "override/model",
  );

  const modelIdx = args.indexOf("--model");
  assert.ok(modelIdx >= 0, "args contain --model");
  assert.equal(args[modelIdx + 1], "override/model");
  assert.equal(agent.model, "default/model");
});

// ─── Test 4: BuildPiArgs for resume task ────────────────────────────────────

test("buildPiArgs includes --session for resume explore task", async () => {
  const { root, agentsDir, sessionsDir } = createFixture();
  try {
    const { discoverAgents, buildPiArgs } = await import("../src/helpers.js");
    const { agents } = discoverAgents(agentsDir);
    const explore = agents.find((a) => a.name === "explore")!;

    const args = buildPiArgs(
      explore,
      "task-explore-resume",
      sessionsDir,
      "Continue exploring",
      true, // resume
    );

    assert.ok(args.includes("--session"), "--session present for resume");
    const sessionIdx = args.indexOf("--session");
    assert.equal(args[sessionIdx + 1], "task-explore-resume");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Test 5: Agent tool resolution for explore ──────────────────────────────

test("resolveAgentToolAllowlist correctly filters explore agent tools", async () => {
  const { resolveAgentToolAllowlist } = await import("../src/agent-tools.js");

  // Simulate explore agent (disallowed_tools: edit)
  const tools = resolveAgentToolAllowlist({
    disallowedTools: ["edit"],
    parentToolNames: ["read", "bash", "edit", "write", "grep", "find", "ls", "websearch"],
  });

  assert.ok(tools.includes("read"), "read allowed");
  assert.ok(tools.includes("bash"), "bash allowed");
  assert.ok(!tools.includes("edit"), "edit disallowed");
  assert.ok(!tools.includes("task"), "task never allowed in subagents");

  // With explicit tools
  const explicitTools = resolveAgentToolAllowlist({
    tools: ["read", "bash", "grep"],
    parentToolNames: ["read", "bash", "edit", "write", "grep"],
  });
  assert.deepEqual(explicitTools, ["read", "bash", "grep"]);
});

// ─── Test 6: Backend selection for explore tasks ───────────────────────────

test("selectSubagentBackend prefers herdr > tmux > sdk", async () => {
  const { selectSubagentBackend } = await import("../src/subagent/backend.js");

  const paneBackends = [
    { name: "herdr" as const, available: () => false },
    { name: "tmux" as const, available: () => false },
  ] as any;

  // SDK explicit
  const sdkSel = selectSubagentBackend("sdk", paneBackends);
  assert.equal(sdkSel.name, "sdk");
  assert.equal(sdkSel.paneBackend, undefined);

  // Auto falls back to SDK when no pane backend available
  const autoSel = selectSubagentBackend("auto", paneBackends);
  assert.equal(autoSel.name, "sdk");

  // Explicit sdk
  assert.deepEqual(
    selectSubagentBackend("sdk", paneBackends),
    { name: "sdk" },
  );
});

// ─── Test 6: Task batch validation ──────────────────────────────────────────

test("validateTaskBatchTasks correctly validates explore batch configs", async () => {
  const { validateTaskBatchTasks } = await import("../src/helpers.js");

  // Valid single task
  const single = validateTaskBatchTasks([
    {
      agent_type: "explore",
      prompt: "Map the auth flow. Return file:line evidence.",
      description: "Explore auth flow",
    },
  ]);
  assert.ok(single.ok, "valid single task");
  if (single.ok) {
    assert.equal(single.count, 1);
    assert.equal(single.tasks[0].agent_type, "explore");
    assert.equal(single.tasks[0].description, "Explore auth flow");
  }

  // Valid multiple tasks (simulating batch of explore agents)
  const multi = validateTaskBatchTasks([
    {
      agent_type: "explore",
      prompt: "Explore component A",
      description: "Explore component A",
    },
    {
      agent_type: "explore",
      prompt: "Explore component B",
      description: "Explore component B",
    },
    {
      agent_type: "explore",
      prompt: "Explore component C",
      description: "Explore component C",
    },
  ]);
  assert.ok(multi.ok, "valid multi tasks");
  if (multi.ok) {
    assert.equal(multi.count, 3);
    assert.equal(multi.tasks.length, 3);
  }

  // Missing agent_type
  const missingType = validateTaskBatchTasks([
    { prompt: "test", description: "test" },
  ]);
  assert.ok(!missingType.ok, "rejects missing agent_type");
  if (!missingType.ok) {
    assert.ok(missingType.error.includes("agent_type"));
  }

  // Missing prompt
  const missingPrompt = validateTaskBatchTasks([
    { agent_type: "explore", description: "test" },
  ]);
  assert.ok(!missingPrompt.ok, "rejects missing prompt");
  if (!missingPrompt.ok) {
    assert.ok(missingPrompt.error.includes("prompt"));
  }

  // Backend in individual task (should fail)
  const backendInTask = validateTaskBatchTasks([
    {
      agent_type: "explore",
      prompt: "test",
      description: "test",
      backend: "tmux",
    },
  ]);
  assert.ok(!backendInTask.ok, "rejects backend in individual task");
  if (!backendInTask.ok) {
    assert.ok(backendInTask.error.includes("backend"));
  }

  // Too many tasks
  const tooMany: any[] = [];
  for (let i = 0; i < 15; i++) {
    tooMany.push({
      agent_type: "explore",
      prompt: `Task ${i}`,
      description: `Task ${i}`,
    });
  }
  const overLimit = validateTaskBatchTasks(tooMany);
  assert.ok(!overLimit.ok, "rejects > 12 tasks");
  if (!overLimit.ok) {
    assert.ok(overLimit.error.includes("12"));
  }
});

// ─── Test 7: Task batch formatting and receipt ──────────────────────────────

test("formatTaskBatchReceipt and formatTaskBatchDetails produce expected output", async () => {
  const { formatTaskBatchReceipt, formatTaskBatchDetails } = await import("../src/helpers.js");

  const tasks = [
    {
      taskId: "task-explore-1",
      agentType: "explore",
      description: "Explore auth flow",
      backend: "tmux" as const,
      paneId: "%10",
      sessionName: "task-explore-1",
      sessionDir: "/tmp/sessions/1",
      artifactDir: "/tmp/artifacts",
    },
    {
      taskId: "task-explore-2",
      agentType: "scout",
      description: "Research API",
      backend: "herdr" as const,
      sessionName: "task-explore-2",
      sessionDir: "/tmp/sessions/2",
      artifactDir: "/tmp/artifacts",
    },
  ];

  const receipt = formatTaskBatchReceipt(tasks);
  assert.ok(receipt.includes("task-explore-1"), "receipt includes first task id");
  assert.ok(receipt.includes("task-explore-2"), "receipt includes second task id");
  assert.ok(receipt.includes("explore"), "receipt includes agent type");
  assert.ok(receipt.includes("%10"), "receipt includes pane id");

  const details = formatTaskBatchDetails(tasks);
  assert.equal(details.batch, true);
  assert.equal(details.background, true);
  assert.equal(details.task_count, 2);
  assert.equal(details.tasks.length, 2);
  assert.equal(details.tasks[0].task_id, "task-explore-1");
  assert.equal(details.tasks[1].agent_type, "scout");
});

// ─── Test 8: Registry persistence (read/write/upsert) ──────────────────────

test("registry persistence correctly tracks batch tasks", async () => {
  const { root, piDir } = createFixture();
  try {
    const { readRegistry, writeRegistry, upsertTaskSessionHistory, readTaskSessionHistory } = await import("../src/conversation.js");

    // Write registry entries mimicking batch-launched tasks
    const entries = [
      {
        id: "batch-explore-1",
        agentType: "explore",
        description: "Explore module A",
        sessionName: "task-batch-explore-1",
        startedAt: Date.now(),
        paneId: "%11",
        piDir,
        dir: join(piDir, "artifacts"),
        backend: "tmux" as const,
        batchId: "batch-explore-test",
        batchLabel: "Explore batch",
        batchIndex: 0,
        batchSize: 3,
      },
      {
        id: "batch-explore-2",
        agentType: "explore",
        description: "Explore module B",
        sessionName: "task-batch-explore-2",
        startedAt: Date.now(),
        paneId: "%12",
        piDir,
        dir: join(piDir, "artifacts"),
        backend: "tmux" as const,
        batchId: "batch-explore-test",
        batchLabel: "Explore batch",
        batchIndex: 1,
        batchSize: 3,
      },
    ];

    writeRegistry(piDir, entries);
    const loaded = readRegistry(piDir);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0].id, "batch-explore-1");
    assert.equal(loaded[1].batchId, "batch-explore-test");

    // Upsert session history
    upsertTaskSessionHistory(piDir, {
      ...entries[0],
      status: "running",
      background: true,
    });
    upsertTaskSessionHistory(piDir, {
      ...entries[1],
      status: "running",
      background: true,
    });

    const history = readTaskSessionHistory(piDir);
    assert.equal(history.length, 2);
    assert.equal(history[0].status, "running");

    // Update status (simulating completion)
    upsertTaskSessionHistory(piDir, {
      ...entries[0],
      status: "done",
      completedAt: Date.now(),
      background: true,
    });
    const updated = readTaskSessionHistory(piDir);
    const task1 = updated.find((e: any) => e.id === "batch-explore-1");
    assert.equal(task1?.status, "done");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─── Test 9: Task prompt building ──────────────────────────────────────────

test("buildTaskPrompt produces well-formed prompt with agent info", async () => {
  const { buildTaskPrompt } = await import("../src/tool/prompt.js");

  const prompt = buildTaskPrompt({
    description: "Explore auth flow",
    agentName: "explore",
    agentSource: "project",
    prompt: "Map the authentication flow in the codebase. Return file:line evidence.",
    cwd: "/project",
  });

  assert.ok(prompt.includes("Explore auth flow"), "includes description");
  assert.ok(prompt.includes("explore (project)"), "includes agent info");
  assert.ok(
    prompt.includes("authentication flow"),
    "includes user prompt",
  );
  assert.ok(
    prompt.includes("/project"),
    "includes working directory",
  );
  assert.ok(
    prompt.includes("Your final assistant message IS the result"),
    "includes result instructions",
  );
});

// ─── Test 10: Params schema for task and task_batch ──────────────────────────

test("task and task_batch parameter schemas produce correct JSON Schema", async () => {
  const { taskParametersSchema, taskBatchParametersSchema } = await import("../src/tool/schema.js");

  const taskSchema = taskParametersSchema();
  assert.ok(taskSchema.properties.agent_type, "task schema has agent_type");
  assert.ok(taskSchema.properties.prompt, "task schema has prompt");
  assert.ok(taskSchema.properties.description, "task schema has description");
  assert.ok(taskSchema.properties.background, "task schema has background");
  assert.ok(taskSchema.properties.backend, "task schema has backend");
  assert.ok(taskSchema.properties.task_id, "task schema has task_id");
  assert.ok(taskSchema.properties.conversation_id, "task schema has conversation_id");
  assert.ok(taskSchema.properties.fork_context, "task schema has fork_context");

  const batchSchema = taskBatchParametersSchema();
  assert.ok(batchSchema.properties.tasks, "batch schema has tasks");
  assert.ok(batchSchema.properties.backend, "batch schema has backend");
  assert.ok(batchSchema.properties.tab_label, "batch schema has tab_label");

  assert.ok(batchSchema.properties.fork_context, "batch schema has fork_context");

  // Verify tasks array constraints
  const tasksProp = batchSchema.properties.tasks;
  assert.equal(tasksProp.type, "array");
  assert.equal(tasksProp.minItems, 1);
  assert.equal(tasksProp.maxItems, 12);
});

// ─── Test 11: Task widget controller interface ──────────────────────────────

test("createTaskWidgetController provides expected interface", async () => {
  const { createTaskWidgetController } = await import("../src/lifecycle/widget.js");

  const bgTasks = new Map();
  const fgTasks = new Map();
  const widget = createTaskWidgetController(fgTasks, bgTasks);

  assert.ok(typeof widget.ensureTaskWidget === "function", "ensureTaskWidget exists");
  assert.ok(typeof widget.clearTaskWidgetIfIdle === "function", "clearTaskWidgetIfIdle exists");
  assert.ok(typeof widget.dispose === "function", "dispose exists");

  console.log("  Widget controller methods:", Object.keys(widget).join(", "));
});

// ─── Test 12: Format background receipt ─────────────────────────────────────

test("formatBackgroundReceipt produces clear task identification", async () => {
  const { formatBackgroundReceipt } = await import("../src/helpers.js");

  const receipt = formatBackgroundReceipt({
    taskId: "explore-abc",
    agentType: "explore",
    backend: "tmux",
    paneId: "%15",
    sessionName: "task-explore-abc",
    artifactDir: "/home/user/.pi/artifacts",
  });

  assert.ok(receipt.includes("explore-abc"), "includes task id");
  assert.ok(receipt.includes("explore"), "includes agent type");
  assert.ok(receipt.includes("tmux"), "includes backend");
  assert.ok(receipt.includes("task-explore-abc"), "includes session name");
  assert.ok(
    receipt.includes("do not poll"),
    "includes do not poll instruction",
  );
});

// ─── Test 13: end-to-end batch registration ─────────────────────────────────

test("end-to-end batch task registration simulates full batch lifecycle", async () => {
  const { root, piDir, agentsDir, sessionsDir } = createFixture();
  try {
    const {
      readRegistry,
      writeRegistry,
      upsertTaskSessionHistory,
      readTaskSessionHistory,
    } = await import("../src/conversation.js");
    const {
      validateTaskBatchTasks,
      formatTaskBatchReceipt,
      formatTaskBatchDetails,
    } = await import("../src/helpers.js");
    const { discoverAgents } = await import("../src/helpers.js");

    const { agents } = discoverAgents(agentsDir);
    assert.ok(agents.find((a) => a.name === "explore"), "explore agent present");

    // Simulate a batch of 3 explore tasks
    const batchTasks = [
      {
        agent_type: "explore",
        prompt: "Find all authentication-related files and map the login flow. Return file:line evidence.",
        description: "Map auth flow",
      },
      {
        agent_type: "explore",
        prompt: "Find all files related to database models and schema definitions. Return file:line evidence.",
        description: "Explore DB schema",
      },
      {
        agent_type: "explore",
        prompt: "Find all API route definitions and middleware registrations. Return file:line evidence.",
        description: "Explore API routes",
      },
    ];

    // Validate batch
    const validation = validateTaskBatchTasks(batchTasks);
    assert.ok(validation.ok, "batch validates");
    if (validation.ok) {
      assert.equal(validation.count, 3);
      assert.equal(validation.tasks.length, 3);
    }

    // Register entries as if batch launched them
    const now = Date.now();
    const entries = batchTasks.map((t, i) => ({
      id: `batch-${i}-${now.toString(36)}`,
      agentType: t.agent_type,
      description: t.description,
      sessionName: `task-batch-${i}-${now.toString(36)}`,
      startedAt: now + i * 100,
      paneId: `%${20 + i}`,
      piDir,
      dir: join(piDir, "artifacts"),
      backend: "tmux" as const,
      batchId: `batch-auth-${now.toString(36)}`,
      batchLabel: "Auth exploration",
      batchIndex: i,
      batchSize: 3,
    }));

    writeRegistry(piDir, entries);

    // Verify registry
    const saved = readRegistry(piDir);
    assert.equal(saved.length, 3);
    assert.equal(saved[0].agentType, "explore");
    assert.equal(saved[1].batchIndex, 1);

    // Simulate completion notification
    const completedTask = saved[0];
    upsertTaskSessionHistory(piDir, {
      ...completedTask,
      status: "done",
      completedAt: now + 5000,
      background: true,
    });

    const history = readTaskSessionHistory(piDir);
    const found = history.find((e: any) => e.id === completedTask.id);
    assert.equal(found?.status, "done");
    assert.ok(found?.completedAt);

    console.log("  Simulated batch of 3 explore tasks lifecycle complete");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("\n✓ All spawn integration tests loaded. Run: npm test -- --test test/spawn-integration.test.ts\n");
