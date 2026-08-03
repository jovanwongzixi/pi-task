import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findJsonlSessionByName,
  updateRegistry,
  upsertTaskSessionHistory,
} from "../conversation.js";
import { parseResultXml } from "../helpers.js";
import type {
  SubagentOutcome,
  SubagentPaneBackend,
} from "../subagent/backend.js";
import type { BackgroundTask, TaskBackendName } from "../types.js";

export type TaskTerminalPhase = "done" | "timeout" | "cancelled" | "failed";

export function outcomeForPhase(phase: TaskTerminalPhase): SubagentOutcome {
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

function getPaneBackend(
  backends: readonly SubagentPaneBackend[],
  backendName: TaskBackendName | undefined,
): SubagentPaneBackend | undefined {
  if (backendName === "sdk") return undefined;
  return backends.find((backend) => backend.name === (backendName ?? "tmux"));
}

export function finalizeTaskPane(
  task: BackgroundTask,
  backends: readonly SubagentPaneBackend[],
  outcome: SubagentOutcome,
): void {
  if (task.backend === "sdk" || task.finalized) return;
  const paneBackend = getPaneBackend(backends, task.backend);
  if (!paneBackend) return;
  task.finalized = true;
  paneBackend.finalize(task.paneId, task.originalPane, outcome);
}

export function completeTask(
  pi: ExtensionAPI,
  id: string,
  task: BackgroundTask,
  content: string,
  phase: TaskTerminalPhase,
  piDir: string,
  paneBackends: readonly SubagentPaneBackend[] = [],
  outcome: SubagentOutcome = outcomeForPhase(phase),
): void {
  finalizeTaskPane(task, paneBackends, outcome);

  const backend = task.backend ?? "tmux";
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
    backend,
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
        backend,
        pane_id: task.paneId,
        session_name: task.sessionName,
        summary: parsed.summary,
        findings: parsed.findings,
        confidence: parsed.confidence,
        duration_ms: durationMs,
        tool_uses: task.toolUses,
        turn_count: task.turns,
        batch_id: task.batchId,
        batch_label: task.batchLabel,
        batch_index: task.batchIndex,
        batch_size: task.batchSize,
      },
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );

  updateRegistry(piDir, (entries) => entries.filter((entry) => entry.id !== id));
}
