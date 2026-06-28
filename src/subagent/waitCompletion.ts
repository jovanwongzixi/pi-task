import {
  getLastAssistantTextFromSessionDir,
  hasAgentFinished,
} from "../session-text.js";
import { paneExists } from "./tmux.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  sinceMs?: number;
}

/**
 * v0.1.6: The subagent's final assistant message from the auto-saved
 * persistent JSONL session IS the result. No RESULT.md, no agent instructions
 * to write a file. Completion is gated by the assistant's terminal
 * `stopReason` (not `toolUse`, not streaming text).
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
  // If the pane has exited, give pi a brief moment to flush JSONL.
  if (options.paneId && !paneExists(options.paneId)) {
    await sleep(500);
  }

  // Session JSONL is the single authoritative completion source.
  const sessionResult = readSessionText(
    options.sessionDir,
    options.sessionName,
    options.sinceMs,
  );
  if (sessionResult) {
    return { status: "completed", content: sessionResult, source: "session-jsonl" };
  }

  // No terminal assistant message yet. If the pane is alive, keep waiting.
  if (options.paneId && paneExists(options.paneId)) {
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
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const pollMs = options.pollMs ?? 1000;

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) {
      return {
        status: "cancelled",
        content: "Task was cancelled.",
        source: "signal",
      };
    }

    const snapshot = await checkTaskCompletion(options);
    if (snapshot.status !== "running") return snapshot;
    await sleep(pollMs);
  }

  return {
    status: "timeout",
    content: `Task timed out after ${Math.round(timeoutMs / 1000)}s without producing a result.`,
    source: "timeout",
  };
}
