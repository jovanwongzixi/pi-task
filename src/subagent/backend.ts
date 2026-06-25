export type PaneBackendName = "tmux" | "herdr";
export type SubagentBackendName = PaneBackendName | "sdk";
export type SubagentBackendPreference = SubagentBackendName | "auto";
export type SubagentOutcome =
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "tracking-error";

export interface SpawnSubagentOptions {
  cwd: string;
  command: string;
  description?: string;
  agentType?: string;
}

export interface SpawnSubagentBatchItemOptions {
  command: string;
  description?: string;
  agentType?: string;
}

export interface SpawnSubagentBatchOptions {
  cwd: string;
  tasks: SpawnSubagentBatchItemOptions[];
  tabLabel?: string;
  tab_label?: string;
}

export interface SpawnedSubagentPane {
  paneId: string;
  originalPane: string | null;
}

export type SpawnedSubagentBatchItem =
  | {
      paneId: string;
      originalPane: string | null;
      error?: undefined;
    }
  | {
      paneId?: undefined;
      originalPane: string | null;
      error: Error;
    };

export interface SpawnedSubagentBatch {
  tabId: string;
  originalPane: string | null;
  items: SpawnedSubagentBatchItem[];
}

/** Terminal-pane operations shared by the tmux and herdr implementations. */
export interface SubagentPaneBackend {
  readonly name: PaneBackendName;
  available(): boolean;
  spawn(options: SpawnSubagentOptions): SpawnedSubagentPane;
  spawnBatch?(options: SpawnSubagentBatchOptions): SpawnedSubagentBatch;
  exists(paneId: string): boolean;
  finalize(
    paneId: string | undefined,
    originalPane: string | null | undefined,
    outcome: SubagentOutcome,
  ): void;
  rollbackSpawn(paneId?: string): void;
  kill(paneId?: string, originalPane?: string | null): void;
  steer(paneId: string, message: string): void;
  /**
   * Reconstruct transient backend launch state after restoring active registry
   * entries. Backends should infer current tab/workspace from live pane state
   * and must not move panes.
   */
  adoptRestoredPanes?(entries: { paneId: string; startedAt: number }[]): void;
}

export interface BackendSelection {
  name: SubagentBackendName;
  paneBackend?: SubagentPaneBackend;
}

export function selectSubagentBackend(
  preference: SubagentBackendPreference,
  backends: readonly SubagentPaneBackend[],
): BackendSelection {
  if (preference === "sdk") return { name: "sdk" };

  if (preference !== "auto") {
    const backend = backends.find((candidate) => candidate.name === preference);
    if (!backend || !backend.available()) {
      throw new Error(`Requested ${preference} backend is unavailable.`);
    }
    return { name: backend.name, paneBackend: backend };
  }

  for (const name of ["herdr", "tmux"] as const) {
    const backend = backends.find((candidate) => candidate.name === name);
    if (backend?.available()) {
      return { name: backend.name, paneBackend: backend };
    }
  }

  return { name: "sdk" };
}
