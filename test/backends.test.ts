import { strict as assert } from "node:assert";
import test from "node:test";
import {
  selectSubagentBackend,
  type SubagentPaneBackend,
} from "../src/subagent/backend.js";
import {
  chooseHerdrSplitDirection,
  HerdrBackend,
  parseCreatedHerdrTab,
  parseHerdrLayoutPanes,
  parseHerdrPanes,
  parseHerdrTabs,
  parseSplitHerdrPaneId,
  selectLargestHerdrLayoutPane,
  sortHerdrLayoutPanesForAssignment,
} from "../src/subagent/herdr.js";
import { TmuxBackend } from "../src/subagent/tmux.js";

type SubagentOutcome =
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "tracking-error";

type LifecyclePaneBackend = {
  finalize(
    paneId: string | undefined,
    originalPane: string | null | undefined,
    outcome: SubagentOutcome,
  ): void;
  rollbackSpawn(paneId?: string): void;
};

type HerdrBackendContract = HerdrBackend & LifecyclePaneBackend;
type TmuxBackendContract = TmuxBackend & LifecyclePaneBackend;

interface SimulatedHerdrPane {
  paneId: string;
  tabId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function hasCall(calls: string[][], expected: string[]): boolean {
  return calls.some((call) => arrayEqual(call, expected));
}

function arrayEqual(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function herdrBackend(command: (args: string[]) => string): HerdrBackendContract {
  return new HerdrBackend(command) as HerdrBackendContract;
}

function tmuxBackend(
  command: (args: string[], input?: string) => string,
): TmuxBackendContract {
  return new TmuxBackend(command) as TmuxBackendContract;
}

function layoutResponse(panes: readonly SimulatedHerdrPane[]): string {
  return JSON.stringify({
    result: {
      layout: {
        panes: panes.map((pane) => ({
          pane_id: pane.paneId,
          x: pane.x,
          y: pane.y,
          width: pane.width,
          height: pane.height,
        })),
      },
    },
  });
}

function splitSimulatedPane(
  panes: SimulatedHerdrPane[],
  paneId: string,
  newPaneId: string,
  direction: "right" | "down",
): void {
  const pane = panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) throw new Error(`Cannot split missing pane ${paneId}`);

  if (direction === "right") {
    const leftWidth = Math.floor(pane.width / 2);
    const rightWidth = pane.width - leftWidth;
    const rightX = pane.x + leftWidth;
    pane.width = leftWidth;
    panes.push({
      paneId: newPaneId,
      tabId: pane.tabId,
      x: rightX,
      y: pane.y,
      width: rightWidth,
      height: pane.height,
    });
    return;
  }

  const topHeight = Math.floor(pane.height / 2);
  const bottomHeight = pane.height - topHeight;
  const bottomY = pane.y + topHeight;
  pane.height = topHeight;
  panes.push({
    paneId: newPaneId,
    tabId: pane.tabId,
    x: pane.x,
    y: bottomY,
    width: pane.width,
    height: bottomHeight,
  });
}

function simulatedBatchHerdr(options: {
  calls: string[][];
  initialWidth?: number;
  initialHeight?: number;
  onCall?: (args: string[], panes: SimulatedHerdrPane[]) => string | undefined;
}): HerdrBackendContract {
  const panes: SimulatedHerdrPane[] = [];
  let createCount = 0;
  let splitCount = 0;
  return herdrBackend((args) => {
    options.calls.push(args);
    const overridden = options.onCall?.(args, panes);
    if (overridden !== undefined) return overridden;

    if (arrayEqual(args, ["pane", "list"])) {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: "parent-1",
              tab_id: "tab-main",
              workspace_id: "workspace-1",
              focused: true,
            },
            ...panes.map((pane) => ({
              pane_id: pane.paneId,
              tab_id: pane.tabId,
              workspace_id: "workspace-1",
              focused: false,
            })),
          ],
        },
      });
    }
    if (arrayEqual(args, ["tab", "list", "--workspace", "workspace-1"])) {
      return JSON.stringify({
        result: {
          tabs: [...new Set(panes.map((pane) => pane.tabId))].map(
            (tabId, index) => ({
              tab_id: tabId,
              workspace_id: "workspace-1",
              label: `Agents ${index + 1}`,
              pane_count: panes.filter((pane) => pane.tabId === tabId).length,
            }),
          ),
        },
      });
    }
    if (args[0] === "tab" && args[1] === "create") {
      createCount++;
      const tabId = `tab-agents-${createCount}`;
      const rootPaneId = `agent-root-${createCount}`;
      panes.push({
        paneId: rootPaneId,
        tabId,
        x: 0,
        y: 0,
        width: options.initialWidth ?? 160,
        height: options.initialHeight ?? 80,
      });
      return JSON.stringify({
        result: {
          tab: { tab_id: tabId, workspace_id: "workspace-1" },
          root_pane: { pane_id: rootPaneId, tab_id: tabId },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "layout") {
      return layoutResponse(panes);
    }
    if (args[0] === "pane" && args[1] === "split") {
      splitCount++;
      const newPaneId = `agent-child-${splitCount + 1}`;
      splitSimulatedPane(
        panes,
        args[2] as string,
        newPaneId,
        args[4] as "right" | "down",
      );
      return JSON.stringify({ result: { pane: { pane_id: newPaneId } } });
    }
    if (args[0] === "pane" && args[1] === "rename") return "";
    if (args[0] === "pane" && args[1] === "run") return "";
    if (args[0] === "pane" && args[1] === "close") {
      const index = panes.findIndex((pane) => pane.paneId === args[2]);
      if (index >= 0) panes.splice(index, 1);
      return "";
    }
    throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
  });
}

function fakeBackend(
  name: "herdr" | "tmux",
  isAvailable: boolean,
  availabilityCalls: string[],
): SubagentPaneBackend {
  return {
    name,
    available() {
      availabilityCalls.push(name);
      return isAvailable;
    },
    spawn() {
      return { paneId: `%${name}`, originalPane: null };
    },
    exists() {
      return false;
    },
    finalize() {},
    rollbackSpawn() {},
    kill() {},
    steer() {},
  };
}

test("auto selection prefers herdr regardless of backend array order", () => {
  const calls: string[] = [];
  const tmux = fakeBackend("tmux", true, calls);
  const herdr = fakeBackend("herdr", true, calls);

  const selected = selectSubagentBackend("auto", [tmux, herdr]);

  assert.equal(selected.name, "herdr");
  assert.equal(selected.paneBackend, herdr);
  assert.deepEqual(calls, ["herdr"]);
});

test("auto selection falls back from unavailable herdr to tmux", () => {
  const calls: string[] = [];
  const herdr = fakeBackend("herdr", false, calls);
  const tmux = fakeBackend("tmux", true, calls);

  const selected = selectSubagentBackend("auto", [herdr, tmux]);

  assert.equal(selected.name, "tmux");
  assert.equal(selected.paneBackend, tmux);
  assert.deepEqual(calls, ["herdr", "tmux"]);
});

test("auto selection falls back to sdk when no pane backend is available", () => {
  const calls: string[] = [];
  const selected = selectSubagentBackend("auto", [
    fakeBackend("herdr", false, calls),
    fakeBackend("tmux", false, calls),
  ]);

  assert.deepEqual(selected, { name: "sdk" });
  assert.deepEqual(calls, ["herdr", "tmux"]);
});

test("explicit backend selection returns only the requested backend", () => {
  const calls: string[] = [];
  const herdr = fakeBackend("herdr", true, calls);
  const tmux = fakeBackend("tmux", true, calls);

  const selected = selectSubagentBackend("tmux", [herdr, tmux]);

  assert.equal(selected.name, "tmux");
  assert.equal(selected.paneBackend, tmux);
  assert.deepEqual(calls, ["tmux"]);
});

test("explicit unavailable or missing pane backend throws", () => {
  const calls: string[] = [];
  assert.throws(
    () =>
      selectSubagentBackend("herdr", [
        fakeBackend("herdr", false, calls),
      ]),
    /Requested herdr backend is unavailable/,
  );
  assert.throws(
    () =>
      selectSubagentBackend("tmux", [
        fakeBackend("herdr", true, calls),
      ]),
    /Requested tmux backend is unavailable/,
  );
});

test("explicit sdk selection does not inspect pane backends", () => {
  const calls: string[] = [];
  assert.deepEqual(
    selectSubagentBackend("sdk", [fakeBackend("herdr", true, calls)]),
    { name: "sdk" },
  );
  assert.deepEqual(calls, []);
});

test("Herdr JSON parsers extract panes and split pane id", () => {
  assert.deepEqual(
    parseHerdrPanes(
      JSON.stringify({
        result: {
          panes: [
            { pane_id: "parent", focused: true },
            { pane_id: "child", focused: false },
          ],
        },
      }),
    ),
    [
      { pane_id: "parent", focused: true },
      { pane_id: "child", focused: false },
    ],
  );
  assert.deepEqual(parseHerdrPanes(JSON.stringify({ result: {} })), []);
  assert.equal(
    parseSplitHerdrPaneId(
      JSON.stringify({ result: { pane: { pane_id: "child" } } }),
    ),
    "child",
  );
});

test("Herdr JSON parsers reject malformed responses", () => {
  assert.throws(() => parseHerdrPanes("not-json"), /invalid JSON/);
  assert.throws(
    () => parseSplitHerdrPaneId(JSON.stringify({ result: { pane: {} } })),
    /did not return result\.pane\.pane_id/,
  );
});

test("Herdr JSON parsers extract tab create, tab list, and pane layout responses", () => {
  assert.deepEqual(
    parseCreatedHerdrTab(
      JSON.stringify({
        result: {
          tab: {
            tab_id: "tab-agents-1",
            workspace_id: "workspace-1",
            label: "Agents 1",
          },
          root_pane: {
            pane_id: "root-pane-1",
            tab_id: "tab-agents-1",
          },
        },
      }),
    ),
    { tabId: "tab-agents-1", rootPaneId: "root-pane-1" },
  );
  assert.deepEqual(
    parseHerdrTabs(
      JSON.stringify({
        result: {
          tabs: [
            {
              tab_id: "tab-main",
              workspace_id: "workspace-1",
              label: "Main",
              pane_count: 1,
            },
            {
              tab_id: "tab-agents-2",
              workspace_id: "workspace-1",
              label: "Agents 2",
              pane_count: 3,
            },
          ],
        },
      }),
    ),
    [
      {
        tab_id: "tab-main",
        workspace_id: "workspace-1",
        label: "Main",
        pane_count: 1,
      },
      {
        tab_id: "tab-agents-2",
        workspace_id: "workspace-1",
        label: "Agents 2",
        pane_count: 3,
      },
    ],
  );
  assert.deepEqual(
    (() => {
      const panes = parseHerdrLayoutPanes(
        JSON.stringify({
          result: {
            layout: {
              panes: [
                { pane_id: "pane-small", x: 0, y: 0, width: 80, height: 24 },
                { pane_id: "pane-large", x: 80, y: 0, width: 120, height: 48 },
              ],
            },
          },
        }),
      );
      assert.equal(selectLargestHerdrLayoutPane(panes).paneId, "pane-large");
      return panes;
    })(),
    [
      { paneId: "pane-small", x: 0, y: 0, width: 80, height: 24, area: 1920 },
      {
        paneId: "pane-large",
        x: 80,
        y: 0,
        width: 120,
        height: 48,
        area: 5760,
      },
    ],
  );
});

test("Herdr layout assignment order is top-to-bottom then left-to-right", () => {
  assert.deepEqual(
    sortHerdrLayoutPanesForAssignment([
      { paneId: "bottom-left", x: 0, y: 40, width: 40, height: 20, area: 800 },
      { paneId: "top-right", x: 80, y: 0, width: 40, height: 20, area: 800 },
      { paneId: "top-left", x: 0, y: 0, width: 40, height: 20, area: 800 },
    ]).map((pane) => pane.paneId),
    ["top-left", "top-right", "bottom-left"],
  );
});

test("Herdr split direction uses width >= 2 * height for right splits", () => {
  assert.equal(chooseHerdrSplitDirection(120, 60), "right");
  assert.equal(chooseHerdrSplitDirection(119, 60), "down");
  assert.equal(chooseHerdrSplitDirection(80, 80), "down");
});

test("Herdr spawn creates a new task tab for the first task in a wave", () => {
  const calls: string[][] = [];
  const backend = herdrBackend((args) => {
    calls.push(args);
    if (arrayEqual(args, ["pane", "list"])) {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: "parent-1",
              tab_id: "tab-main",
              workspace_id: "workspace-1",
              focused: true,
            },
          ],
        },
      });
    }
    if (arrayEqual(args, ["tab", "list", "--workspace", "workspace-1"])) {
      return JSON.stringify({ result: { tabs: [] } });
    }
    if (args[0] === "tab" && args[1] === "create") {
      return JSON.stringify({
        result: {
          tab: {
            tab_id: "tab-agents-1",
            workspace_id: "workspace-1",
            label: "Agents 1",
          },
          root_pane: {
            pane_id: "agent-root-1",
            tab_id: "tab-agents-1",
            workspace_id: "workspace-1",
          },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "rename") return "";
    if (arrayEqual(args, ["pane", "run", "agent-root-1", "pi --name first"])) {
      return "";
    }
    throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
  });

  assert.deepEqual(
    backend.spawn({ cwd: "/repo with spaces", command: "pi --name first" }),
    { paneId: "agent-root-1", originalPane: "parent-1" },
  );
  assert.equal(
    hasCall(calls, [
      "tab",
      "create",
      "--workspace",
      "workspace-1",
      "--cwd",
      "/repo with spaces",
      "--label",
      "Agents 1",
      "--no-focus",
    ]),
    true,
  );
  assert.equal(
    hasCall(calls, ["pane", "run", "agent-root-1", "pi --name first"]),
    true,
  );
  assert.equal(calls.some((call) => call[1] === "split"), false);
});

test("Herdr spawn reuses an active wave tab and splits the largest pane at ratio 0.5", () => {
  const calls: string[][] = [];
  let createdFirstTab = false;
  const backend = herdrBackend((args) => {
    calls.push(args);
    if (arrayEqual(args, ["pane", "list"])) {
      const panes = [
        {
          pane_id: "parent-1",
          tab_id: "tab-main",
          workspace_id: "workspace-1",
          focused: true,
        },
      ];
      if (createdFirstTab) {
        panes.push({
          pane_id: "agent-root-1",
          tab_id: "tab-agents-1",
          workspace_id: "workspace-1",
          focused: false,
        });
      }
      return JSON.stringify({
        result: {
          panes,
        },
      });
    }
    if (arrayEqual(args, ["tab", "list", "--workspace", "workspace-1"])) {
      return JSON.stringify({
        result: {
          tabs: createdFirstTab
            ? [
                {
                  tab_id: "tab-agents-1",
                  workspace_id: "workspace-1",
                  label: "Agents 1",
                  pane_count: 1,
                },
              ]
            : [],
        },
      });
    }
    if (args[0] === "tab" && args[1] === "create") {
      createdFirstTab = true;
      return JSON.stringify({
        result: {
          tab: { tab_id: "tab-agents-1", workspace_id: "workspace-1" },
          root_pane: { pane_id: "agent-root-1", tab_id: "tab-agents-1" },
        },
      });
    }
    if (arrayEqual(args, ["pane", "layout", "--pane", "agent-root-1"])) {
      return JSON.stringify({
        result: {
          layout: {
            panes: [
              { pane_id: "small-pane", x: 0, y: 0, width: 80, height: 30 },
              { pane_id: "largest-pane", x: 80, y: 0, width: 160, height: 40 },
            ],
          },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "split") {
      return JSON.stringify({ result: { pane: { pane_id: "agent-child-2" } } });
    }
    if (args[0] === "pane" && args[1] === "rename") return "";
    if (args[0] === "pane" && args[1] === "run") return "";
    return "";
  });

  assert.deepEqual(
    backend.spawn({ cwd: "/repo", command: "pi --name first" }),
    { paneId: "agent-root-1", originalPane: "parent-1" },
  );
  assert.deepEqual(
    backend.spawn({ cwd: "/repo", command: "pi --name second" }),
    { paneId: "agent-child-2", originalPane: "parent-1" },
  );
  assert.equal(
    hasCall(calls, [
      "pane",
      "split",
      "largest-pane",
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      "/repo",
      "--no-focus",
    ]),
    true,
  );
  assert.equal(
    hasCall(calls, ["pane", "run", "agent-child-2", "pi --name second"]),
    true,
  );
});

test("Herdr starts a new tab after all tasks in the previous wave finalize", () => {
  const calls: string[][] = [];
  let tabCreateCount = 0;
  const backend = herdrBackend((args) => {
    calls.push(args);
    if (arrayEqual(args, ["pane", "list"])) {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: "parent-1",
              tab_id: "tab-main",
              workspace_id: "workspace-1",
              focused: true,
            },
          ],
        },
      });
    }
    if (arrayEqual(args, ["tab", "list", "--workspace", "workspace-1"])) {
      return JSON.stringify({
        result: {
          tabs: [
            {
              tab_id: "tab-agents-1",
              workspace_id: "workspace-1",
              label: "Agents 1",
              pane_count: 1,
            },
          ],
        },
      });
    }
    if (args[0] === "tab" && args[1] === "create") {
      tabCreateCount++;
      return JSON.stringify({
        result: {
          tab: {
            tab_id: `tab-agents-${tabCreateCount}`,
            workspace_id: "workspace-1",
          },
          root_pane: {
            pane_id: `agent-root-${tabCreateCount}`,
            tab_id: `tab-agents-${tabCreateCount}`,
          },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "rename") return "";
    if (args[0] === "pane" && args[1] === "run") return "";
    return "";
  });

  const first = backend.spawn({ cwd: "/repo", command: "pi --name first" });
  backend.finalize(first.paneId, first.originalPane, "completed");
  const second = backend.spawn({ cwd: "/repo", command: "pi --name second" });

  assert.deepEqual(first, { paneId: "agent-root-1", originalPane: "parent-1" });
  assert.deepEqual(second, { paneId: "agent-root-2", originalPane: "parent-1" });
  assert.equal(
    calls.filter((call) => call[0] === "tab" && call[1] === "create").length,
    2,
  );
  assert.equal(hasCall(calls, ["pane", "close", "agent-root-1"]), false);
});

test("Herdr finalize retains completed and failed panes", () => {
  for (const outcome of ["completed", "failed"] as const) {
    const calls: string[][] = [];
    const backend = herdrBackend((args) => {
      calls.push(args);
      return "";
    });

    backend.finalize("agent-pane", "parent-pane", outcome);

    assert.equal(hasCall(calls, ["pane", "close", "agent-pane"]), false);
    assert.equal(
      hasCall(calls, ["pane", "send-keys", "agent-pane", "ctrl+c"]),
      false,
    );
  }
});

test("Herdr finalize sends Ctrl+C but does not close for interrupted outcomes", () => {
  for (const outcome of ["timeout", "cancelled", "tracking-error"] as const) {
    const calls: string[][] = [];
    const backend = herdrBackend((args) => {
      calls.push(args);
      if (arrayEqual(args, ["pane", "list"])) {
        return JSON.stringify({
          result: { panes: [{ pane_id: "agent-pane" }] },
        });
      }
      return "";
    });

    backend.finalize("agent-pane", "parent-pane", outcome);

    assert.equal(
      hasCall(calls, ["pane", "send-keys", "agent-pane", "ctrl+c"]),
      true,
    );
    assert.equal(hasCall(calls, ["pane", "close", "agent-pane"]), false);
  }
});

test("Herdr rollback closes a pane created by a failed spawn", () => {
  const calls: string[][] = [];
  const backend = herdrBackend((args) => {
    calls.push(args);
    return "";
  });

  backend.rollbackSpawn("agent-pane");

  assert.deepEqual(calls, [["pane", "close", "agent-pane"]]);
});

test("Herdr adopts restored active panes into the current wave", () => {
  const calls: string[][] = [];
  const backend = herdrBackend((args) => {
    calls.push(args);
    if (arrayEqual(args, ["pane", "list"])) {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: "parent-1",
              tab_id: "tab-main",
              workspace_id: "workspace-1",
              focused: true,
            },
            {
              pane_id: "restored-a",
              tab_id: "tab-restored",
              workspace_id: "workspace-1",
              focused: false,
            },
            {
              pane_id: "restored-b",
              tab_id: "tab-restored",
              workspace_id: "workspace-1",
              focused: false,
            },
          ],
        },
      });
    }
    if (arrayEqual(args, ["tab", "list", "--workspace", "workspace-1"])) {
      return JSON.stringify({
        result: {
          tabs: [
            {
              tab_id: "tab-restored",
              workspace_id: "workspace-1",
              label: "Agents 4",
              pane_count: 2,
            },
          ],
        },
      });
    }
    if (args[0] === "pane" && args[1] === "layout") {
      return JSON.stringify({
        result: {
          layout: {
            panes: [
              { pane_id: "restored-a", x: 0, y: 0, width: 80, height: 40 },
              { pane_id: "restored-b", x: 80, y: 0, width: 160, height: 40 },
            ],
          },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "split") {
      return JSON.stringify({ result: { pane: { pane_id: "agent-child-3" } } });
    }
    if (args[0] === "pane" && args[1] === "rename") return "";
    if (args[0] === "pane" && args[1] === "run") return "";
    throw new Error(`Unexpected Herdr call: ${args.join(" ")}`);
  });

  assert.equal(
    typeof backend.adoptRestoredPanes,
    "function",
    "Expected HerdrBackend.adoptRestoredPanes(entries) to adopt active restored panes",
  );
  backend.adoptRestoredPanes([
    { paneId: "restored-a", startedAt: 1 },
    { paneId: "restored-b", startedAt: 2 },
  ]);

  assert.deepEqual(
    backend.spawn({ cwd: "/repo", command: "pi --name restored-wave" }),
    { paneId: "agent-child-3", originalPane: "parent-1" },
  );
  assert.equal(
    hasCall(calls, [
      "pane",
      "split",
      "restored-b",
      "--direction",
      "right",
      "--ratio",
      "0.5",
      "--cwd",
      "/repo",
      "--no-focus",
    ]),
    true,
  );
  assert.equal(
    calls.some((call) => call[0] === "tab" && call[1] === "create"),
    false,
  );
});

test("Herdr pane label failures do not fail task launch", () => {
  const calls: string[][] = [];
  const backend = herdrBackend((args) => {
    calls.push(args);
    if (arrayEqual(args, ["pane", "list"])) {
      return JSON.stringify({
        result: {
          panes: [
            {
              pane_id: "parent-1",
              tab_id: "tab-main",
              workspace_id: "workspace-1",
              focused: true,
            },
          ],
        },
      });
    }
    if (arrayEqual(args, ["tab", "list", "--workspace", "workspace-1"])) {
      return JSON.stringify({ result: { tabs: [] } });
    }
    if (args[0] === "tab" && args[1] === "create") {
      return JSON.stringify({
        result: {
          tab: { tab_id: "tab-agents-1", workspace_id: "workspace-1" },
          root_pane: { pane_id: "agent-root-1", tab_id: "tab-agents-1" },
        },
      });
    }
    if (args[0] === "pane" && args[1] === "rename") {
      throw new Error("rename is unavailable");
    }
    if (arrayEqual(args, ["pane", "run", "agent-root-1", "pi --name worker"])) {
      return "";
    }
    return "";
  });

  assert.deepEqual(
    backend.spawn({
      cwd: "/repo",
      command: "pi --name worker",
      description: "Investigate flaky tests with a label",
    }),
    { paneId: "agent-root-1", originalPane: "parent-1" },
  );
  assert.equal(
    calls.some((call) => call[0] === "pane" && call[1] === "rename"),
    true,
  );
  assert.equal(
    hasCall(calls, ["pane", "run", "agent-root-1", "pi --name worker"]),
    true,
  );
});

test("Herdr spawn requires a focused pane", () => {
  const backend = new HerdrBackend(() =>
    JSON.stringify({ result: { panes: [{ pane_id: "unfocused" }] } }),
  );
  assert.throws(
    () => backend.spawn({ cwd: "/repo", command: "pi" }),
    /focused herdr pane/,
  );
});

test("Herdr exists and steer construct expected commands", () => {
  const calls: string[][] = [];
  const backend = new HerdrBackend((args) => {
    calls.push(args);
    if (args[1] === "list") {
      return JSON.stringify({
        result: { panes: [{ pane_id: "child-1" }, { pane_id: "child-2" }] },
      });
    }
    return "";
  });

  assert.equal(backend.exists("child-2"), true);
  assert.equal(backend.exists("missing"), false);
  backend.steer("child-2", "continue with 'quotes'");

  assert.deepEqual(calls, [
    ["pane", "list"],
    ["pane", "list"],
    ["pane", "send-text", "child-2", "continue with 'quotes'"],
    ["pane", "send-keys", "child-2", "Enter"],
  ]);
});

test("Herdr availability requires HERDR_ENV and a successful pane list", () => {
  const previous = process.env.HERDR_ENV;
  let calls = 0;
  const backend = new HerdrBackend(() => {
    calls++;
    return JSON.stringify({ result: { panes: [] } });
  });

  try {
    delete process.env.HERDR_ENV;
    assert.equal(backend.available(), false);
    assert.equal(calls, 0);

    process.env.HERDR_ENV = "1";
    assert.equal(backend.available(), true);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
});

test("Tmux finalize preserves cleanup behavior for every outcome", () => {
  for (const outcome of [
    "completed",
    "failed",
    "timeout",
    "cancelled",
    "tracking-error",
  ] as const) {
    const calls: string[][] = [];
    const backend = tmuxBackend((args) => {
      calls.push(args);
      return "";
    });

    backend.finalize("%child", "%parent", outcome);

    assert.deepEqual(calls, [
      ["kill-pane", "-t", "%child"],
      ["select-pane", "-t", "%parent"],
    ]);
  }
});

test("Tmux rollback closes a pane created by a failed spawn", () => {
  const calls: string[][] = [];
  const backend = tmuxBackend((args) => {
    calls.push(args);
    return "";
  });

  backend.rollbackSpawn("%child");

  assert.deepEqual(calls, [["kill-pane", "-t", "%child"]]);
});

test("Tmux exists checks the pane list", () => {
  const calls: string[][] = [];
  const backend = new TmuxBackend((args) => {
    calls.push(args);
    return "%1\n%20\n%3";
  });

  assert.equal(backend.exists("%20"), true);
  assert.equal(backend.exists("%2"), false);
  assert.deepEqual(calls, [
    ["list-panes", "-a", "-F", "#{pane_id}"],
    ["list-panes", "-a", "-F", "#{pane_id}"],
  ]);
});

test("Tmux availability requires a current pane", () => {
  assert.equal(
    new TmuxBackend(() => "%7").available(),
    true,
  );
  assert.equal(
    new TmuxBackend(() => {
      throw new Error("not in a tmux session");
    }).available(),
    false,
  );
});

test("Tmux spawn targets the current pane and selects split direction", () => {
  const calls: string[][] = [];
  const backend = new TmuxBackend((args) => {
    calls.push(args);
    if (args[0] === "display-message" && args.includes("#{pane_id}")) {
      return "%7";
    }
    if (args[0] === "display-message") return "200 40";
    if (args[0] === "split-window") return "%8";
    throw new Error(`Unexpected tmux call: ${args.join(" ")}`);
  });

  assert.deepEqual(
    backend.spawn({ cwd: "/repo", command: "pi --name worker" }),
    { paneId: "%8", originalPane: "%7" },
  );
  assert.deepEqual(calls, [
    ["display-message", "-p", "#{pane_id}"],
    [
      "display-message",
      "-t",
      "%7",
      "-p",
      "#{pane_width} #{pane_height}",
    ],
    [
      "split-window",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      "%7",
      "-c",
      "/repo",
      "pi --name worker",
    ],
  ]);
});
