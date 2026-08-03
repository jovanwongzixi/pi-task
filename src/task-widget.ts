import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { ToolCallRecord } from "./helpers.js";
import { formatMs } from "./helpers.js";

export interface WidgetTask {
  agentType: string;
  description?: string;
  startedAt: number;
  toolUses: number;
  recentCalls?: ToolCallRecord[];
}

export interface ThemeLike {
  fg(color: string, text: string): string;
}

export const TASK_WIDGET_RENDER_MS = 80;

const SPINNER_FRAMES = [
  "\u280B",
  "\u2819",
  "\u2838",
  "\u2834",
  "\u2826",
  "\u2827",
  "\u2807",
  "\u280F",
];
const MAX_TOOL_LINES = 12;
const MAX_BACKGROUND_LINES = 8;
const MAX_WIDTH = 120;
const TREE_MIDDLE = "\u251C\u2500"; // ├─
const TREE_LAST = "\u2514\u2500"; // └─
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;

/** Convert session- and user-sourced values into safe single-line widget text. */
export function sanitizeWidgetText(text: string): string {
  return stripVTControlCharacters(text)
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateWidgetLine(line: string, maxWidth: number): string {
  // Theme functions may add ANSI codes, so enforce the line invariant without
  // stripping valid styling after dynamic values have already been sanitized.
  return truncateToWidth(line.replace(/[\r\n]+/g, " "), maxWidth);
}

function color(
  theme: ThemeLike | null | undefined,
  token: string,
  text: string,
): string {
  return theme?.fg ? theme.fg(token, text) : text;
}

function toolStatusMark(
  theme: ThemeLike | null | undefined,
  status: ToolCallRecord["status"] | undefined,
  spinner: string,
): string {
  switch (status) {
    case "done":
      return color(theme, "success", "\u2713");
    case "error":
      return color(theme, "error", "\u2717");
    case "in_progress":
    default:
      return color(theme, "accent", spinner);
  }
}

function formatToolCount(count: number): string {
  return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function formatLatestTool(
  task: WidgetTask,
  spinner: string,
  theme: ThemeLike | null | undefined,
): string {
  const latest = task.recentCalls?.at(-1);
  if (!latest) {
    return `${toolStatusMark(theme, "in_progress", spinner)} ${color(theme, "dim", "waiting")}`;
  }

  const latestName = sanitizeWidgetText(latest.name);
  const latestDetail = sanitizeWidgetText(latest.detail);
  const detail = latestDetail ? ` ${latestDetail}` : "";
  return (
    `${toolStatusMark(theme, latest.status, spinner)} ` +
    color(theme, "text", latestName) +
    color(theme, "dim", detail)
  );
}

function renderForegroundTask(
  task: WidgetTask,
  now: number,
  maxWidth: number,
  spinner: string,
  theme: ThemeLike | null | undefined,
): string[] {
  const safeAgentType = sanitizeWidgetText(task.agentType);
  const agentName =
    safeAgentType.charAt(0).toUpperCase() + safeAgentType.slice(1);
  const elapsed = formatMs(now - task.startedAt);
  const safeDescription = sanitizeWidgetText(task.description ?? "");
  const description = safeDescription ? ` — ${safeDescription}` : "";
  const lines: string[] = [];

  const header =
    color(theme, "accent", spinner) +
    " " +
    color(theme, "toolTitle", agentName) +
    color(theme, "dim", description) +
    color(theme, "dim", "  \u2022 ") +
    color(theme, "warning", elapsed) +
    (task.toolUses > 0
      ? color(theme, "dim", " \u2022 ") +
        color(theme, "success", formatToolCount(task.toolUses))
      : "");
  lines.push(truncateWidgetLine(header, maxWidth));

  const recent = task.recentCalls ?? [];
  const slice = recent.slice(-MAX_TOOL_LINES);
  slice.forEach((tc, idx) => {
    const connector = idx === slice.length - 1 ? TREE_LAST : TREE_MIDDLE;
    const toolName = sanitizeWidgetText(tc.name);
    const toolDetail = sanitizeWidgetText(tc.detail);
    const detail = toolDetail ? `  ${toolDetail}` : "";
    const line =
      "  " +
      color(theme, "dim", connector) +
      " " +
      toolStatusMark(theme, tc.status, spinner) +
      " " +
      color(theme, "text", toolName) +
      color(theme, "dim", detail);
    lines.push(truncateWidgetLine(line, maxWidth));
  });

  return lines;
}

function renderBackgroundLine(
  id: string,
  task: WidgetTask,
  now: number,
  maxWidth: number,
  spinner: string,
  theme: ThemeLike | null | undefined,
): string {
  const elapsed = formatMs(now - task.startedAt);
  const latest = formatLatestTool(task, spinner, theme);
  const agentType = sanitizeWidgetText(task.agentType);
  const taskId = sanitizeWidgetText(id);
  const line =
    color(theme, "dim", "- ") +
    color(theme, "toolTitle", agentType) +
    color(theme, "dim", " \u00b7 ") +
    color(theme, "accent", taskId) +
    color(theme, "dim", " \u00b7 ") +
    color(theme, "warning", elapsed) +
    color(theme, "dim", " \u00b7 ") +
    color(theme, "success", formatToolCount(task.toolUses)) +
    color(theme, "dim", " \u00b7 ") +
    latest;
  return truncateWidgetLine(line, maxWidth);
}

export function renderTaskWidget(params: {
  foregroundTasks: Iterable<[string, WidgetTask]>;
  backgroundTasks: Iterable<[string, WidgetTask]>;
  foregroundCount: number;
  backgroundCount: number;
  width: number;
  theme?: ThemeLike | null;
  now?: number;
}): string[] {
  const {
    foregroundTasks,
    backgroundTasks,
    foregroundCount,
    backgroundCount,
    width,
    theme,
  } = params;
  if (foregroundCount === 0 && backgroundCount === 0) return [];

  const now = params.now ?? Date.now();
  const maxWidth = Math.min(width, MAX_WIDTH);
  const tick = Math.floor(now / TASK_WIDGET_RENDER_MS);
  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
  const lines: string[] = [];

  for (const [, task] of foregroundTasks) {
    lines.push(...renderForegroundTask(task, now, maxWidth, spinner, theme));
    lines.push("");
  }

  const renderedBackground: Array<[string, WidgetTask]> = [];
  for (const entry of backgroundTasks) {
    if (renderedBackground.length >= MAX_BACKGROUND_LINES) break;
    renderedBackground.push(entry);
  }

  for (const [id, task] of renderedBackground) {
    lines.push(renderBackgroundLine(id, task, now, maxWidth, spinner, theme));
  }

  const hidden = backgroundCount - renderedBackground.length;
  if (hidden > 0) {
    lines.push(
      truncateWidgetLine(
        color(theme, "dim", `+ ${hidden} more background tasks`),
        maxWidth,
      ),
    );
  }

  // Keep a little breathing room above the editor.
  lines.push("");

  return lines;
}
