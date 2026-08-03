import type { ToolCallRecord } from "./helpers.js";

export type TaskBackendName = "tmux" | "herdr" | "sdk";

export interface BackgroundTask {
  backend?: TaskBackendName;
  dir: string;
  agentType: string;
  sessionName: string;
  paneId?: string;
  originalPane: string | null;
  description: string;
  startedAt: number;
  toolUses: number;
  turns: number;
  conversationId?: string;
  batchId?: string;
  batchLabel?: string;
  batchIndex?: number;
  batchSize?: number;
  /** Most recent tool calls (capped), updated every COUNT_POLL_MS. */
  recentCalls: ToolCallRecord[];
  /** Consecutive completion-poll failures; reset to 0 on a successful poll. */
  pollErrors?: number;
  /** Guards backend lifecycle hooks against races between polling and aborts. */
  finalized?: boolean;
}

/** Serializable subset for active task registry persistence. */
export interface RegistryEntry {
  id: string;
  agentType: string;
  description: string;
  sessionName: string;
  startedAt: number;
  paneId?: string;
  piDir: string;
  dir: string;
  conversationId?: string;
  sessionRef?: string;
  backend?: TaskBackendName;
  /** PID of the pi process that spawned this task (see ./ownership.ts). */
  ownerPid?: number;
  /** Start time of that process, in epoch ms; guards against PID reuse. */
  ownerStartedAt?: number;
  /** Resolved cwd of the pi session that spawned this task. */
  ownerCwd?: string;
  batchId?: string;
  batchLabel?: string;
  batchIndex?: number;
  batchSize?: number;
}

/** Durable task→session mapping used for resume after task completion. */
export interface TaskSessionHistoryEntry extends RegistryEntry {
  status: "running" | "done" | "cancelled" | "aborted" | "failed" | "timeout";
  completedAt?: number;
  background: boolean;
}

/** Details attached to tool result for rendering. */
export interface TaskDetails {
  task_id: string;
  agent_type: string;
  description: string;
  conversation_id?: string;
  phase: "done" | "timeout" | "cancelled" | "aborted" | "failed";
  status?: string;
  summary?: string;
  findings?: string;
  evidence?: string;
  confidence?: string;
  duration_ms?: number;
  turn_count?: number;
  tool_uses?: number;
  background?: boolean;
  backend?: TaskBackendName;
  pane_id?: string;
  session_name?: string;
  batch_id?: string;
  batch_label?: string;
  batch_index?: number;
  batch_size?: number;
}
