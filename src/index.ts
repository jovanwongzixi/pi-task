/**
 * Task Tool — Delegate complex work to specialist agents.
 *
 * Spawns Pi CLI in a Herdr or tmux split pane (so you can watch it live) and
 * detects completion via RESULT.md polling. On completion, tool call
 * count and duration are reported as a notification.
 *
 * Three agent sources:
 *   - .pi/agents/*.md        project-local agents
 *   - ~/.pi/agent/agents/*.md user-global agents (fallback)
 *
 * P0: Persistent task registry (appendEntry + JSON), --session resume,
 *     sendMessage completion notification.
 * P1: Foreground mode (background:false, inline subprocess), pane death
 *     detection, 30-minute timeout.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { buildAgentToolSelection } from "./agent-tools.js";
import {
  normalizeConversationId,
  parseMetadataFromBody,
  readTaskBlock,
  readTaskSessionsRegistry,
  renderConversationSessions,
  writeConversationArtifacts,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  type ToolCallRecord,
  TASK_BACKGROUND_DEFAULT,
  TASK_BATCH_MAX_TASKS,
  TASK_BATCH_MIN_TASKS,
  TASK_BATCH_TOOL_DESCRIPTION,
  TASK_RESULT_XML_INSTRUCTIONS,
  TASK_TOOL_DESCRIPTION,
  formatBackgroundReceipt,
  formatTaskBatchDetails,
  formatTaskBatchReceipt,
  buildPiArgs,
  parseResultXml,
  formatMs,
  shellQuote,
  discoverAgents,
  formatAgentList,
  countToolUses,
  readRecentToolCalls,
  validateTaskBatchTasks,
  type AgentConfig,
  type TaskBatchStartedTask,
} from "./helpers.js";
import { runSdkSubagent } from "./subagent/runSdk.js";
import {
  type SubagentBackendName,
  type SubagentOutcome,
  type SubagentPaneBackend,
  selectSubagentBackend,
} from "./subagent/backend.js";
import { HerdrBackend } from "./subagent/herdr.js";
import { TmuxBackend } from "./subagent/tmux.js";
import {
  type TaskCompletionSnapshot,
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  renderTaskWidget,
  TASK_WIDGET_RENDER_MS,
  type ThemeLike,
} from "./task-widget.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BUNDLED_AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);
const BACKGROUND_CHECK_MS = 10_000; // poll every 10 sec
const COUNT_POLL_MS = 3_000; // update toolcall counts every 3 sec
const TASK_TIMEOUT_MS = 30 * 60 * 1_000; // 30 minutes
const MAX_POLL_ERRORS = 3; // consecutive poll failures before giving up on a task
const tmuxBackend = new TmuxBackend();
const herdrBackend = new HerdrBackend();
const paneBackends: readonly SubagentPaneBackend[] = [
  herdrBackend,
  tmuxBackend,
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface BackgroundTask {
  backend: SubagentBackendName;
  dir: string;
  agentType: string;
  sessionName: string;
  paneId?: string;
  originalPane: string | null;
  description: string;
  startedAt: number;
  toolUses: number;
  turns: number;
  conversationId?: string;
  batchId?: string;
  batchLabel?: string;
  batchIndex?: number;
  batchSize?: number;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** Consecutive completion-poll failures; reset to 0 on a successful poll. */
  pollErrors?: number;
  /** Guards backend lifecycle hooks against races between polling and aborts. */
  finalized?: boolean;
}

/** Serializable subset for active task registry persistence. */
interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  paneId?: string;
  piDir: string;
  dir: string;
  conversationId?: string;
  sessionRef?: string;
  backend?: SubagentBackendName;
  batchId?: string;
  batchLabel?: string;
  batchIndex?: number;
  batchSize?: number;
}

/** Durable task→session mapping used for resume after task completion. */
interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  completedAt?: number;
  background: boolean;
}

export /** Details attached to tool result for rendering. */
interface TaskDetails {
  task_id: string;
  agent_type: string;
  description: string;
  conversation_id?: string;
  phase: "done" | "timeout" | "cancelled" | "aborted" | "failed";
  // Completed phase
  status?: string;
  summary?: string;
  findings?: string;
  evidence?: string;
  confidence?: string;
  duration_ms?: number;
  turn_count?: number;
  tool_uses?: number;
  // Background
  background?: boolean;
  backend?: SubagentBackendName;
  pane_id?: string;
  session_name?: string;
  batch_id?: string;
  batch_label?: string;
  batch_index?: number;
  batch_size?: number;
  /** @deprecated Retained when reading older tool results. */
  tmux_session?: string;
}

// Conversation helpers live in ./conversation.js.

function readRegistry(piDir: string): RegistryEntry[] {
  const path = join(piDir, "task-registry.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function writeRegistry(piDir: string, entries: RegistryEntry[]): void {
  const path = join(piDir, "task-registry.json");
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf-8");
}

function readTaskSessionHistory(piDir: string): TaskSessionHistoryEntry[] {
  const path = join(piDir, "task-session-history.json");
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function writeTaskSessionHistory(
  piDir: string,
  entries: TaskSessionHistoryEntry[],
): void {
  const path = join(piDir, "task-session-history.json");
  writeFileSync(path, JSON.stringify(entries, null, 2), "utf-8");
}

function upsertTaskSessionHistory(
  piDir: string,
  entry: TaskSessionHistoryEntry,
): void {
  const entries = readTaskSessionHistory(piDir);
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) {
    entries[index] = { ...entries[index], ...entry };
  } else {
    entries.push(entry);
  }
  writeTaskSessionHistory(piDir, entries);
}

function findTaskSessionHistory(
  piDir: string,
  idOrSessionName: string,
): TaskSessionHistoryEntry | undefined {
  return readTaskSessionHistory(piDir).find(
    (entry) =>
      entry.id === idOrSessionName || entry.sessionName === idOrSessionName,
  );
}

function findJsonlSessionByName(
  piDir: string,
  sessionName: string,
  agentType: string,
): TaskSessionHistoryEntry | undefined {
  const artifactsDir = join(piDir, "artifacts");
  const sessionDir = join(artifactsDir, "sessions");
  try {
    if (!existsSync(sessionDir)) return undefined;
    const files = readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const file of files) {
      const content = readFileSync(join(sessionDir, file), "utf-8");
      let startedAt = Date.now();
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            name?: string;
            session_info?: { name?: string };
          };
          if (entry.type === "session" && entry.timestamp) {
            const parsed = Date.parse(entry.timestamp);
            if (Number.isFinite(parsed)) startedAt = parsed;
          }
          if (entry.type === "session_info") {
            const name = entry.name ?? entry.session_info?.name;
            if (name === sessionName) {
              return {
                id: sessionName,
                agentType,
                description: `Resumed session ${sessionName}`,
                sessionName,
                sessionRef: join(sessionDir, file),
                startedAt,
                piDir,
                dir: artifactsDir,
                status: "done",
                background: false,
              };
            }
            break;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function getPaneBackend(
  backend: SubagentBackendName | undefined,
): SubagentPaneBackend | undefined {
  if (backend === "herdr") return herdrBackend;
  if (backend === "tmux" || backend === undefined) return tmuxBackend;
  return undefined;
}

function registryPaneIsAlive(entry: RegistryEntry): boolean {
  if (!entry.paneId) return false;
  return getPaneBackend(entry.backend)?.exists(entry.paneId) ?? false;
}

type TaskTerminalPhase = "done" | "timeout" | "cancelled" | "failed";

function outcomeForPhase(phase: TaskTerminalPhase): SubagentOutcome {
  switch (phase) {
    case "done":
      return "completed";
    case "timeout":
      return "timeout";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function finalizeTaskPane(
  task: BackgroundTask,
  outcome: SubagentOutcome,
): void {
  if (task.backend === "sdk" || task.finalized) return;
  task.finalized = true;
  getPaneBackend(task.backend)?.finalize(
    task.paneId,
    task.originalPane,
    outcome,
  );
}

// ─── Process a completed task (sendMessage + registry cleanup) ──────────────

function completeTask(
  pi: ExtensionAPI,
  id: string,
  task: BackgroundTask,
  content: string,
  phase: TaskTerminalPhase,
  piDir: string,
  outcome: SubagentOutcome = outcomeForPhase(phase),
): void {
  finalizeTaskPane(task, outcome);

  const parsed = parseResultXml(content);
  const durationMs = Date.now() - task.startedAt;
  const completedSessionRef = findJsonlSessionByName(
    piDir,
    task.sessionName,
    task.agentType,
  )?.sessionRef;

  upsertTaskSessionHistory(piDir, {
    id,
    agentType: task.agentType,
    description: task.description,
    sessionName: task.sessionName,
    backend: task.backend,
    startedAt: task.startedAt,
    paneId: task.paneId,
    piDir,
    dir: task.dir,
    conversationId: task.conversationId,
    sessionRef: completedSessionRef,
    batchId: task.batchId,
    batchLabel: task.batchLabel,
    batchIndex: task.batchIndex,
    batchSize: task.batchSize,
    status: phase,
    completedAt: Date.now(),
    background: true,
  });

  // Send completion notification
  pi.sendMessage(
    {
      customType: "task-complete",
      content: `Background task ${id} (${task.agentType}) ${phase}.\n\nResult:\n${content}`,
      display: true,
      details: {
        task_id: id,
        agent_type: task.agentType,
        description: task.description,
        phase,
        status: phase,
        result: content,
        summary: parsed.summary,
        findings: parsed.findings,
        confidence: parsed.confidence,
        backend: task.backend,
        pane_id: task.paneId,
        session_name: task.sessionName,
        batch_id: task.batchId,
        batch_label: task.batchLabel,
        batch_index: task.batchIndex,
        batch_size: task.batchSize,
        duration_ms: durationMs,
        tool_uses: task.toolUses,
        turn_count: task.turns,
      },
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );

  // Remove from registry
  const entries = readRegistry(piDir).filter((e) => e.id !== id);
  writeRegistry(piDir, entries);
}

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Prevent recursive loading
  if (process.env.PI_TASK_TOOL_DISABLED === "1") return;

  // ── Background task tracker ────────────────────────────────────────────
  const backgroundTasks = new Map<string, BackgroundTask>();
  const foregroundTasks = new Map<string, BackgroundTask>();
  let widgetCtx: ExtensionContext | null = null;

  // ── Restore active tasks from registry on load ──────────────────────────
  const { piDir } = discoverAgents(process.cwd());
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];
  const restoredHerdrPanes: { paneId: string; startedAt: number }[] = [];
  for (const entry of registry) {
    // Only restore if artifact dir still exists
    if (!existsSync(entry.dir)) {
      staleIds.push(entry.id);
      continue;
    }

    const paneAlive = registryPaneIsAlive(entry);
    if (!paneAlive) {
      staleIds.push(entry.id);
      continue;
    }

    const bgtask: BackgroundTask = {
      backend: entry.backend ?? "tmux",
      dir: entry.dir,
      agentType: entry.agentType,
      sessionName: entry.sessionName,
      paneId: entry.paneId,
      originalPane: null,
      description: entry.description,
      startedAt: entry.startedAt,
      toolUses: 0,
      turns: 0,
      conversationId: entry.conversationId,
      batchId: entry.batchId,
      batchLabel: entry.batchLabel,
      batchIndex: entry.batchIndex,
      batchSize: entry.batchSize,
      recentCalls: [],
    };

    backgroundTasks.set(entry.id, bgtask);
    if (bgtask.backend === "herdr" && bgtask.paneId) {
      restoredHerdrPanes.push({
        paneId: bgtask.paneId,
        startedAt: bgtask.startedAt,
      });
    }
  }
  if (restoredHerdrPanes.length > 0) {
    getPaneBackend("herdr")?.adoptRestoredPanes?.(restoredHerdrPanes);
  }
  if (staleIds.length) {
    writeRegistry(
      piDir,
      registry.filter((e) => !staleIds.includes(e.id)),
    );
  }

  // ── Widget / timer setup ───────────────────────────────────────────────

  let widgetTimer: ReturnType<typeof setInterval> | null = null;
  function stopWidget() {
    if (widgetTimer) {
      clearInterval(widgetTimer);
      widgetTimer = null;
    }
  }

  const countInterval = setInterval(() => {
    for (const task of [
      ...foregroundTasks.values(),
      ...backgroundTasks.values(),
    ]) {
      const sessionDir = join(task.dir, "sessions");
      // Single walk: counts + recent tool-call history with status
      const { toolUses, turns, recent } = readRecentToolCalls(
        sessionDir,
        12,
        task.sessionName,
      );
      task.toolUses = toolUses;
      task.turns = turns;
      task.recentCalls = recent;
    }
  }, COUNT_POLL_MS);

  // Theme reference is captured at setWidget time so renderWidget can use it.
  let widgetTheme: ThemeLike | null = null;

  function renderWidget(width: number): string[] {
    // Defensive: never let a render exception kill the TUI. If anything
    // throws (theme lookup miss, malformed session JSONL, etc.), fall
    // back to a minimal single-line summary so the TUI stays alive.
    try {
      return renderTaskWidget({
        foregroundTasks: foregroundTasks.entries(),
        backgroundTasks: backgroundTasks.entries(),
        foregroundCount: foregroundTasks.size,
        backgroundCount: backgroundTasks.size,
        width,
        theme: widgetTheme,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const active = [
        ...Array.from(foregroundTasks.entries()),
        ...Array.from(backgroundTasks.entries()),
      ];
      if (active.length === 0) return [];
      const [, task] = active[0];
      return [
        truncateToWidth(
          `${task.agentType}  \u2022 ${formatMs(Date.now() - task.startedAt)}  (render error: ${msg})`,
          Math.min(width, 120),
        ),
      ];
    }
  }

  function ensureTaskWidget(targetCtx: ExtensionContext): void {
    if (widgetCtx || targetCtx.mode !== "tui") return;
    widgetCtx = targetCtx;
    targetCtx.ui.setWidget("task", (tui, theme) => {
      widgetTheme = theme ?? null;
      widgetTimer = setInterval(
        () => tui.requestRender(),
        TASK_WIDGET_RENDER_MS,
      );
      // Don't keep the process alive just for the widget refresh.
      widgetTimer.unref?.();
      return {
        render: (width: number) => renderWidget(width),
        invalidate: () => {},
        dispose: () => {
          widgetTheme = null;
          stopWidget();
        },
      };
    });
  }

  function clearTaskWidgetIfIdle(): void {
    if (foregroundTasks.size > 0 || backgroundTasks.size > 0) return;
    stopWidget();
    if (widgetCtx) {
      widgetCtx.ui.setWidget("task", undefined);
      widgetCtx = null;
    }
  }

  // ── Polling loop (background task completion, pane death, timeout) ──────

  // setInterval does not wait for an async callback to settle, so a slow pass
  // (many tasks / slow fs) could overlap the next one and double-complete a
  // task. This guard makes ticks that fire mid-pass no-ops.
  let checkInFlight = false;

  const checkInterval = setInterval(async () => {
    if (checkInFlight) return;
    if (backgroundTasks.size === 0) {
      clearTaskWidgetIfIdle();
      return;
    }
    checkInFlight = true;

    try {
      const now = Date.now();
      const ids = Array.from(backgroundTasks.keys());

      for (const id of ids) {
        const task = backgroundTasks.get(id);
        if (!task) continue;

        // ── Check timeout ────────────────────────────────────────────
        if (now - task.startedAt > TASK_TIMEOUT_MS) {
          backgroundTasks.delete(id);
          clearTaskWidgetIfIdle();
          completeTask(
            pi,
            id,
            task,
            "Task timed out after 30 minutes",
            "timeout",
            piDir,
          );
          continue;
        }

        // SDK tasks complete through their in-process promise below. They stay
        // in this map for widget/timeout tracking, but have no pane to poll.
        if (task.backend === "sdk") continue;

        // A transient fs error here (RESULT.md mid-write, EACCES, dir briefly
        // missing) must NOT drop the task. Keep it tracked and retry on the
        // next tick; only give up after repeated failures (the timeout above
        // is the ultimate backstop).
        let snapshot: TaskCompletionSnapshot;
        try {
          snapshot = await checkTaskCompletion({
            resultPath: join(task.dir, "RESULT.md"),
            sessionDir: join(task.dir, "sessions"),
            sessionName: task.sessionName,
            paneId: task.paneId,
            paneExists: (candidatePaneId) =>
              getPaneBackend(task.backend)?.exists(candidatePaneId) ?? false,
            sinceMs: task.startedAt,
          });
        } catch (err) {
          task.pollErrors = (task.pollErrors ?? 0) + 1;
          if (task.pollErrors >= MAX_POLL_ERRORS) {
            backgroundTasks.delete(id);
            clearTaskWidgetIfIdle();
            const message = err instanceof Error ? err.message : String(err);
            completeTask(
              pi,
              id,
              task,
              `Task ${id} polling failed ${task.pollErrors}x; last error: ${message}`,
              "failed",
              piDir,
              "tracking-error",
            );
          }
          // Otherwise leave the task tracked and retry next tick.
          continue;
        }

        // Successful poll clears the error streak.
        task.pollErrors = 0;

        if (snapshot.status === "running") {
          continue;
        }

        const phase = snapshot.status === "completed" ? "done" : "failed";
        backgroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        completeTask(pi, id, task, snapshot.content, phase, piDir);
      }
    } finally {
      checkInFlight = false;
    }
  }, BACKGROUND_CHECK_MS);

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    clearInterval(checkInterval);
    clearInterval(countInterval);
    stopWidget();
    if (widgetCtx) {
      widgetCtx.ui.setWidget("task", undefined);
      widgetCtx = null;
    }
  });

  // ── Custom notification renderer ───────────────────────────────────────

  pi.registerMessageRenderer?.(
    "task-complete",
    (message, { expanded }, theme) => {
      const d = message.details as Record<string, unknown> | undefined;
      if (!d) return undefined;

      const agentType = (d.agent_type as string) || "";
      const desc = (d.description as string) || "";
      const summary = (d.summary as string) || "";
      const findings = (d.findings as string) || "";
      const confidence = (d.confidence as string) || "";
      const durationMs = (d.duration_ms as number) || 0;
      const toolUses = (d.tool_uses as number) || 0;

      let line = " " + theme.fg("accent", agentType);
      if (desc) line += theme.fg("dim", ` - ${desc}`);

      const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
      const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
      const statsParts = [useStr, durStr].filter(Boolean);
      const statsText = statsParts.join(" • ");
      const confStr = confidence ? confidence.toUpperCase() : "";
      const confColor =
        confidence === "high"
          ? "success"
          : confidence === "low"
            ? "error"
            : "accent";

      if (statsText || confStr) {
        line += "\n ";
        if (confStr) line += theme.fg(confColor as any, `[${confStr}]`);
        if (statsText)
          line += (confStr ? " " : "") + theme.fg("dim", statsText);
      }

      if (expanded) {
        if (summary) line += "\n " + theme.fg("muted", summary);
        if (findings) line += "\n " + theme.fg("dim", findings);
      }

      if (!line.trim()) return undefined;
      const subtleBg = (text: string) => `\x1b[48;2;30;28;44m${text}\x1b[0m`;
      return new Text(line, 0, 1, subtleBg);
    },
  );

  interface PreparedBatchTask {
    id: string;
    agent: AgentConfig;
    agentType: string;
    prompt: string;
    description: string;
    sessionName: string;
    promptContent: string;
    shellCommand: string;
    runSdk: () => Promise<{ output: string; sessionPath?: string }>;
  }

  interface RegisteredBatchTaskInput {
    prepared: PreparedBatchTask;
    backend: SubagentBackendName;
    paneId?: string;
    originalPane: string | null;
    piDir: string;
    artifactsDir: string;
    batchId: string;
    batchLabel?: string;
    batchIndex: number;
    batchSize: number;
  }

  function newTaskId(): string {
    return `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
  }

  function buildTaskPromptContent(input: {
    agent: AgentConfig;
    prompt: string;
    description: string;
    cwd: string;
  }): string {
    return [
      `# Task: ${input.description}`,
      "",
      `## Agent`,
      `${input.agent.name} (${input.agent.source})`,
      "",
      `## Instructions`,
      input.prompt,
      "",
      `## Working Directory`,
      input.cwd,
      "",
      `## Output`,
      "Your final assistant message is the result. End with a clear summary of what you did and any findings. No file write is required.",
      "",
      "Use this format for the summary:",
      "",
      "```",
      TASK_RESULT_XML_INSTRUCTIONS,
      "```",
    ].join("\n");
  }

  async function prepareBatchTask(input: {
    agent: AgentConfig;
    prompt: string;
    description: string;
    cwd: string;
    artifactsDir: string;
    sessionDir: string;
    parentToolNames: string[];
    ctx: ExtensionContext;
  }): Promise<PreparedBatchTask> {
    const id = newTaskId();
    const sessionName = `task-${id}`;
    const promptContent = buildTaskPromptContent({
      agent: input.agent,
      prompt: input.prompt,
      description: input.description,
      cwd: input.cwd,
    });
    const piArgs = buildPiArgs(
      input.agent,
      sessionName,
      input.sessionDir,
      promptContent,
      false,
      input.parentToolNames,
    );
    const shellCommand = `PI_TASK_TOOL_DISABLED=1 pi ${piArgs.map((a) => shellQuote(a)).join(" ")}`;
    const toolSelection = buildAgentToolSelection({
      tools: input.agent.tools,
      disallowedTools: input.agent.disallowedTools,
      parentToolNames: input.parentToolNames,
    });
    const runSdk = () =>
      runSdkSubagent({
        prompt: promptContent,
        agent: input.agent,
        cwd: input.cwd,
        ctx: input.ctx,
        model: input.agent.model,
        thinkingLevel: input.agent.thinking,
        tools: toolSelection.tools,
        excludeTools: toolSelection.excludeTools,
        systemPrompt: input.agent.body,
      });

    return {
      id,
      agent: input.agent,
      agentType: input.agent.name,
      prompt: input.prompt,
      description: input.description,
      sessionName,
      promptContent,
      shellCommand,
      runSdk,
    };
  }

  function registerBackgroundBatchTask(input: RegisteredBatchTaskInput): {
    task: BackgroundTask;
    entry: RegistryEntry;
    started: TaskBatchStartedTask;
  } {
    const startedAt = Date.now();
    const task: BackgroundTask = {
      backend: input.backend,
      dir: input.artifactsDir,
      agentType: input.prepared.agentType,
      sessionName: input.prepared.sessionName,
      paneId: input.paneId,
      originalPane: input.originalPane,
      description: input.prepared.description,
      startedAt,
      toolUses: 0,
      turns: 0,
      recentCalls: [],
      batchId: input.batchId,
      batchLabel: input.batchLabel,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
    };
    backgroundTasks.set(input.prepared.id, task);

    const entry: RegistryEntry = {
      id: input.prepared.id,
      agentType: input.prepared.agentType,
      description: input.prepared.description,
      sessionName: input.prepared.sessionName,
      startedAt,
      paneId: input.paneId,
      piDir: input.piDir,
      dir: input.artifactsDir,
      backend: input.backend,
      batchId: input.batchId,
      batchLabel: input.batchLabel,
      batchIndex: input.batchIndex,
      batchSize: input.batchSize,
    };

    const entries = readRegistry(input.piDir);
    entries.push(entry);
    writeRegistry(input.piDir, entries);
    upsertTaskSessionHistory(input.piDir, {
      ...entry,
      status: "running",
      background: true,
    });
    pi.appendEntry("task-registry", entry);

    return {
      task,
      entry,
      started: {
        taskId: input.prepared.id,
        agentType: input.prepared.agentType,
        description: input.prepared.description,
        backend: input.backend,
        paneId: input.paneId,
        sessionName: input.prepared.sessionName,
        artifactDir: input.artifactsDir,
      },
    };
  }

  function attachBackgroundAbort(
    signal: AbortSignal | undefined,
    id: string,
    task: BackgroundTask,
    entry: RegistryEntry,
    taskPiDir: string,
  ): void {
    if (!signal) return;
    signal.addEventListener(
      "abort",
      () => {
        if (!backgroundTasks.delete(id)) return;
        finalizeTaskPane(task, "cancelled");
        clearTaskWidgetIfIdle();
        const remaining = readRegistry(taskPiDir).filter((e) => e.id !== id);
        writeRegistry(taskPiDir, remaining);
        upsertTaskSessionHistory(taskPiDir, {
          ...entry,
          status: "cancelled",
          completedAt: Date.now(),
          background: true,
        });
        if (backgroundTasks.size === 0) {
          stopWidget();
          if (widgetCtx) {
            widgetCtx.ui.setWidget("task", undefined);
            widgetCtx = null;
          }
        }
      },
      { once: true },
    );
  }

  function startSdkBackgroundTask(
    prepared: PreparedBatchTask,
    registered: { task: BackgroundTask },
    taskPiDir: string,
  ): void {
    void prepared
      .runSdk()
      .then(async ({ output }) => {
        if (!backgroundTasks.delete(prepared.id)) return;
        const finalOutput =
          output || "SDK subagent completed without assistant text.";
        clearTaskWidgetIfIdle();
        completeTask(
          pi,
          prepared.id,
          registered.task,
          finalOutput,
          "done",
          taskPiDir,
        );
      })
      .catch((error) => {
        if (!backgroundTasks.delete(prepared.id)) return;
        const message = error instanceof Error ? error.message : String(error);
        clearTaskWidgetIfIdle();
        completeTask(
          pi,
          prepared.id,
          registered.task,
          `Task ${prepared.id} failed: ${message}`,
          "failed",
          taskPiDir,
        );
      });
  }

  // ── Tool Registration ──────────────────────────────────────────────────

  pi.registerTool({
    name: "task",
    label: "Task",
    description: TASK_TOOL_DESCRIPTION,
    promptSnippet: "Delegate work to a specialist agent via the task tool",
    promptGuidelines: [
      "Delegate complex multi-step work to a specialist agent when the work benefits from isolated context",
      "Launch multiple agents concurrently by making multiple tool calls in a single message",
      "Do NOT duplicate work you've delegated — wait for the result or work on non-overlapping tasks",
      "Use agent_type to route to the right specialist",
      "Tell the agent whether to write code or just research",
      "For background tasks: DO NOT sleep, poll, or check on progress. You'll be notified",
      "After delegated work completes, read changed files, review diff, verify scope, and run relevant checks",
      "Send the user a concise summary of the result since the agent's output is not user-visible",
    ],
    parameters: Type.Object({
      agent_type: Type.String({
        description: "The type of specialist agent to use for this task",
      }),
      prompt: Type.String({
        description:
          "The complete task for the agent to perform. Be detailed and self-contained.",
      }),
      description: Type.String({
        description: "A short (3-5 word) summary of the task",
      }),
      task_id: Type.Optional(
        Type.String({
          description:
            "Resume an existing background task by id instead of starting a new task.",
        }),
      ),
      conversation_id: Type.Optional(
        Type.String({
          description:
            "Durable specialist conversation id. Reuses .pi/artifacts/task-<id>/sessions when called again.",
        }),
      ),

      background: Type.Optional(
        Type.Boolean({
          description:
            "Run in background (async). You will be notified when it completes. DO NOT sleep, poll, ask the task for status, or duplicate its work while it runs in background.",
          default: true,
        }),
      ),
      backend: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("herdr"),
            Type.Literal("tmux"),
            Type.Literal("sdk"),
          ],
          {
            description:
              "Execution backend. auto prefers herdr inside Herdr, then tmux, then SDK.",
            default: "auto",
          },
        ),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const { agents, piDir } = discoverAgents(ctx.cwd, BUNDLED_AGENT_DIR);
      const parentToolNames = pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter(Boolean);
      const agent = agents.find((a) => a.name === params.agent_type);

      if (!agent) {
        const list = formatAgentList(agents);
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown agent: "${params.agent_type}".\nAvailable agents:\n${list}`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: `Unknown agent: ${params.agent_type}`,
          },
          isError: true,
        };
      }

      // ── Resolve task identity: new, task resume, or conversation resume ──
      const conversationId = normalizeConversationId(params.conversation_id);
      const taskSessionsRegistry = conversationId
        ? readTaskSessionsRegistry(piDir)
        : {};
      const registeredTaskId = conversationId
        ? taskSessionsRegistry[conversationId]?.task_id
        : undefined;

      if (
        params.task_id &&
        registeredTaskId &&
        params.task_id !== registeredTaskId
      ) {
        return {
          content: [
            {
              type: "text" as const,
              text: `conversation_id "${conversationId}" maps to ${registeredTaskId}, not ${params.task_id}. Omit task_id or use the mapped task id.`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: "conversation_id/task_id mismatch",
          },
          isError: true,
        };
      }

      let id: string;
      let sessionName: string;
      let resultPath: string;
      let resume = false;
      let resumeSessionRef: string | undefined;

      const artifactsDir = join(piDir, "artifacts");

      if (registeredTaskId) {
        id = registeredTaskId;
        sessionName = conversationId ?? `task-${id}`;
        resultPath = join(artifactsDir, `RESULT-${id}.md`);
        if (!existsSync(resultPath)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `conversation_id "${conversationId}" has no prior result file at ${resultPath}. Cannot resume.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Conversation result missing",
              conversation_id: conversationId,
            },
            isError: true,
          };
        }
        const block = readTaskBlock(piDir, id);
        const previousMetadata = parseMetadataFromBody(block?.body);
        const metadataAgent = previousMetadata?.agent_type;
        if (metadataAgent && metadataAgent !== agent.name) {
          return {
            content: [
              {
                type: "text" as const,
                text: `conversation_id "${conversationId}" belongs to agent "${metadataAgent}", not "${agent.name}". Use the original agent_type or start a different conversation_id.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "conversation_id agent_type mismatch",
              conversation_id: conversationId,
            },
            isError: true,
          };
        }
        resume = true;

        const entry = readRegistry(piDir).find(
          (candidate) => candidate.id === id,
        );
        if (
          params.background !== false &&
          entry?.paneId &&
          registryPaneIsAlive(entry)
        ) {
          const bgtask: BackgroundTask = {
            backend: entry.backend ?? "tmux",
            dir: artifactsDir,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.paneId,
            originalPane: null,
            description: params.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed conversation "${conversationId}" via ${sessionName}. The subagent is running in background and will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: agent.name,
              description: params.description,
              conversation_id: conversationId,
              backend: entry.backend ?? "tmux",
              pane_id: entry.paneId,
              session_name: sessionName,
              background: true,
            },
          };
        }
      } else if (params.task_id) {
        // Look up active tasks first, then durable completed-session history.
        const entries = readRegistry(piDir);
        let entry =
          entries.find(
            (e) => e.id === params.task_id || e.sessionName === params.task_id,
          ) ??
          findTaskSessionHistory(piDir, params.task_id) ??
          findJsonlSessionByName(piDir, params.task_id, agent.name);

        // Older history entries were written before we stored the
        // actual JSONL path needed by `pi --session`. Repair them by
        // resolving the display session name to a session file.
        if (entry && !entry.sessionRef) {
          const discovered = findJsonlSessionByName(
            piDir,
            entry.sessionName,
            entry.agentType,
          );
          if (discovered?.sessionRef) {
            entry = { ...entry, sessionRef: discovered.sessionRef };
            upsertTaskSessionHistory(piDir, {
              ...entry,
              status: "done",
              background: false,
            });
          }
        }
        if (!entry) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown task_id: "${params.task_id}". No active or completed task session with that ID/session name was found.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: `Unknown task_id: ${params.task_id}`,
            },
            isError: true,
          };
        }
        if (!existsSync(entry.dir)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${params.task_id}" artifact directory no longer exists: ${entry.dir}`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task artifact dir missing",
            },
            isError: true,
          };
        }
        // Resume: reuse the existing session name; runtime files are
        // flat in artifactsDir, no per-task subdir.
        id = entry.id;
        sessionName = entry.sessionName;
        resultPath = join(artifactsDir, `RESULT-${id}.md`);
        resume = true;
        resumeSessionRef = entry.sessionRef;

        // If background and pane still alive, reattach to tracker
        if (
          params.background !== false &&
          entry.paneId &&
          registryPaneIsAlive(entry)
        ) {
          const bgtask: BackgroundTask = {
            backend: entry.backend ?? "tmux",
            dir: artifactsDir,
            agentType: entry.agentType,
            sessionName,
            paneId: entry.paneId,
            originalPane: null,
            description: params.description || entry.description,
            startedAt: entry.startedAt,
            toolUses: 0,
            turns: 0,
            conversationId: entry.conversationId,
            recentCalls: [],
          };
          backgroundTasks.set(id, bgtask);

          return {
            content: [
              {
                type: "text" as const,
                text: `Resumed task "${params.task_id}". The subagent is running in background and will notify on completion.`,
              },
            ],
            details: {
              task_id: id,
              agent_type: entry.agentType,
              description: params.description || entry.description,
              conversation_id: entry.conversationId ?? conversationId,
              backend: entry.backend ?? "tmux",
              pane_id: entry.paneId,
              session_name: sessionName,
              background: true,
            },
          };
        }

        if (!resumeSessionRef) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Task "${params.task_id}" was found, but its session JSONL file could not be resolved. Cannot resume without a --session file path.`,
              },
            ],
            details: {
              phase: "failed" as const,
              error: "Task session file missing",
            },
            isError: true,
          };
        }
      } else {
        id = `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
        sessionName = conversationId ?? `task-${id}`;
        resultPath = join(artifactsDir, `RESULT-${id}.md`);
      }

      let backendSelection;
      try {
        backendSelection = selectSubagentBackend(
          params.backend ?? "auto",
          paneBackends,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            phase: "failed" as const,
            error: message,
          },
          isError: true,
        };
      }

      if ((conversationId || resume) && backendSelection.name === "sdk") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Resuming saved sessions requires the herdr or tmux CLI backend so Pi can reopen the subagent session. Select an available pane backend, or use SDK only for a new one-shot task.",
            },
          ],
          details: {
            phase: "failed" as const,
            error: "CLI pane backend required for session resume",
            conversation_id: conversationId,
          },
          isError: true,
        };
      }

      if (conversationId) {
        await mkdir(artifactsDir, { recursive: true });
        const taskSessionsRegistry = readTaskSessionsRegistry(piDir);
        taskSessionsRegistry[conversationId] = {
          task_id: id,
          session_file: `${artifactsDir}/${id}`,
        };
        writeTaskSessionsRegistry(piDir, taskSessionsRegistry);
      }

      const descText = params.description || "";
      const isBackground = params.background ?? TASK_BACKGROUND_DEFAULT;
      // default true

      // ── Build the prompt (instructions are inlined; no CONTEXT.md file) ─
      const promptContent = [
        `# Task: ${descText}`,
        "",
        `## Agent`,
        `${agent.name} (${agent.source})`,
        "",
        `## Instructions`,
        params.prompt,
        "",
        `## Working Directory`,
        ctx.cwd,
        "",
        `## Output`,
        "Your final assistant message is the result. End with a clear summary of what you did and any findings. No file write is required.",
        "",
        "Use this format for the summary:",
        "",
        "```",
        TASK_RESULT_XML_INSTRUCTIONS,
        "```",
      ].join("\n");

      const sessionDir = join(artifactsDir, "sessions");
      await mkdir(sessionDir, { recursive: true });

      // ─── Build and run the sub-agent pi process ──────────────────────────
      const piArgs = buildPiArgs(
        agent,
        sessionName,
        sessionDir,
        promptContent,
        resume,
        parentToolNames,
        resumeSessionRef,
      );
      const envPrefix = `PI_TASK_TOOL_DISABLED=1`;
      const toolSelection = buildAgentToolSelection({
        tools: agent.tools,
        disallowedTools: agent.disallowedTools,
        parentToolNames,
      });
      const runSdkFallback = async () =>
        runSdkSubagent({
          prompt: promptContent,
          agent,
          cwd: ctx.cwd,
          ctx,
          model: agent.model,
          thinkingLevel: agent.thinking,
          tools: toolSelection.tools,
          excludeTools: toolSelection.excludeTools,
          systemPrompt: agent.body,
        });
      const foregroundTask: BackgroundTask | undefined = isBackground
        ? undefined
        : {
            backend: backendSelection.name,
            dir: artifactsDir,
            agentType: agent.name,
            sessionName,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            conversationId,
            recentCalls: [],
          };

      if (foregroundTask) {
        foregroundTasks.set(id, foregroundTask);
        ensureTaskWidget(ctx);
      }

      if (backendSelection.name === "sdk") {
        if (isBackground) {
          const bgtask: BackgroundTask = {
            backend: "sdk",
            dir: artifactsDir,
            agentType: agent.name,
            sessionName,
            originalPane: null,
            description: descText,
            startedAt: Date.now(),
            toolUses: 0,
            turns: 0,
            conversationId,
            recentCalls: [],
          };

          backgroundTasks.set(id, bgtask);
          const entry: RegistryEntry = {
            id,
            agentType: agent.name,
            description: descText,
            sessionName,
            startedAt: bgtask.startedAt,
            piDir,
            dir: artifactsDir,
            conversationId,
            backend: "sdk",
          };

          const entries = readRegistry(piDir);
          entries.push(entry);
          writeRegistry(piDir, entries);
          upsertTaskSessionHistory(piDir, {
            ...entry,
            status: "running",
            background: true,
          });
          pi.appendEntry("task-registry", entry);
          ensureTaskWidget(ctx);

          void runSdkFallback()
            .then(async ({ output }) => {
              if (!backgroundTasks.delete(id)) return;
              const finalOutput =
                output || "SDK subagent completed without assistant text.";
              clearTaskWidgetIfIdle();
              completeTask(pi, id, bgtask, finalOutput, "done", piDir);
            })
            .catch((error) => {
              if (!backgroundTasks.delete(id)) return;
              const message =
                error instanceof Error ? error.message : String(error);
              clearTaskWidgetIfIdle();
              completeTask(
                pi,
                id,
                bgtask,
                `Task ${id} failed: ${message}`,
                "failed",
                piDir,
              );
            });

          return {
            content: [
              {
                type: "text" as const,
                text: formatBackgroundReceipt({
                  taskId: id,
                  agentType: agent.name,
                  backend: "sdk",
                  sessionName,
                  artifactDir: artifactsDir,
                }),
              },
            ],
            details: {
              task_id: id,
              agent_type: agent.name,
              description: descText,
              background: true,
              backend: "sdk" as const,
              session_name: sessionName,
              result_path: resultPath,
              conversation_id: conversationId,
            },
          };
        }

        try {
          const { output, sessionPath } = await runSdkFallback();
          const finalOutput =
            output || "SDK subagent completed without assistant text.";
          if (conversationId) {
            writeConversationArtifacts({
              piDir,
              taskId: id,
              conversationId,
              agentType: agent.name,
              sessionFile: sessionPath ?? "unknown",
              prompt: params.prompt,
              result: finalOutput,
            });
          }
          return {
            content: [{ type: "text" as const, text: finalOutput }],
            details: {
              phase: "done" as const,
              backend: "sdk" as const,
              session_path: sessionPath,
              result_path: resultPath,
              conversation_id: conversationId,
            },
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              { type: "text" as const, text: `SDK task failed: ${message}` },
            ],
            details: {
              phase: "failed" as const,
              backend: "sdk" as const,
              error: message,
            },
            isError: true,
          };
        } finally {
          foregroundTasks.delete(id);
          clearTaskWidgetIfIdle();
        }
      }

      const shellCommand = `${envPrefix} pi ${piArgs.map((a) => shellQuote(a)).join(" ")}`;
      const paneBackend = backendSelection.paneBackend;
      if (!paneBackend) {
        throw new Error(`Missing pane backend for ${backendSelection.name}.`);
      }

      let paneId: string;
      let originalPane: string | null;
      try {
        const splitResult = paneBackend.spawn({
          cwd: ctx.cwd,
          command: shellCommand,
          description: descText,
          agentType: agent.name,
        });
        paneId = splitResult.paneId;
        originalPane = splitResult.originalPane;
        if (foregroundTask) {
          foregroundTask.paneId = paneId;
          foregroundTask.originalPane = originalPane;
        }
      } catch (error) {
        paneBackend.rollbackSpawn();
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to create ${backendSelection.name} pane for the agent: ${message}`,
            },
          ],
          details: { phase: "failed" as const, error: message },
          isError: true,
        };
      }

      // ── FOREGROUND MODE: block until result, return directly ────────────
      if (!isBackground) {
        const startedAt = foregroundTask?.startedAt ?? Date.now();
        upsertTaskSessionHistory(piDir, {
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          backend: backendSelection.name,
          startedAt,
          paneId,
          piDir,
          dir: artifactsDir,
          conversationId,
          status: "running",
          background: false,
        });

        const completion = await waitForSessionTaskCompletion({
          resultPath,
          sessionDir,
          sessionName,
          paneId,
          paneExists: (candidatePaneId) =>
            paneBackend.exists(candidatePaneId),
          signal,
          timeoutMs: TASK_TIMEOUT_MS,
          pollMs: 1000,
          sinceMs: startedAt,
        });
        const content = completion.content;
        const phase: TaskTerminalPhase =
          completion.status === "completed"
            ? "done"
            : completion.status === "timeout"
              ? "timeout"
              : completion.status === "cancelled"
                ? "cancelled"
                : "failed";
        const outcome: SubagentOutcome =
          completion.status === "completed"
            ? "completed"
            : completion.status === "timeout"
              ? "timeout"
              : completion.status === "cancelled"
                ? "cancelled"
                : "failed";
        const completedSessionRef = findJsonlSessionByName(
          piDir,
          sessionName,
          agent.name,
        )?.sessionRef;
        upsertTaskSessionHistory(piDir, {
          id,
          agentType: agent.name,
          description: descText,
          sessionName,
          backend: backendSelection.name,
          startedAt,
          paneId,
          piDir,
          dir: artifactsDir,
          conversationId,
          sessionRef: completedSessionRef,
          status: phase,
          completedAt: Date.now(),
          background: false,
        });
        if (foregroundTask) {
          finalizeTaskPane(foregroundTask, outcome);
        } else {
          paneBackend.finalize(paneId, originalPane, outcome);
        }
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();

        if (conversationId) {
          writeConversationArtifacts({
            piDir,
            taskId: id,
            conversationId,
            agentType: agent.name,
            sessionFile: `${sessionDir}/${sessionName}`,
            prompt: params.prompt,
            result: content,
          });
        }

        const parsed = parseResultXml(content);
        const durationMs = Date.now() - startedAt;
        const { toolUses, turns } = countToolUses(sessionDir, sessionName);

        return {
          content: [
            {
              type: "text" as const,
              text: [
                `${parsed.status || "done"}: ${parsed.summary || content.slice(0, 300)}`,
                toolUses > 0 ? `\n${toolUses} toolcalls` : "",
                durationMs >= 1000 ? `\n${formatMs(durationMs)}` : "",
              ]
                .filter(Boolean)
                .join(""),
            },
          ],
          details: {
            task_id: id,
            agent_type: agent.name,
            description: descText,
            phase,
            status: phase === "done" ? parsed.status || "done" : phase,
            summary: parsed.summary || "",
            findings: parsed.findings || "",
            evidence: parsed.evidence || "",
            confidence: parsed.confidence || "",
            duration_ms: durationMs,
            tool_uses: toolUses,
            turn_count: turns,
            background: false,
            backend: backendSelection.name,
            pane_id: paneId,
            session_name: sessionName,
            conversation_id: conversationId,
          },
        };
      }

      // ── BACKGROUND MODE (default): add to tracker, return immediately ─────

      const bgtask: BackgroundTask = {
        backend: backendSelection.name,
        dir: artifactsDir,
        agentType: agent.name,
        sessionName,
        paneId,
        originalPane,
        description: descText,
        startedAt: Date.now(),
        toolUses: 0,
        turns: 0,
        conversationId,
        recentCalls: [],
      };

      backgroundTasks.set(id, bgtask);

      // ── P0: Persistent registry ────────────────────────────────────────
      const entry: RegistryEntry = {
        id,
        agentType: agent.name,
        description: descText,
        sessionName,
        startedAt: bgtask.startedAt,
        paneId,
        piDir,
        dir: artifactsDir,
        conversationId,
        backend: backendSelection.name,
      };

      // Write to JSON registry for on-load restore
      const entries = readRegistry(piDir);
      entries.push(entry);
      writeRegistry(piDir, entries);
      upsertTaskSessionHistory(piDir, {
        ...entry,
        status: "running",
        background: true,
      });
      // Also persist to session store via appendEntry (audit trail)
      pi.appendEntry("task-registry", entry);

      // ── Abort signal handling ──────────────────────────────────────────
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            if (!backgroundTasks.delete(id)) return;
            finalizeTaskPane(bgtask, "cancelled");
            clearTaskWidgetIfIdle();
            // Clean registry
            const remaining = readRegistry(piDir).filter((e) => e.id !== id);
            writeRegistry(piDir, remaining);
            upsertTaskSessionHistory(piDir, {
              ...entry,
              status: "cancelled",
              completedAt: Date.now(),
              background: true,
            });
            if (backgroundTasks.size === 0) {
              stopWidget();
              if (widgetCtx) {
                widgetCtx.ui.setWidget("task", undefined);
                widgetCtx = null;
              }
            }
          },
          { once: true },
        );
      }

      // ── Sticky widget ──────────────────────────────────────────────────
      ensureTaskWidget(ctx);

      return {
        content: [
          {
            type: "text" as const,
            text: formatBackgroundReceipt({
              taskId: id,
              agentType: agent.name,
              backend: backendSelection.name,
              paneId,
              sessionName,
              artifactDir: artifactsDir,
            }),
          },
        ],
        details: {
          task_id: id,
          agent_type: agent.name,
          description: descText,
          backend: backendSelection.name,
          pane_id: paneId,
          session_name: sessionName,
          background: true,
        },
      };
    },

    renderCall(args, theme, _context) {
      const agentName =
        ((args as Record<string, unknown>).agent_type as string) || "...";
      const desc =
        ((args as Record<string, unknown>).description as string) || "";

      let text = theme.fg("toolTitle", "");
      text += theme.fg("accent", agentName);
      if (desc) text += theme.fg("dim", ` - ${desc}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme, _context) {
      const d = result.details as TaskDetails | undefined;
      if (!d) return new Text("", 0, 0);

      if (d.background) {
        const toolUses = d.tool_uses || 0;
        const durationMs = d.duration_ms || 0;
        const confidence = d.confidence || "";

        const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
        const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
        const statsParts = [useStr, durStr].filter(Boolean);
        const statsText = statsParts.join(" \u2022 ");
        const confStr = confidence ? `[${confidence.toUpperCase()}]` : "";
        const statsLine = [confStr, statsText].filter(Boolean).join(" ");

        const subtleBg = (text: string) => `\x1b[48;2;30;28;44m${text}\x1b[0m`;
        return new Text(
          statsLine ? " " + theme.fg("dim", statsLine.trim()) : "",
          0,
          0,
          subtleBg,
        );
      }

      if (
        d.phase === "timeout" ||
        d.phase === "cancelled" ||
        d.phase === "aborted" ||
        d.phase === "failed"
      ) {
        const line =
          theme.fg("error", "x") + " " + theme.fg("dim", `[${d.phase}]`);
        return new Text(line, 0, 0);
      }

      const isError =
        d.status === "failure" ||
        d.status === "blocked" ||
        d.status === "unknown" ||
        d.status === "timeout" ||
        d.status === "cancelled" ||
        d.status === "failed";

      const durationMs = d.duration_ms || 0;
      const toolUses = d.tool_uses || 0;

      const useStr = toolUses > 0 ? `${toolUses} toolcalls` : "";
      const durStr = durationMs >= 1000 ? formatMs(durationMs) : "";
      const statsParts = [useStr, durStr].filter(Boolean);
      const statsStr = statsParts.length
        ? " " + theme.fg("dim", statsParts.join(" • "))
        : "";

      const icon = isError ? theme.fg("error", "x") : theme.fg("success", "✓");
      const statusLabel = d.status && d.status !== "done" ? d.status : "done";
      let line =
        icon +
        " " +
        theme.fg(isError ? "error" : "success", statusLabel) +
        statsStr;

      if (expanded) {
        const s = d.summary || "";
        const f = d.findings || "";
        const e = d.evidence || "";
        if (s) line += "\n" + theme.fg("muted", s);
        if (f) line += "\n" + theme.fg("dim", f);
        if (e)
          line += "\n" + theme.fg("muted", "Evidence: ") + theme.fg("dim", e);
      } else {
        const preview = (d.summary || "").slice(0, 80);
        if (preview) line += "\n" + theme.fg("dim", `  ⎿  ${preview}`);
        else
          line +=
            "\n" +
            theme.fg("dim", `  ⎿  ${isError ? d.status || "error" : "Done"}`);
      }

      return new Text(line, 0, 0);
    },
  });

  pi.registerTool({
    name: "task_batch",
    label: "Task Batch",
    description: TASK_BATCH_TOOL_DESCRIPTION,
    promptSnippet: "Launch multiple independent specialist agents in background",
    promptGuidelines: [
      "Use for independent tasks that can run concurrently",
      "Provide complete context in every prompt because each agent starts fresh",
      "Do not use for task resume, durable conversations, or foreground execution",
      "Do not poll or duplicate delegated work while the batch runs",
      "Review completion results before reporting final conclusions",
    ],
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          agent_type: Type.String({
            description: "The type of specialist agent to use for this task",
          }),
          prompt: Type.String({
            description:
              "The complete task for the agent to perform. Be detailed and self-contained.",
          }),
          description: Type.String({
            description: "A short (3-5 word) summary of this task",
          }),
        }),
        {
          description: `Batch items to launch. Must contain ${TASK_BATCH_MIN_TASKS}-${TASK_BATCH_MAX_TASKS} tasks.`,
          minItems: TASK_BATCH_MIN_TASKS,
          maxItems: TASK_BATCH_MAX_TASKS,
        },
      ),
      backend: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("herdr"),
            Type.Literal("tmux"),
            Type.Literal("sdk"),
          ],
          {
            description:
              "Execution backend. auto prefers herdr inside Herdr, then tmux, then SDK.",
            default: "auto",
          },
        ),
      ),
      tab_label: Type.Optional(
        Type.String({
          description:
            "Optional Herdr tab label for this batch. Ignored by tmux and SDK.",
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const validation = validateTaskBatchTasks(params.tasks);
      if (!validation.ok) {
        return {
          content: [{ type: "text" as const, text: validation.error }],
          details: {
            phase: "failed" as const,
            error: validation.error,
          },
          isError: true,
        };
      }

      const { agents, piDir: discoveredPiDir } = discoverAgents(
        ctx.cwd,
        BUNDLED_AGENT_DIR,
      );
      const agentsByName = new Map(agents.map((agent) => [agent.name, agent]));
      const missingAgents = validation.tasks.filter(
        (task) => !agentsByName.has(task.agent_type),
      );
      if (missingAgents.length > 0) {
        const list = formatAgentList(agents);
        const missing = missingAgents
          .map((task) => `"${task.agent_type}"`)
          .join(", ");
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown agent(s): ${missing}.\nAvailable agents:\n${list}`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: `Unknown agent(s): ${missing}`,
          },
          isError: true,
        };
      }

      let backendSelection;
      try {
        backendSelection = selectSubagentBackend(
          params.backend ?? "auto",
          paneBackends,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: message }],
          details: {
            phase: "failed" as const,
            error: message,
          },
          isError: true,
        };
      }

      const batchId = `batch-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      const batchLabel =
        typeof params.tab_label === "string" && params.tab_label.trim()
          ? params.tab_label.trim()
          : undefined;
      const artifactsDir = join(discoveredPiDir, "artifacts");
      const sessionDir = join(artifactsDir, "sessions");
      await mkdir(sessionDir, { recursive: true });
      const parentToolNames = pi
        .getAllTools()
        .map((tool) => tool.name)
        .filter(Boolean);

      const prepared = await Promise.all(
        validation.tasks.map((task) =>
          prepareBatchTask({
            agent: agentsByName.get(task.agent_type) as AgentConfig,
            prompt: task.prompt,
            description: task.description,
            cwd: ctx.cwd,
            artifactsDir,
            sessionDir,
            parentToolNames,
            ctx,
          }),
        ),
      );

      const launched: TaskBatchStartedTask[] = [];
      const errors: Array<{
        index: number;
        task_id: string;
        agent_type: string;
        description: string;
        error: string;
      }> = [];

      const registerLaunched = (
        task: PreparedBatchTask,
        index: number,
        paneId: string | undefined,
        originalPane: string | null,
      ) => {
        const registered = registerBackgroundBatchTask({
          prepared: task,
          backend: backendSelection.name,
          paneId,
          originalPane,
          piDir: discoveredPiDir,
          artifactsDir,
          batchId,
          batchLabel,
          batchIndex: index,
          batchSize: prepared.length,
        });
        attachBackgroundAbort(
          signal,
          task.id,
          registered.task,
          registered.entry,
          discoveredPiDir,
        );
        launched.push(registered.started);
        return registered;
      };

      if (backendSelection.name === "sdk") {
        for (const [index, task] of prepared.entries()) {
          const registered = registerLaunched(task, index, undefined, null);
          startSdkBackgroundTask(task, registered, discoveredPiDir);
        }
      } else {
        const paneBackend = backendSelection.paneBackend;
        if (!paneBackend) {
          throw new Error(`Missing pane backend for ${backendSelection.name}.`);
        }

        if (backendSelection.name === "herdr" && paneBackend.spawnBatch) {
          let result;
          try {
            result = paneBackend.spawnBatch({
              cwd: ctx.cwd,
              tabLabel: batchLabel,
              tasks: prepared.map((task) => ({
                command: task.shellCommand,
                description: task.description,
                agentType: task.agentType,
              })),
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to create ${backendSelection.name} batch panes: ${message}`,
                },
              ],
              details: {
                phase: "failed" as const,
                batch_id: batchId,
                backend: backendSelection.name,
                error: message,
              },
              isError: true,
            };
          }

          result.items.forEach((item, index) => {
            const task = prepared[index]!;
            if (item.paneId) {
              registerLaunched(task, index, item.paneId, item.originalPane);
              return;
            }
            errors.push({
              index,
              task_id: task.id,
              agent_type: task.agentType,
              description: task.description,
              error: item.error?.message ?? "Herdr batch did not launch task.",
            });
          });
        } else {
          for (const [index, task] of prepared.entries()) {
            try {
              const pane = paneBackend.spawn({
                cwd: ctx.cwd,
                command: task.shellCommand,
                description: task.description,
                agentType: task.agentType,
              });
              registerLaunched(task, index, pane.paneId, pane.originalPane);
            } catch (error) {
              paneBackend.rollbackSpawn();
              const message =
                error instanceof Error ? error.message : String(error);
              errors.push({
                index,
                task_id: task.id,
                agent_type: task.agentType,
                description: task.description,
                error: message,
              });
            }
          }
        }
      }

      if (launched.length > 0) ensureTaskWidget(ctx);

      const errorLines =
        errors.length > 0
          ? [
              "",
              "Launch errors:",
              ...errors.map(
                (error) =>
                  `${error.index + 1}. ${error.task_id} (${error.agent_type}) - ${error.error}`,
              ),
            ]
          : [];
      const receipt = [
        `Batch: ${batchId}.`,
        `Backend: ${backendSelection.name}.`,
        formatTaskBatchReceipt(launched),
        ...errorLines,
      ].join("\n");
      const details = {
        ...formatTaskBatchDetails(launched),
        batch_id: batchId,
        batch_label: batchLabel,
        backend: backendSelection.name,
        requested_count: prepared.length,
        launched_count: launched.length,
        task_ids: launched.map((task) => task.taskId),
        session_names: launched.map((task) => task.sessionName),
        pane_ids: launched
          .map((task) => task.paneId)
          .filter((paneId): paneId is string => Boolean(paneId)),
        errors,
      };

      if (launched.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                errors.length > 0
                  ? receipt
                  : `No task_batch items launched for ${batchId}.`,
            },
          ],
          details: {
            ...details,
            phase: "failed" as const,
            error: "No batch tasks launched",
          },
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: receipt }],
        details,
      };
    },

    renderCall(args, theme, _context) {
      const count = Array.isArray((args as Record<string, unknown>).tasks)
        ? ((args as Record<string, unknown>).tasks as unknown[]).length
        : 0;
      const text =
        theme.fg("toolTitle", "") +
        theme.fg("accent", "batch") +
        theme.fg("dim", count > 0 ? ` - ${count} tasks` : "");
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const d = result.details as
        | {
            batch_id?: string;
            launched_count?: number;
            requested_count?: number;
            backend?: string;
            errors?: unknown[];
          }
        | undefined;
      if (!d) return new Text("", 0, 0);
      const launched = d.launched_count ?? 0;
      const requested = d.requested_count ?? launched;
      const hasErrors = Array.isArray(d.errors) && d.errors.length > 0;
      const icon = hasErrors ? theme.fg("error", "x") : theme.fg("success", "✓");
      return new Text(
        `${icon} ${theme.fg("accent", d.batch_id ?? "task_batch")} ${theme.fg(
          "dim",
          `${launched}/${requested} launched${d.backend ? ` via ${d.backend}` : ""}`,
        )}`,
        0,
        0,
      );
    },
  });

  pi.registerCommand("task-sessions", {
    description: "List durable pi-task conversations",
    handler: async (_args, ctx) => {
      const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
      const { piDir } = discoverAgents(cwd);
      ctx.ui.notify(renderConversationSessions(piDir), "info");
    },
  });
}
