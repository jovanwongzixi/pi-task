/**
 * Tmux helpers for subagent panes (shared by task extension).
 */

import { execFileSync } from "node:child_process";
import { buildTmuxSplitWindowArgs, chooseTmuxSplitDirection } from "../helpers.js";
import type {
  SpawnSubagentOptions,
  SpawnedSubagentPane,
  SubagentPaneBackend,
} from "./backend.js";

export type TmuxCommand = (args: string[], input?: string) => string;

function defaultTmuxCommand(args: string[], input?: string): string {
  return execFileSync("tmux", args, {
    input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Tmux-specific pane lifecycle. No herdr behavior belongs in this class. */
export class TmuxBackend implements SubagentPaneBackend {
  readonly name = "tmux" as const;

  constructor(private readonly command: TmuxCommand = defaultTmuxCommand) {}

  available(): boolean {
    return Boolean(this.getCurrentPaneId());
  }

  exists(paneId: string): boolean {
    try {
      const out = this.command(["list-panes", "-a", "-F", "#{pane_id}"]);
      return out.split("\n").includes(paneId);
    } catch {
      return false;
    }
  }

  spawn(options: SpawnSubagentOptions): SpawnedSubagentPane {
    const originalPane = this.getCurrentPaneId();
    const paneSize = this.getCurrentPaneSize(originalPane);
    const direction = chooseTmuxSplitDirection(
      paneSize?.width ?? 0,
      paneSize?.height ?? 0,
    );
    const paneId = this.command(
      buildTmuxSplitWindowArgs(
        options.cwd,
        options.command,
        direction,
        originalPane,
      ),
    );
    return { paneId, originalPane };
  }

  kill(paneId?: string, originalPane?: string | null): void {
    if (paneId) {
      try {
        this.command(["kill-pane", "-t", paneId]);
      } catch {
        // Pane already exited.
      }
    }
    if (originalPane) {
      try {
        this.command(["select-pane", "-t", originalPane]);
      } catch {
        // Original pane may no longer exist.
      }
    }
  }

  steer(paneId: string, message: string): void {
    const bufferName = `pi-task-steer-${process.pid}-${Date.now()}`;
    try {
      this.command(["load-buffer", "-b", bufferName, "-"], message);
      this.command(["paste-buffer", "-b", bufferName, "-t", paneId]);
    } finally {
      try {
        this.command(["delete-buffer", "-b", bufferName]);
      } catch {
        // Buffer may already be gone.
      }
    }
    this.command(["send-keys", "-t", paneId, "Enter"]);
  }

  private getCurrentPaneId(): string | null {
    try {
      return this.command(["display-message", "-p", "#{pane_id}"]);
    } catch {
      return null;
    }
  }

  private getCurrentPaneSize(
    targetPane?: string | null,
  ): { width: number; height: number } | null {
    try {
      const args = ["display-message", "-p", "#{pane_width} #{pane_height}"];
      if (targetPane) args.splice(1, 0, "-t", targetPane);
      const [widthRaw, heightRaw] = this.command(args).trim().split(/\s+/, 2);
      const width = Number(widthRaw);
      const height = Number(heightRaw);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      return { width, height };
    } catch {
      return null;
    }
  }
}
