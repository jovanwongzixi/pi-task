import { existsSync } from "node:fs";
import { readRegistry, updateRegistry } from "../conversation.js";
import { classifyOwnership, type TaskOwner } from "../ownership.js";
import type { SubagentPaneBackend } from "../subagent/backend.js";
import type { BackgroundTask, TaskBackendName } from "../types.js";

function getPaneBackend(
  backends: readonly SubagentPaneBackend[],
  backendName: TaskBackendName | undefined,
): SubagentPaneBackend | undefined {
  if (backendName === "sdk") return undefined;
  return backends.find((backend) => backend.name === (backendName ?? "tmux"));
}

/**
 * Adopt this session's in-flight background tasks from the registry.
 *
 * The registry file can be shared with other workspaces (see ../ownership.ts),
 * so entries owned by another live pi process are skipped entirely: not
 * restored — restoring them would make this session deliver their results —
 * and not pruned either, since only their owner can tell whether they are
 * stale.
 */
export function restoreActiveBackgroundTasks(
  piDir: string,
  backgroundTasks: Map<string, BackgroundTask>,
  paneBackends: readonly SubagentPaneBackend[] = [],
  owner?: TaskOwner,
): void {
  const registry = readRegistry(piDir);
  const staleIds = new Set<string>();
  const restoredByBackend = new Map<
    string,
    { paneId: string; startedAt: number }[]
  >();

  for (const entry of registry) {
    if (owner && classifyOwnership(entry, owner) === "foreign") continue;

    if (!existsSync(entry.dir)) {
      staleIds.add(entry.id);
      continue;
    }

    const backend = entry.backend ?? "tmux";
    const paneBackend = getPaneBackend(paneBackends, backend);
    const paneAlive =
      backend !== "sdk" && entry.paneId
        ? (paneBackend?.exists(entry.paneId) ?? false)
        : false;
    if (!paneAlive) {
      staleIds.add(entry.id);
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

  // Prune only entries we are entitled to own; re-read under the lock so a
  // task another session registered while we were scanning survives.
  if (staleIds.size) {
    updateRegistry(piDir, (entries) =>
      entries.filter((entry) => !staleIds.has(entry.id)),
    );
  }
}
