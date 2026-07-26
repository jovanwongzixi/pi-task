import { TASK_PROMPT_INSTRUCTIONS } from "../helpers.js";

export interface BuildTaskPromptOptions {
  description: string;
  agentName: string;
  agentSource: string;
  prompt: string;
  cwd: string;
  forkContext?: boolean;
}

export function buildTaskPrompt(options: BuildTaskPromptOptions): string {
  const parts = [
    `# Task: ${options.description}`,
    "",
    "## Agent",
    `${options.agentName} (${options.agentSource})`,
    "",
    "## Instructions",
    options.prompt,
    "",
    "## Working Directory",
    options.cwd,
    "",
    TASK_PROMPT_INSTRUCTIONS,
  ];

  if (options.forkContext) {
    parts.push(
      "",
      `The full prior conversation from the parent agent has been shared with you in this session. Use it directly; do not ask for information that is already present in the history.`,
    );
  }

  return parts.join("\n");
}
