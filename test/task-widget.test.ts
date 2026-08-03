import { strict as assert } from "node:assert";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderTaskWidget,
  sanitizeWidgetText,
  type ThemeLike,
  type WidgetTask,
} from "../src/task-widget.js";

const NOW = 1_750_000_000_000;

function backgroundTask(overrides: Partial<WidgetTask> = {}): WidgetTask {
  return {
    agentType: "worker",
    startedAt: NOW - 697_000,
    toolUses: 72,
    recentCalls: [],
    ...overrides,
  };
}

test("sanitizeWidgetText removes terminal controls and collapses whitespace", () => {
  assert.equal(
    sanitizeWidgetText("  first\nsecond\t\x1b[31mred\x1b[0m\u0000  "),
    "first second red",
  );
});

test("background widget renders multiline bash details as one logical line", () => {
  const command = [
    "python3 - <<'PY'",
    "from pathlib import Path",
    "path = Path('codewiki/_binary_v2/discovery.py')",
    "PY",
  ].join("\n");
  const task = backgroundTask({
    recentCalls: [
      {
        id: "call-72",
        name: "bash",
        detail: command,
        status: "done",
      },
    ],
  });

  const lines = renderTaskWidget({
    foregroundTasks: [],
    backgroundTasks: [["msdc7fhr-d097", task]],
    foregroundCount: 0,
    backgroundCount: 1,
    width: 120,
    now: NOW,
  });

  assert.ok(lines[0]?.includes("python3 - <<'PY' from pathlib import Path"));
  for (const line of lines) {
    assert.doesNotMatch(line, /[\r\n]/, "each array entry is one terminal row");
  }
});

test("widget sanitizes all dynamic labels and respects render width", () => {
  const task = backgroundTask({
    agentType: "wor\nker\x1b[2J",
    description: "first line\r\nsecond line",
    recentCalls: [
      {
        id: "call-controls",
        name: "ba\tsh",
        detail: "one\ntwo\x1b]2;bad title\u0007three",
        status: "in_progress",
      },
    ],
  });
  const theme: ThemeLike = {
    fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
  };

  for (const width of [20, 80, 120]) {
    const lines = renderTaskWidget({
      foregroundTasks: [["foreground", task]],
      backgroundTasks: [["id\nwith-break", task]],
      foregroundCount: 1,
      backgroundCount: 1,
      width,
      theme,
      now: NOW,
    });

    for (const line of lines) {
      assert.doesNotMatch(line, /[\r\n]/, "rendered rows contain no line breaks");
      assert.ok(
        visibleWidth(line) <= width,
        `line width ${visibleWidth(line)} exceeds ${width}`,
      );
    }
  }
});
