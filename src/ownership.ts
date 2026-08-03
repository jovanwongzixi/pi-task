import { resolve, sep } from "node:path";
import type { RegistryEntry } from "./types.js";

/**
 * Task ownership.
 *
 * The task registry is a plain JSON file inside the resolved `.pi` directory.
 * That directory is found by walking *up* from the cwd, so several workspaces
 * (any workspace without its own `.pi`) can resolve to the same file — most
 * commonly `~/.pi`. Without an owner stamp, every pi session that loads this
 * extension would restore, poll and finish *every* task in that file, and
 * `pi.sendMessage` would deliver the result into whichever session happened to
 * adopt it. Stamping each entry with the pi process that spawned it keeps
 * results going back to the session that asked for them.
 *
 * The unit of ownership is the pi *process*, not the pi session: `pi.sendMessage`
 * targets the process's currently active session, and the extension is reloaded
 * (with its in-memory task map dropped) across session switches.
 */

/** Tolerance when matching a recorded process start time against our own. */
const START_TIME_TOLERANCE_MS = 5_000;

export interface TaskOwner {
  /** PID of the pi process that spawned the task. */
  pid: number;
  /** Process start time in epoch ms; guards against PID reuse. */
  startedAt: number;
  /** Resolved cwd of that pi process. */
  cwd: string;
}

/** Epoch ms at which this process started. */
export function processStartedAt(): number {
  return Math.round(Date.now() - process.uptime() * 1000);
}

export function currentTaskOwner(cwd: string = process.cwd()): TaskOwner {
  return {
    pid: process.pid,
    startedAt: processStartedAt(),
    cwd: resolve(cwd),
  };
}

/** Owner fields as persisted on a registry entry. */
export function ownerStamp(owner: TaskOwner): Pick<
  RegistryEntry,
  "ownerPid" | "ownerStartedAt" | "ownerCwd"
> {
  return {
    ownerPid: owner.pid,
    ownerStartedAt: owner.startedAt,
    ownerCwd: owner.cwd,
  };
}

/** Attach ownership to a registry entry. */
export function stampOwner<T extends RegistryEntry>(
  entry: T,
  owner: TaskOwner,
): T {
  return { ...entry, ...ownerStamp(owner) };
}

function isSameProcess(entry: RegistryEntry, owner: TaskOwner): boolean {
  if (entry.ownerPid !== owner.pid) return false;
  if (entry.ownerStartedAt === undefined) return false;
  return (
    Math.abs(entry.ownerStartedAt - owner.startedAt) <= START_TIME_TOLERANCE_MS
  );
}

/** True when the recorded owner process is still running. */
export function isOwnerProcessAlive(
  entry: RegistryEntry,
  kill: (pid: number, signal: 0) => void = process.kill.bind(process),
): boolean {
  const pid = entry.ownerPid;
  if (pid === undefined || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isInside(child: string, parent: string): boolean {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

/**
 * Entries written before ownership existed carry no owner fields. Claim one
 * only when its artifacts live inside this workspace, so a shared `~/.pi`
 * registry can't hand another workspace's task to us.
 */
function isLegacyEntryForWorkspace(
  entry: RegistryEntry,
  owner: TaskOwner,
): boolean {
  if (entry.ownerPid !== undefined) return false;
  return isInside(entry.dir, owner.cwd) || isInside(entry.piDir, owner.cwd);
}

export type TaskOwnership =
  /** Spawned by this pi process. */
  | "self"
  /** Owner process is gone; reclaimable by a session in the same workspace. */
  | "orphan"
  /** Owned by another live pi process — must be left alone. */
  | "foreign";

export function classifyOwnership(
  entry: RegistryEntry,
  owner: TaskOwner,
  kill?: (pid: number, signal: 0) => void,
): TaskOwnership {
  if (isSameProcess(entry, owner)) return "self";
  if (isOwnerProcessAlive(entry, kill)) return "foreign";
  if (entry.ownerPid !== undefined) {
    return entry.ownerCwd && !isInside(entry.ownerCwd, owner.cwd)
      ? "foreign"
      : "orphan";
  }
  return isLegacyEntryForWorkspace(entry, owner) ? "orphan" : "foreign";
}

/**
 * Whether this session may take over an entry: only its own tasks, or tasks
 * whose owner process died while working in this workspace.
 */
export function isAdoptable(
  entry: RegistryEntry,
  owner: TaskOwner,
  kill?: (pid: number, signal: 0) => void,
): boolean {
  return classifyOwnership(entry, owner, kill) !== "foreign";
}
