import { execFileSync } from "node:child_process";
import type {
  SpawnSubagentOptions,
  SpawnedSubagentPane,
  SubagentPaneBackend,
} from "./backend.js";

export type HerdrCommand = (args: string[]) => string;

interface HerdrPane {
  pane_id?: string;
  focused?: boolean;
}

function defaultHerdrCommand(args: string[]): string {
  return execFileSync("herdr", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Herdr returned invalid JSON.");
  }
}

export function parseHerdrPanes(raw: string): HerdrPane[] {
  const value = parseJson(raw) as { result?: { panes?: unknown } };
  return Array.isArray(value.result?.panes)
    ? (value.result.panes as HerdrPane[])
    : [];
}

export function parseSplitHerdrPaneId(raw: string): string {
  const value = parseJson(raw) as {
    result?: { pane?: { pane_id?: unknown } };
  };
  const paneId = value.result?.pane?.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new Error("Herdr pane split did not return result.pane.pane_id.");
  }
  return paneId;
}

/** Herdr-specific pane lifecycle. No tmux behavior belongs in this class. */
export class HerdrBackend implements SubagentPaneBackend {
  readonly name = "herdr" as const;

  constructor(private readonly command: HerdrCommand = defaultHerdrCommand) {}

  available(): boolean {
    if (process.env.HERDR_ENV !== "1") return false;
    try {
      this.listPanes();
      return true;
    } catch {
      return false;
    }
  }

  exists(paneId: string): boolean {
    try {
      return this.listPanes().some((pane) => pane.pane_id === paneId);
    } catch {
      return false;
    }
  }

  spawn(options: SpawnSubagentOptions): SpawnedSubagentPane {
    const originalPane =
      this.listPanes().find((pane) => pane.focused)?.pane_id ?? null;
    if (!originalPane) {
      throw new Error("Could not determine the focused herdr pane.");
    }

    const paneId = parseSplitHerdrPaneId(
      this.command([
        "pane",
        "split",
        originalPane,
        "--direction",
        "right",
        "--cwd",
        options.cwd,
        "--no-focus",
      ]),
    );
    try {
      this.command(["pane", "run", paneId, options.command]);
    } catch (error) {
      this.kill(paneId);
      throw error;
    }
    return { paneId, originalPane };
  }

  kill(paneId?: string): void {
    if (!paneId) return;
    try {
      this.command(["pane", "close", paneId]);
    } catch {
      // Pane already exited or its live ID is no longer valid.
    }
  }

  steer(paneId: string, message: string): void {
    this.command(["pane", "send-text", paneId, message]);
    this.command(["pane", "send-keys", paneId, "Enter"]);
  }

  private listPanes(): HerdrPane[] {
    return parseHerdrPanes(this.command(["pane", "list"]));
  }
}
