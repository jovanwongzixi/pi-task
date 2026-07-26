/**
 * Task Tool — Delegate complex work to specialist agents.
 *
 * Spawns pi CLI in a tmux split pane (foreground) or background.
 * Completion is detected from the subagent's final assistant message
 * in the persistent session JSONL (stopReason gating). The final message
 * is the authoritative result; no RESULT.md is used.
 *
 * Three agent sources:
 *   - .pi/agents/*.md        project-local agents
 *   - ~/.pi/agent/agents/*.md user-global agents (fallback)
 *
 * P0: Persistent task registry (appendEntry + JSON), --session resume,
 *     sendMessage completion notification, Ctrl+O expand/collapse.
 * P1: Foreground mode (background:false), pane death detection, timeout.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { buildAgentToolSelection } from "./agent-tools.js";
import {
  BACKGROUND_CHECK_MS,
  COUNT_POLL_MS,
  MAX_POLL_ERRORS,
  TASK_TIMEOUT_MS,
} from "./constants.js";
import {
  findJsonlSessionByName,
  normalizeConversationId,
  parseMetadataFromBody,
  readTaskBlock,
  findTaskSessionHistory,
  readRegistry,
  readTaskSessionsRegistry,
  renderConversationSessions,
  upsertTaskSessionHistory,
  writeConversationArtifacts,
  writeRegistry,
  writeTaskSessionsRegistry,
} from "./conversation.js";
import {
  TASK_BATCH_TOOL_DESCRIPTION,
  TASK_BACKGROUND_DEFAULT,
  TASK_TOOL_DESCRIPTION,
  buildPiArgs,
  countToolUses,
  discoverAgents,
  formatAgentList,
  formatBackgroundReceipt,
  formatTaskBatchDetails,
  formatTaskBatchReceipt,
  parseResultXml,
  shellQuote,
  validateTaskBatchTasks,
  type AgentConfig,
  type TaskBatchStartedTask,
} from "./helpers.js";
import {
  completeTask,
  createTaskWidgetController,
  restoreActiveBackgroundTasks,
  startBackgroundPolling,
  startToolStatsPolling,
} from "./lifecycle/index.js";
import { runSdkSubagent } from "./subagent/runSdk.js";
import {
  selectSubagentBackend,
  type SubagentBackendName,
  type SubagentPaneBackend,
} from "./subagent/backend.js";
import { HerdrBackend } from "./subagent/herdr.js";
import {
  checkTaskCompletion,
  waitForTaskCompletion as waitForSessionTaskCompletion,
} from "./subagent/waitCompletion.js";
import {
  TmuxBackend,
  wrapWithPaneExitWatcher,
} from "./subagent/tmux.js";
import {
  buildTaskPrompt,
  createTaskCompleteRenderer,
  renderCall,
  renderResult,
  taskBatchParametersSchema,
  taskParametersSchema,
} from "./tool/index.js";
import type {
  BackgroundTask,
  RegistryEntry,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const BUNDLED_AGENT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agents",
);
const herdrBackend = new HerdrBackend();
const tmuxBackend = new TmuxBackend();
const paneBackends: readonly SubagentPaneBackend[] = [
  herdrBackend,
  tmuxBackend,
];
// Conversation helpers live in ./conversation.js.

// ─── Extension Entry Point ──────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Prevent recursive loading
  if (process.env.PI_TASK_TOOL_DISABLED === "1") return;

  // ── Background task tracker ────────────────────────────────────────────
      const { piDir } = discoverAgents(process.cwd(), BUNDLED_AGENT_DIR);
      const backgroundTasks = new Map<string, BackgroundTask>();
      const foregroundTasks = new Map<string, BackgroundTask>();
  const taskWidget = createTaskWidgetController(foregroundTasks, backgroundTasks);
  const { ensureTaskWidget, clearTaskWidgetIfIdle } = taskWidget;

  // ── Restore active tasks from registry on load ──────────────────────────

  restoreActiveBackgroundTasks(piDir, backgroundTasks, paneBackends);


  // ── Widget / timer setup ───────────────────────────────────────────────

  const countInterval = startToolStatsPolling(
    foregroundTasks,
    backgroundTasks,
    COUNT_POLL_MS,
  );

  // ── Polling loop (background task completion, pane death, timeout) ──────

  const checkInterval = startBackgroundPolling(
    {
      backgroundTasks,
      checkTaskCompletion,
      paneBackends,
      clearTaskWidgetIfIdle,
      completeTask,
      TASK_TIMEOUT_MS,
      MAX_POLL_ERRORS,
      piDir,
      pi,
    },
    BACKGROUND_CHECK_MS,
  );

  // ── Cleanup on shutdown ────────────────────────────────────────────────

  pi.on("session_shutdown", () => {
    clearInterval(checkInterval);
    clearInterval(countInterval);
    taskWidget.dispose();
  });

      // ── Custom notification renderer ───────────────────────────────────────
      pi.registerMessageRenderer?.("task-complete", createTaskCompleteRenderer());

  interface PreparedBatchTask {
    id: string;
    agentType: string;
    description: string;
    sessionName: string;
    sessionDir: string;
    shellCommand: string;
    tmuxCommand: string;
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

  function paneBackendFor(
    backendName: SubagentBackendName | undefined,
  ): SubagentPaneBackend | undefined {
    if (backendName === "sdk") return undefined;
    return paneBackends.find(
      (backend) => backend.name === (backendName ?? "tmux"),
    );
  }

  function paneIsAlive(
    backendName: SubagentBackendName | undefined,
    paneId: string | undefined,
  ): boolean {
    if (!paneId || backendName === "sdk") return false;
    return paneBackendFor(backendName)?.exists(paneId) ?? false;
  }

  async function prepareBatchTask(input: {
    agent: AgentConfig;
    prompt: string;
    description: string;
    cwd: string;
    artifactsDir: string;
    parentToolNames: string[];
    ctx: ExtensionContext;
    forkSource?: string;
  }): Promise<PreparedBatchTask> {
    const id = newTaskId();
    const sessionName = `task-${id}`;
    const sessionDir = join(input.artifactsDir, "sessions", id);
    await mkdir(sessionDir, { recursive: true });

    const promptContent = buildTaskPrompt({
      description: input.description,
      agentName: input.agent.name,
      agentSource: input.agent.source,
      prompt: input.prompt,
      cwd: input.cwd,
      forkContext: Boolean(input.forkSource),
    });
    const piArgs = buildPiArgs(
      input.agent,
      sessionName,
      sessionDir,
      promptContent,
      false,
      input.parentToolNames,
      undefined,
      input.forkSource,
    );
    const shellCommand = `PI_TASK_TOOL_DISABLED=1 pi ${piArgs.map((arg) => shellQuote(arg)).join(" ")}`;
    const sessionFile = join(sessionDir, `${sessionName}.jsonl`);
    const toolSelection = buildAgentToolSelection({
      tools: input.agent.tools,
      disallowedTools: input.agent.disallowedTools,
      parentToolNames: input.parentToolNames,
    });

    return {
      id,
      agentType: input.agent.name,
      description: input.description,
      sessionName,
      sessionDir,
      shellCommand,
      tmuxCommand: wrapWithPaneExitWatcher(sessionFile, shellCommand),
      runSdk: () =>
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
          forkSource: input.forkSource,
          sessionName,
          sessionDir,
        }),
    };
  }

  function finalizeBatchTaskPane(task: BackgroundTask): void {
    if (task.backend === "sdk") return;
    paneBackends
      .find((backend) => backend.name === (task.backend ?? "tmux"))
      ?.kill(task.paneId, task.originalPane);
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
        sessionDir: input.prepared.sessionDir,
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
        finalizeBatchTaskPane(task);
        clearTaskWidgetIfIdle();
        writeRegistry(
          taskPiDir,
          readRegistry(taskPiDir).filter((candidate) => candidate.id !== id),
        );
        upsertTaskSessionHistory(taskPiDir, {
          ...entry,
          status: "cancelled",
          completedAt: Date.now(),
          background: true,
        });
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
      .then(({ output }) => {
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
          paneBackends,
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
          paneBackends,
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
        parameters: taskParametersSchema(),

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

      // ── Fork context: share parent session history ───────────────────
      let forkSource: string | undefined;
      if (params.fork_context) {
        if (params.task_id || params.conversation_id) {
          // fork_context is ignored when task_id or conversation_id is set
          // because resume/conversation paths take precedence
        } else {
          const parentSessionFile = (ctx.sessionManager as any)?.getSessionFile?.();
          if (!parentSessionFile) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "fork_context requires a persisted parent session. The current session is not saved to disk (e.g., running with --no-session). Use a regular task with a self-contained prompt instead.",
                },
              ],
              details: {
                phase: "failed" as const,
                error: "fork_context requires a persisted parent session",
              },
              isError: true,
            };
          }
          forkSource = parentSessionFile;
        }
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
          let resume = false;
          let resumeSessionRef: string | undefined;

          const artifactsDir = join(piDir, "artifacts");

          if (registeredTaskId) {
            id = registeredTaskId;
            sessionName = conversationId ?? `task-${id}`;
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
          paneIsAlive(entry.backend ?? "tmux", entry.paneId)
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
         resume = true;
         resumeSessionRef = entry.sessionRef;

        // If background and pane still alive, reattach to tracker
        if (
          params.background !== false &&
          entry.paneId &&
          paneIsAlive(entry.backend ?? "tmux", entry.paneId)
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
       }

      const envBackend =
        process.env.PI_TASK_BACKEND === "herdr" ||
        process.env.PI_TASK_BACKEND === "tmux" ||
        process.env.PI_TASK_BACKEND === "sdk"
          ? process.env.PI_TASK_BACKEND
          : process.env.PI_TASK_USE_TMUX_BACKEND === "1"
            ? "tmux"
            : process.env.PI_TASK_USE_SDK_BACKEND === "1"
              ? "sdk"
              : undefined;
      let backendSelection;
      try {
        backendSelection = selectSubagentBackend(
          params.backend ?? envBackend ?? "auto",
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
              text: "Durable conversations and task resume require the Herdr or tmux CLI backend so Pi can save and reopen the subagent session. Choose backend:\"herdr\" or backend:\"tmux\", or omit conversation_id/task_id for a one-shot SDK task.",
            },
          ],
          details: {
            phase: "failed" as const,
            error: "pane backend required for durable conversation or resume",
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
          const promptContent = buildTaskPrompt({
            description: descText,
            agentName: agent.name,
            agentSource: agent.source,
            prompt: params.prompt,
            cwd: ctx.cwd,
            forkContext: Boolean(forkSource),
          });

          const sessionDir = join(artifactsDir, "sessions", id);
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
        forkSource,
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
          forkSource,
          sessionName,
          sessionDir,
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

      // Prefer tmux when the parent Pi is running inside tmux so users can watch
      // the subagent's interactive Pi TUI. Fall back to the SDK only when tmux is
      // unavailable, or when explicitly forced with PI_TASK_BACKEND=sdk.
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
              const finalOutput =
                output || "SDK subagent completed without assistant text.";
              backgroundTasks.delete(id);
              clearTaskWidgetIfIdle();
              completeTask(
                pi,
                id,
                bgtask,
                finalOutput,
                "done",
                piDir,
                paneBackends,
              );
            })
            .catch((error) => {
              const message =
                error instanceof Error ? error.message : String(error);
              backgroundTasks.delete(id);
              clearTaskWidgetIfIdle();
              completeTask(
                pi,
                id,
                bgtask,
                `Task ${id} failed: ${message}`,
                "failed",
                piDir,
                paneBackends,
              );
            });

          return {
            content: [
              {
                type: "text" as const,
                text: `Task ${id} started with SDK backend.`,
              },
            ],
                details: {
                  task_id: id,
                  backend: "sdk" as const,
                  background: true,
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
      const sessionFile = join(sessionDir, sessionName + ".jsonl");
      const paneBackend = backendSelection.paneBackend;
      if (!paneBackend) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Missing pane backend for ${backendSelection.name}.`,
            },
          ],
          details: {
            phase: "failed" as const,
            error: `Missing pane backend for ${backendSelection.name}`,
          },
          isError: true,
        };
      }

      let paneId: string;
      let originalPane: string | null;
      try {
        const pane = paneBackend.spawn({
          cwd: ctx.cwd,
          command: `cd ${shellQuote(ctx.cwd)} && ${shellCommand}`,
          sessionFilePath: sessionFile,
          description: descText,
          agentType: agent.name,
        });
        paneId = pane.paneId;
        originalPane = pane.originalPane;
        if (foregroundTask) {
          foregroundTask.paneId = paneId;
          foregroundTask.originalPane = originalPane;
        }
      } catch {
        foregroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        return {
          content: [
            {
                type: "text" as const,
                text: `Failed to create ${backendSelection.name} pane for the agent.`,
              },
            ],
          details: {
            phase: "failed" as const,
            backend: backendSelection.name,
            error: `${backendSelection.name} spawn failed`,
          },
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
          startedAt,
          paneId,
          piDir,
          dir: artifactsDir,
          conversationId,
          status: "running",
          background: false,
        });

        // Poll tool-call progress while waiting for completion
        let lastToolCalls = -1;
        const onAbort = () => clearInterval(toolProgressInterval);
        const toolProgressInterval = setInterval(() => {
          try {
            const stats = countToolUses(sessionDir, sessionName, startedAt);
            if (stats.toolUses > 0 && stats.toolUses !== lastToolCalls) {
              lastToolCalls = stats.toolUses;
              _onUpdate?.({
                content: [
                  {
                    type: "text",
                    text: `${stats.toolUses} tool call${stats.toolUses !== 1 ? "s" : ""}`,
                  },
                ],
                details: { toolCalls: stats.toolUses },
              });
            }
          } catch {
            // session file may not exist yet
          }
        }, COUNT_POLL_MS);
        signal?.addEventListener("abort", onAbort, { once: true });

        const completion = await waitForSessionTaskCompletion({
          sessionDir,
          sessionName,
          paneId,
          paneExists: (candidatePaneId) => paneBackend.exists(candidatePaneId),
          signal,
          timeoutMs: TASK_TIMEOUT_MS,
          pollMs: 1000,
          sinceMs: startedAt,
        });
        clearInterval(toolProgressInterval);
        signal?.removeEventListener("abort", onAbort);
        const content = completion.content;
        const phase =
          completion.status === "completed"
            ? "done"
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
          startedAt,
          paneId,
          piDir,
          dir: artifactsDir,
          conversationId,
          sessionRef: completedSessionRef,
          backend: backendSelection.name,
          status: phase,
          completedAt: Date.now(),
          background: false,
        });
        paneBackend.finalize(
          paneId,
          originalPane,
          phase === "done"
            ? "completed"
            : phase === "cancelled"
              ? "cancelled"
              : "failed",
        );
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
        const { toolUses, turns } = countToolUses(sessionDir, sessionName, startedAt);

            return {
              content: [
                {
                  type: "text" as const,
                  text: parsed.summary || content.trim(),
                },
              ],
              details: {
                task_id: id,
                agent_type: agent.name,
                description: descText,
                phase,
                status: "done",
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
            paneBackend.kill(paneId, originalPane);
            backgroundTasks.delete(id);
            clearTaskWidgetIfIdle();
            // Clean registry
            const remaining = readRegistry(piDir).filter((e) => e.id !== id);
            writeRegistry(piDir, remaining);
                clearTaskWidgetIfIdle();
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

        renderCall,
        renderResult,
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
    parameters: taskBatchParametersSchema(),

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

      // ── Fork context for batch ───────────────────────────────────────
      let batchForkSource: string | undefined;
      if (params.fork_context) {
        const parentSessionFile = (ctx.sessionManager as any)?.getSessionFile?.();
        if (!parentSessionFile) {
          return {
            content: [
              {
                type: "text" as const,
                text: "fork_context requires a persisted parent session. The current session is not saved to disk (e.g., running with --no-session). Use a regular task_batch with self-contained prompts instead.",
              },
            ],
            details: {
              phase: "failed" as const,
              error: "fork_context requires a persisted parent session",
            },
            isError: true,
          };
        }
        batchForkSource = parentSessionFile;
      }

      const batchId = `batch-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`;
      const batchLabel =
        typeof params.tab_label === "string" && params.tab_label.trim()
          ? params.tab_label.trim()
          : undefined;
      const artifactsDir = join(discoveredPiDir, "artifacts");
      await mkdir(join(artifactsDir, "sessions"), { recursive: true });
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
            parentToolNames,
            ctx,
            forkSource: batchForkSource,
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
                command: task.tmuxCommand,
                description: task.description,
                agentType: task.agentType,
              });
              registerLaunched(task, index, pane.paneId, pane.originalPane);
            } catch (error) {
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
        session_dirs: launched.map((task) => task.sessionDir),
        artifact_dir: artifactsDir,
        pane_ids: launched
          .map((task) => task.paneId)
          .filter((paneId): paneId is string => Boolean(paneId)),
        errors,
      };

      if (launched.length === 0) {
        return {
          content: [{ type: "text" as const, text: receipt }],
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
