import { existsSync } from "node:fs";
import { readRegistry, writeRegistry } from "../conversation.js";
import type { SubagentPaneBackend } from "../subagent/backend.js";
import type { BackgroundTask, TaskBackendName } from "../types.js";

function getPaneBackend(
  backends: readonly SubagentPaneBackend[],
  backendName: TaskBackendName | undefined,
): SubagentPaneBackend | undefined {
  if (backendName === "sdk") return undefined;
  return backends.find((backend) => backend.name === (backendName ?? "tmux"));
}

export function restoreActiveBackgroundTasks(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
  paneBackends: readonly SubagentPaneBackend[] = [],
): void {
  const registry = readRegistry(piDir);
  const staleIds: string[] = [];
  const restoredByBackend = new Map<
    string,
    { paneId: string; startedAt: number }[]
  >();

  for (const entry of registry) {
    if (!existsSync(entry.dir)) {
      staleIds.push(entry.id);
      continue;
    }

    const backend = entry.backend ?? "tmux";
    const paneBackend = getPaneBackend(paneBackends, backend);
    const paneAlive =
      backend !== "sdk" && entry.paneId
        ? (paneBackend?.exists(entry.paneId) ?? false)
        : false;
    if (!paneAlive) {
      staleIds.push(entry.id);
      continue;
    }

    backgroundTasks.set(entry.id, {
      backend,
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
      recentCalls: [],
      batchId: entry.batchId,
      batchLabel: entry.batchLabel,
      batchIndex: entry.batchIndex,
      batchSize: entry.batchSize,
    });

    if (entry.paneId) {
      const restored = restoredByBackend.get(backend) ?? [];
      restored.push({ paneId: entry.paneId, startedAt: entry.startedAt });
      restoredByBackend.set(backend, restored);
    }
  }

  for (const backend of paneBackends) {
    backend.adoptRestoredPanes?.(restoredByBackend.get(backend.name) ?? []);
  }

  if (staleIds.length) {
    writeRegistry(
      piDir,
      registry.filter((entry) => !staleIds.includes(entry.id)),
    );
  }
}
