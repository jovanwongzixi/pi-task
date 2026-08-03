import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readRegistry, updateRegistry, writeRegistry } from "../src/conversation.js";
import {
  classifyOwnership,
  currentTaskOwner,
  isAdoptable,
  stampOwner,
  type TaskOwner,
} from "../src/ownership.js";
import { restoreActiveBackgroundTasks } from "../src/lifecycle/restore.js";
import type { SubagentPaneBackend } from "../src/subagent/backend.js";
import type { BackgroundTask, RegistryEntry } from "../src/types.js";

function makeEntry(
  overrides: Partial<RegistryEntry> & Pick<RegistryEntry, "id">,
): RegistryEntry {
  return {
    agentType: "researcher",
    description: "d",
    sessionName: "task-researcher-1",
    startedAt: Date.now(),
    piDir: "/workspace/.pi",
    dir: "/workspace/.pi/artifacts",
    paneId: "%1",
    backend: "tmux",
    ...overrides,
  };
}

const alive = () => {};
const dead = () => {
  const error = new Error("no such process") as NodeJS.ErrnoException;
  error.code = "ESRCH";
  throw error;
};

test("own tasks are classified as self", () => {
  const owner = currentTaskOwner("/workspace");
  const entry = stampOwner(makeEntry({ id: "a" }), owner);
  assert.equal(classifyOwnership(entry, owner), "self");
  assert.equal(isAdoptable(entry, owner), true);
});

test("a live pi process in another workspace keeps its tasks", () => {
  const other: TaskOwner = {
    pid: 4242,
    startedAt: Date.now() - 60_000,
    cwd: "/other-workspace",
  };
  const entry = stampOwner(makeEntry({ id: "b" }), other);
  const us = currentTaskOwner("/workspace");
  assert.equal(classifyOwnership(entry, us, alive), "foreign");
  assert.equal(isAdoptable(entry, us, alive), false);
});

test("a dead owner in this workspace is reclaimable", () => {
  const us = currentTaskOwner("/workspace");
  const previous: TaskOwner = {
    pid: 4242,
    startedAt: Date.now() - 60_000,
    cwd: "/workspace",
  };
  const entry = stampOwner(makeEntry({ id: "c" }), previous);
  assert.equal(classifyOwnership(entry, us, dead), "orphan");
});

test("a dead owner from another workspace stays foreign", () => {
  const us = currentTaskOwner("/workspace");
  const previous: TaskOwner = {
    pid: 4242,
    startedAt: Date.now() - 60_000,
    cwd: "/other-workspace",
  };
  const entry = stampOwner(makeEntry({ id: "d" }), previous);
  assert.equal(classifyOwnership(entry, us, dead), "foreign");
});

test("a recycled PID is not mistaken for us", () => {
  const us = currentTaskOwner("/workspace");
  const entry = makeEntry({
    id: "e",
    ownerPid: us.pid,
    ownerStartedAt: us.startedAt - 3_600_000,
    ownerCwd: "/other-workspace",
  });
  assert.equal(classifyOwnership(entry, us, alive), "foreign");
});

test("unstamped legacy entries are claimed only inside this workspace", () => {
  const us = currentTaskOwner("/workspace");
  assert.equal(
    classifyOwnership(
      makeEntry({ id: "f", dir: "/workspace/.pi/artifacts" }),
      us,
    ),
    "orphan",
  );
  assert.equal(
    classifyOwnership(
      makeEntry({
        id: "g",
        dir: "/other-workspace/.pi/artifacts",
        piDir: "/other-workspace/.pi",
      }),
      us,
    ),
    "foreign",
  );
});

test("restore skips foreign tasks and leaves their entries in place", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-registry-"));
  try {
    const artifacts = join(piDir, "artifacts");
    mkdirSync(artifacts);

    const us = currentTaskOwner(piDir);
    const foreignOwner: TaskOwner = {
      pid: process.pid,
      // Far enough from our start time to be a different process.
      startedAt: us.startedAt - 3_600_000,
      cwd: piDir,
    };

    writeRegistry(piDir, [
      stampOwner(makeEntry({ id: "mine", dir: artifacts, piDir }), us),
      stampOwner(
        makeEntry({ id: "theirs", dir: artifacts, piDir, paneId: "%9" }),
        foreignOwner,
      ),
      // Ours, but its pane is gone: stale, safe to prune.
      stampOwner(
        makeEntry({ id: "mine-stale", dir: artifacts, piDir, paneId: "%7" }),
        us,
      ),
    ]);

    const backend: SubagentPaneBackend = {
      name: "tmux",
      available: () => true,
      exists: (paneId: string) => paneId !== "%7",
      spawn: () => {
        throw new Error("not used");
      },
      finalize: () => {},
      kill: () => {},
      steer: () => {},
    } as unknown as SubagentPaneBackend;

    const tasks = new Map<string, BackgroundTask>();
    restoreActiveBackgroundTasks(piDir, tasks, [backend], us);

    assert.deepEqual([...tasks.keys()], ["mine"]);

    const ids = readRegistry(piDir).map((entry) => entry.id);
    assert.ok(ids.includes("theirs"), "foreign entry must survive restore");
    assert.ok(!ids.includes("mine-stale"), "our stale entry is pruned");
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
});

test("updateRegistry does not clobber a concurrently added entry", () => {
  const piDir = mkdtempSync(join(tmpdir(), "pi-task-registry-"));
  try {
    writeRegistry(piDir, [makeEntry({ id: "one" })]);
    updateRegistry(piDir, (entries) => [...entries, makeEntry({ id: "two" })]);
    updateRegistry(piDir, (entries) =>
      entries.filter((entry) => entry.id !== "one"),
    );
    assert.deepEqual(
      readRegistry(piDir).map((entry) => entry.id),
      ["two"],
    );
  } finally {
    rmSync(piDir, { recursive: true, force: true });
  }
});
