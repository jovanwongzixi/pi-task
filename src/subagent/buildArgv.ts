/**
 * Build `pi` CLI argv for subagent spawns.
 */

import type { AgentConfig } from "../helpers.js";
import { resolveAgentToolAllowlist } from "../agent-tools.js";

export interface BuildPiArgvOptions {
  agent: AgentConfig;
  sessionName: string;
  sessionDir: string;
  promptContent: string;
  /** Explicit resolved model; falls back to the agent's default model. */
  modelOverride?: string;
  resume?: boolean;
  resumeSessionRef?: string;
  parentToolNames?: string[];
  forkSource?: string;
}

export function buildPiArgv(opts: BuildPiArgvOptions): string[] {
  const { agent, sessionName, sessionDir, promptContent, resume } = opts;

  const allowedTools = resolveAgentToolAllowlist({
    tools: agent.tools,
    disallowedTools: agent.disallowedTools,
    parentToolNames: opts.parentToolNames,
  });

  const args: string[] = [];
  const model = opts.modelOverride ?? agent.model;
  if (model) args.push("--model", model);
  if (agent.thinking) args.push("--thinking", agent.thinking);
  args.push("--tools", allowedTools.join(","));
  args.push("--name", sessionName);
  args.push("--session-dir", sessionDir);
  if (opts.forkSource) {
    args.push("--fork", opts.forkSource);
  } else if (resume) {
    args.push("--session", opts.resumeSessionRef ?? sessionName);
  }
  args.push("--append-system-prompt", agent.body);
  args.push(promptContent);
  return args;
}
