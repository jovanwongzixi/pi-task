    import {
      existsSync,
      mkdirSync,
      readdirSync,
      readFileSync,
      renameSync,
      rmSync,
      statSync,
      writeFileSync,
    } from "node:fs";
    import { join } from "node:path";
    import type { RegistryEntry, TaskSessionHistoryEntry } from "./types.js";

/**
 * Conversational subagent helpers.
 *
 * Per-task data lives in `.pi/artifacts/TASKS.md` as `### <task-id>` blocks.
 * A small `task-sessions.json` registry in the same directory maps
 * `conversation_id` to the auto-saved session file path so the
 * subagent can be resumed later.
 *
 * The subagent's session is auto-saved by pi at
 * `~/.pi/agent/sessions/<cwd>/<session-id>.jsonl`. pi-task does not
 * maintain its own session storage.
 *
 * All artifacts live flat at the top of `.pi/artifacts/`, alongside the
 * pikit canonical files (TODO.md, PLAN.md, PROGRESS.md, DECISIONS.md).
 * No subdirs. No per-task paths.
 */

export const TASKS_FILE = "TASKS.md";
export const TASK_SESSIONS_REGISTRY_FILE = "task-sessions.json";

export interface ConversationMetadata {
  conversation_id: string;
  task_id: string;
  agent_type: string;
  session_file: string;
  created_at: string;
  last_used_at: string;
  last_prompt?: string;
}

export type TaskSessionsRegistry = Record<
  string,
  { task_id: string; session_file: string }
>;

export function getTasksFilePath(piDir: string): string {
  return join(piDir, "artifacts", TASKS_FILE);
}

export function getTaskSessionsRegistryPath(piDir: string): string {
  return join(piDir, "artifacts", TASK_SESSIONS_REGISTRY_FILE);
}

export function getRegistryPath(piDir: string): string {
  return join(piDir, "task-registry.json");
}

export function getTaskSessionHistoryPath(piDir: string): string {
  return join(piDir, "task-session-history.json");
}

function readJsonArray<T>(path: string): T[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Write via temp file + rename so a concurrent reader never sees a partial file. */
function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}

/**
 * Read-modify-write under a directory lock.
 *
 * The registry files are shared by every pi session that resolves to the same
 * `.pi` directory, so a plain read-then-write loses entries whenever two
 * sessions start or finish a task at the same time. `mkdir` is atomic on every
 * platform we support; the lock is held for the duration of a small JSON
 * rewrite, so a short spin is cheaper than going async.
 */
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;

/** Blocking sleep — the lock is synchronous by necessity. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock<T>(path: string, mutate: () => T): T {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let held = false;

  while (Date.now() < deadline) {
    try {
      mkdirSync(lock);
      held = true;
      break;
    } catch {
      // Break a lock left behind by a crashed process.
      try {
        const age = Date.now() - statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // lock vanished; retry
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }

  try {
    return mutate();
  } finally {
    if (held) {
      try {
        rmSync(lock, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
}

export function readRegistry(piDir: string): RegistryEntry[] {
  return readJsonArray<RegistryEntry>(getRegistryPath(piDir));
}

export function writeRegistry(piDir: string, entries: RegistryEntry[]): void {
  const path = getRegistryPath(piDir);
  withFileLock(path, () => writeJsonAtomic(path, entries));
}

/**
 * Apply `mutate` to the registry while holding the lock. Prefer this over
 * `readRegistry` + `writeRegistry`: it is the only way to add or remove a
 * single entry without clobbering entries written by another pi session in
 * between the read and the write.
 */
export function updateRegistry(
  piDir: string,
  mutate: (entries: RegistryEntry[]) => RegistryEntry[],
): RegistryEntry[] {
  const path = getRegistryPath(piDir);
  return withFileLock(path, () => {
    const next = mutate(readJsonArray<RegistryEntry>(path));
    writeJsonAtomic(path, next);
    return next;
  });
}

export function readTaskSessionHistory(piDir: string): TaskSessionHistoryEntry[] {
  return readJsonArray<TaskSessionHistoryEntry>(
    getTaskSessionHistoryPath(piDir),
  );
}

export function writeTaskSessionHistory(
  piDir: string,
  entries: TaskSessionHistoryEntry[],
): void {
  const path = getTaskSessionHistoryPath(piDir);
  withFileLock(path, () => writeJsonAtomic(path, entries));
}

export function upsertTaskSessionHistory(
  piDir: string,
  entry: TaskSessionHistoryEntry,
): void {
  const path = getTaskSessionHistoryPath(piDir);
  withFileLock(path, () => {
    const entries = readJsonArray<TaskSessionHistoryEntry>(path);
    const index = entries.findIndex((existing) => existing.id === entry.id);
    if (index >= 0) {
      entries[index] = { ...entries[index], ...entry };
    } else {
      entries.push(entry);
    }
    writeJsonAtomic(path, entries);
  });
}

export function findTaskSessionHistory(
  piDir: string,
  idOrSessionName: string,
): TaskSessionHistoryEntry | undefined {
  return readTaskSessionHistory(piDir).find(
    (entry) =>
      entry.id === idOrSessionName || entry.sessionName === idOrSessionName,
  );
}

export function findJsonlSessionByName(
  piDir: string,
  sessionName: string,
  agentType: string,
): TaskSessionHistoryEntry | undefined {
  const artifactsDir = join(piDir, "artifacts");
  const sessionDir = join(artifactsDir, "sessions");
  try {
    if (!existsSync(sessionDir)) return undefined;
    const files = readdirSync(sessionDir)
      .filter((file) => file.endsWith(".jsonl"))
      .sort()
      .reverse();
    for (const file of files) {
      const content = readFileSync(join(sessionDir, file), "utf-8");
      let startedAt = Date.now();
      let lastSessionInfoName: string | undefined;
      for (const rawLine of content.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            timestamp?: string;
            name?: string;
            session_info?: { name?: string };
          };
          if (entry.type === "session" && entry.timestamp) {
            const parsed = Date.parse(entry.timestamp);
            if (Number.isFinite(parsed)) startedAt = parsed;
          }
          if (entry.type === "session_info") {
            lastSessionInfoName = entry.name ?? entry.session_info?.name;
          }
        } catch {
          // Skip malformed lines.
        }
      }
      if (lastSessionInfoName === sessionName) {
        return {
          id: sessionName,
          agentType,
          description: `Resumed session ${sessionName}`,
          sessionName,
          sessionRef: join(sessionDir, file),
          startedAt,
          piDir,
          dir: artifactsDir,
          conversationId: sessionName,
          status: "done",
          background: false,
        };
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function normalizeConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const conversationId = value.trim();
  if (!conversationId) return undefined;
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(conversationId)) {
    throw new Error(
      "conversation_id must be 1-80 chars and contain only letters, numbers, '.', '_' or '-'",
    );
  }
  return conversationId;
}

export function readTaskSessionsRegistry(piDir: string): TaskSessionsRegistry {
  try {
    const parsed = JSON.parse(
      readFileSync(getTaskSessionsRegistryPath(piDir), "utf-8"),
    ) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const registry: TaskSessionsRegistry = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { task_id?: unknown }).task_id === "string" &&
        typeof (value as { session_file?: unknown }).session_file === "string"
      ) {
        const v = value as { task_id: string; session_file: string };
        registry[key] = { task_id: v.task_id, session_file: v.session_file };
      }
    }
    return registry;
  } catch {
    return {};
  }
}

export function writeTaskSessionsRegistry(
  piDir: string,
  registry: TaskSessionsRegistry,
): void {
  mkdirSync(join(piDir, "artifacts"), { recursive: true });
  writeFileSync(
    getTaskSessionsRegistryPath(piDir),
    `${JSON.stringify(registry, null, 2)}\n`,
    "utf-8",
  );
}

/**
 * Find a `### <task-id>` block in TASKS.md. Returns the block content
 * (everything between the heading and the next H3 or EOF) plus the
 * status line if present. Returns undefined if no block exists.
 */
export function readTaskBlock(
  piDir: string,
  taskId: string,
): { status: string | null; body: string } | undefined {
  let content: string;
  try {
    content = readFileSync(getTasksFilePath(piDir), "utf-8");
  } catch {
    return undefined;
  }
  return parseTaskBlocks(content).get(taskId);
}

export function listTaskBlocks(
  piDir: string,
): Map<string, { status: string | null; body: string }> {
  let content: string;
  try {
    content = readFileSync(getTasksFilePath(piDir), "utf-8");
  } catch {
    return new Map();
  }
  return parseTaskBlocks(content);
}

function parseTaskBlocks(
  content: string,
): Map<string, { status: string | null; body: string }> {
  const blocks = new Map<string, { status: string | null; body: string }>();
  const lines = content.split("\n");
  let currentTaskId: string | null = null;
  let currentStatus: string | null = null;
  let currentBody: string[] = [];

  const flush = () => {
    if (currentTaskId !== null) {
      blocks.set(currentTaskId, {
        status: currentStatus,
        body: currentBody.join("\n"),
      });
    }
    currentTaskId = null;
    currentStatus = null;
    currentBody = [];
  };

  for (const line of lines) {
    const heading = line.match(/^###\s+(\S+)\s*$/);
    if (heading) {
      flush();
      currentTaskId = heading[1];
      continue;
    }
    if (currentTaskId === null) continue;

    const statusMatch = line.match(/^status:\s*(\S+)/);
    if (statusMatch) {
      currentStatus = statusMatch[1].toLowerCase();
      continue;
    }
    currentBody.push(line);
  }
  flush();
  return blocks;
}

/**
 * Append or update a `### <task-id>` block in TASKS.md. If the block
 * already exists, its body is replaced. Otherwise, the block is
 * appended at the end of the file.
 */
export function writeTaskBlock(options: {
  piDir: string;
  taskId: string;
  status: "active" | "done" | "abandoned";
  updated: string;
  body: string;
}): void {
  const path = getTasksFilePath(options.piDir);
  let content = "";
  try {
    content = readFileSync(path, "utf-8");
    if (!content.endsWith("\n")) content += "\n";
  } catch {
    content = "";
  }

  const heading = `### ${options.taskId}`;
  const statusLine = `status: ${options.status} | updated: ${options.updated}`;
  const block = `${heading}\n${statusLine}\n\n${options.body}\n`;

  const headingRe = new RegExp(`^### ${escapeRegExp(options.taskId)}\\s*$`, "m");
  const match = content.match(headingRe);
  if (match && match.index !== undefined) {
    const start = match.index;
    const after = content.slice(start);
    const nextHeading = after.search(/^###\s+\S+/m);
    const end = nextHeading > 0 ? start + nextHeading : content.length;
    content = content.slice(0, start) + block + content.slice(end);
  } else {
    if (content.length > 0 && !content.endsWith("\n\n")) {
      content += "\n";
    }
    content += block;
  }

  mkdirSync(join(options.piDir, "artifacts"), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseMetadataFromBody(
  body: string | undefined,
): { created_at?: string; last_used_at?: string; agent_type?: string; session_file?: string; conversation_id?: string; last_prompt?: string } | undefined {
  if (!body) return undefined;
  const match = body.match(/```json\n([\s\S]*?)\n```/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]) as {
      created_at?: string;
      last_used_at?: string;
      agent_type?: string;
      session_file?: string;
      conversation_id?: string;
      last_prompt?: string;
    };
  } catch {
    return undefined;
  }
}

export interface WriteTaskBlockInput {
  piDir: string;
  taskId: string;
  conversationId: string;
  agentType: string;
  sessionFile: string;
  prompt: string;
  result: string;
  resultLabel?: string;
}

/**
 * Persist a completed task: write (or update) the `### <task-id>` block
 * in TASKS.md with metadata and result as H4 subsections. Also updates
 * the task-sessions registry.
 */
export function writeConversationArtifacts(
  input: WriteTaskBlockInput,
): ConversationMetadata {
  const now = new Date().toISOString();
  const existing = readTaskBlock(input.piDir, input.taskId);
  const previous = parseMetadataFromBody(existing?.body);

  const metadata: ConversationMetadata = {
    conversation_id: input.conversationId,
    task_id: input.taskId,
    agent_type: input.agentType,
    session_file: input.sessionFile,
    created_at: previous?.created_at ?? now,
    last_used_at: now,
    last_prompt: input.prompt,
  };

  const body = [
    "#### Metadata",
    "",
    "```json",
    JSON.stringify(metadata, null, 2),
    "```",
    "",
    "#### Result",
    "",
    input.result.trim(),
    "",
  ].join("\n");

  writeTaskBlock({
    piDir: input.piDir,
    taskId: input.taskId,
    status: "done",
    updated: now,
    body,
  });

  const registry = readTaskSessionsRegistry(input.piDir);
  registry[input.conversationId] = {
    task_id: input.taskId,
    session_file: input.sessionFile,
  };
  writeTaskSessionsRegistry(input.piDir, registry);

  return metadata;
}

export function renderConversationSessions(piDir: string): string {
  const blocks = listTaskBlocks(piDir);
  if (blocks.size === 0) {
    return 'No durable task conversations found. Start one with task({ conversation_id: "research-ai", ... }).';
  }
  const entries = Array.from(blocks.entries()).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const lines = ["Durable task conversations:"];
  for (const [taskId, block] of entries) {
    const metadata = parseMetadataFromBody(block.body);
    const agent = metadata?.agent_type ?? "unknown";
    const last = metadata?.last_used_at ?? "unknown";
    const conv = metadata?.conversation_id ?? "(no conversation_id)";
    lines.push(`${conv} -> ${taskId} — ${agent}, last used ${last}`);
  }
  return lines.join("\n");
}
