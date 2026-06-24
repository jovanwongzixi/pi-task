import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
  source?: "result-file" | "session-jsonl" | "pane" | "timeout" | "signal";
}

export interface TaskCompletionOptions {
  resultPath: string;
  sessionDir: string;
  sessionName: string;
  paneId?: string;
  paneExists?: (paneId: string) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollMs?: number;
  sinceMs?: number;
}

async function readResultFile(resultPath: string): Promise<string | null> {
  if (!existsSync(resultPath)) return null;
  const text = (await readFile(resultPath, "utf-8")).trim();
  return text.length > 0 ? text : null;
}

/**
 * Read final assistant text only after Pi records agent_end. This prevents
 * streaming intermediate text from being mistaken for a completed result.
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
  options: TaskCompletionOptions,
): Promise<TaskCompletionSnapshot> {
  const paneIsAlive = () =>
    options.paneId && options.paneExists
      ? options.paneExists(options.paneId)
      : false;

  // Give Pi a brief moment to flush its session after a pane exits.
  if (options.paneId && options.paneExists && !paneIsAlive()) {
    await sleep(500);
  }

  const result = await readResultFile(options.resultPath);
  if (result) {
    return { status: "completed", content: result, source: "result-file" };
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

  if (paneIsAlive()) {
    return { status: "running", content: "", source: "pane" };
  }

  return {
    status: "failed",
    content: "Subagent pane exited without producing a result.",
  };
}

export async function waitForTaskCompletion(
  options: TaskCompletionOptions,
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
