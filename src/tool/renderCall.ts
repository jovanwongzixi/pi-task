import { Text } from "@earendil-works/pi-tui";

/** Render the task tool call line while the subagent is running. */
export function renderCall(args: unknown, theme: any) {
  const params = args as Record<string, unknown>;
  const isBatch = Array.isArray(params.tasks);
  const agentName = isBatch
    ? "task_batch"
    : ((params.agent_type as string) || "...");
  const desc = isBatch
    ? `${(params.tasks as any[])?.length ?? 0} tasks`
    : ((params.description as string) || "");
  const isFork = params.fork_context === true;

  let text = theme.fg("toolTitle", "");
  text += theme.fg("accent", agentName);
  if (isFork) text += theme.fg("warning", " (fork)");
  if (desc) text += theme.fg("dim", ` - ${desc}`);
  return new Text(text, 0, 0);
}
