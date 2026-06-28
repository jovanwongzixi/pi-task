import { join } from "node:path";
import type {
  SubagentOutcome,
  SubagentPaneBackend,
} from "../subagent/backend.js";
import type { BackgroundTask, TaskBackendName } from "../types.js";

/**
 * Background polling logic for task completion.
 * This module encapsulates the interval-based checking of background tasks.
 */

export interface PollingDeps {
  backgroundTasks: Map<string, BackgroundTask>;
  checkTaskCompletion: (opts: any) => Promise<any>;
  paneBackends: readonly SubagentPaneBackend[];
  clearTaskWidgetIfIdle: () => void;
  completeTask: (
    pi: any,
    id: string,
    task: BackgroundTask,
    content: string,
    phase: "done" | "timeout" | "cancelled" | "failed",
    piDir: string,
    paneBackends?: readonly SubagentPaneBackend[],
    outcome?: SubagentOutcome,
  ) => void;
  TASK_TIMEOUT_MS: number;
  MAX_POLL_ERRORS: number;
  piDir: string;
  pi: any;
}

let checkInFlight = false;

function getPaneBackend(
  backends: readonly SubagentPaneBackend[],
  backendName: TaskBackendName | undefined,
): SubagentPaneBackend | undefined {
  if (backendName === "sdk") return undefined;
  return backends.find((backend) => backend.name === (backendName ?? "tmux"));
}

function sessionDirForTask(task: BackgroundTask, id: string): string {
  return join(task.dir, "sessions", id);
}

export function startBackgroundPolling(deps: PollingDeps, intervalMs: number) {
  const {
    backgroundTasks,
    checkTaskCompletion,
    paneBackends,
    clearTaskWidgetIfIdle,
    completeTask,
    TASK_TIMEOUT_MS,
    MAX_POLL_ERRORS,
    piDir,
    pi,
  } = deps;

  return setInterval(async () => {
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
            paneBackends,
          );
          continue;
        }

        if (task.backend === "sdk") continue;

        const paneBackend = getPaneBackend(paneBackends, task.backend);

        let snapshot: any;
        try {
          snapshot = await checkTaskCompletion({
            sessionDir: sessionDirForTask(task, id),
            sessionName: task.sessionName,
            paneId: task.paneId,
            paneExists: (paneId: string) =>
              paneBackend?.exists(paneId) ?? false,
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
              paneBackends,
              "tracking-error",
            );
          }
          continue;
        }

        task.pollErrors = 0;

        if (snapshot.status === "running") {
          continue;
        }

        const phase = snapshot.status === "completed" ? "done" : "failed";
        backgroundTasks.delete(id);
        clearTaskWidgetIfIdle();
        completeTask(pi, id, task, snapshot.content, phase, piDir, paneBackends);
      }
    } finally {
      checkInFlight = false;
    }
  }, intervalMs);
}
