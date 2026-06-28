import {
  getLastAssistantTextFromSessionDir,
  hasAgentFinished,
} from "../session-text.js";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export type TaskCompletionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

export interface TaskCompletionSnapshot {
  status: TaskCompletionStatus;
  content: string;
  source?: "session-jsonl" | "pane" | "timeout" | "signal";
}

export interface WaitForTaskCompletionOptions {
  sessionDir: string;
  sessionName: string;
  paneId?: string;
  paneExists?: (paneId: string) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  sinceMs?: number;
}

function paneIsAlive(options: Pick<WaitForTaskCompletionOptions, "paneId" | "paneExists">): boolean {
  return Boolean(
    options.paneId &&
      options.paneExists &&
      options.paneExists(options.paneId),
  );
}

/**
 * The subagent's final assistant message from the auto-saved persistent JSONL
 * session is the result. No RESULT.md polling is used.
 */
function readSessionText(
  sessionDir: string,
  sessionName: string,
  sinceMs?: number,
): string | null {
  if (!hasAgentFinished(sessionDir, sessionName, sinceMs)) return null;
  const text = getLastAssistantTextFromSessionDir(
    sessionDir,
    sessionName,
    sinceMs,
  ).trim();
  return text.length > 0 ? text : null;
}

export async function checkTaskCompletion(
  options: Omit<WaitForTaskCompletionOptions, "signal" | "timeoutMs" | "pollMs">,
): Promise<TaskCompletionSnapshot> {
  const alive = paneIsAlive(options);

  // If the pane has exited, give Pi a brief moment to flush JSONL.
  if (options.paneId && options.paneExists && !alive) {
    await sleep(500);
  }

  const sessionResult = readSessionText(
    options.sessionDir,
    options.sessionName,
    options.sinceMs,
  );
  if (sessionResult) {
    return {
      status: "completed",
      content: sessionResult,
      source: "session-jsonl",
    };
  }

  if (alive) {
    return { status: "running", content: "", source: "pane" };
  }

  return {
    status: "failed",
    content: "Subagent pane exited without producing a result.",
  };
}

export async function waitForTaskCompletion(
  options: WaitForTaskCompletionOptions,
): Promise<TaskCompletionSnapshot> {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = options.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        content: "Task was cancelled.",
        source: "signal",
      };
    }

    const snapshot = await checkTaskCompletion(options);
    if (snapshot.status !== "running") return snapshot;

    if (Date.now() >= deadline) {
      return {
        status: "timeout",
        content: `Task timed out after ${Math.round(timeoutMs / 1000)}s without producing a result.`,
        source: "timeout",
      };
    }

    await sleep(pollMs);
  }
}
