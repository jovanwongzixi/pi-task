import { strict as assert } from "node:assert";
import test from "node:test";
import {
  selectSubagentBackend,
  type SubagentPaneBackend,
} from "../src/subagent/backend.js";
import {
  HerdrBackend,
  parseHerdrPanes,
  parseSplitHerdrPaneId,
} from "../src/subagent/herdr.js";
import { TmuxBackend } from "../src/subagent/tmux.js";

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

test("Herdr spawn lists, splits, and runs with exact command arguments", () => {
  const calls: string[][] = [];
  const backend = new HerdrBackend((args) => {
    calls.push(args);
    if (args[1] === "list") {
      return JSON.stringify({
        result: { panes: [{ pane_id: "parent-1", focused: true }] },
      });
    }
    if (args[1] === "split") {
      return JSON.stringify({ result: { pane: { pane_id: "child-1" } } });
    }
    return "";
  });

  assert.deepEqual(
    backend.spawn({ cwd: "/repo with spaces", command: "pi --name worker" }),
    { paneId: "child-1", originalPane: "parent-1" },
  );
  assert.deepEqual(calls, [
    ["pane", "list"],
    [
      "pane",
      "split",
      "parent-1",
      "--direction",
      "right",
      "--cwd",
      "/repo with spaces",
      "--no-focus",
    ],
    ["pane", "run", "child-1", "pi --name worker"],
  ]);
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

test("Herdr exists, kill, and steer construct expected commands", () => {
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
  backend.kill("child-1");
  backend.kill();
  backend.steer("child-2", "continue with 'quotes'");

  assert.deepEqual(calls, [
    ["pane", "list"],
    ["pane", "list"],
    ["pane", "close", "child-1"],
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
