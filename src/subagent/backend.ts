export type PaneBackendName = "tmux" | "herdr";
export type SubagentBackendName = PaneBackendName | "sdk";
export type SubagentBackendPreference = SubagentBackendName | "auto";

export interface SpawnSubagentOptions {
  cwd: string;
  command: string;
  description?: string;
}

export interface SpawnedSubagentPane {
  paneId: string;
  originalPane: string | null;
}

/** Terminal-pane operations shared by the tmux and herdr implementations. */
export interface SubagentPaneBackend {
  readonly name: PaneBackendName;
  available(): boolean;
  spawn(options: SpawnSubagentOptions): SpawnedSubagentPane;
  exists(paneId: string): boolean;
  kill(paneId?: string, originalPane?: string | null): void;
  steer(paneId: string, message: string): void;
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
