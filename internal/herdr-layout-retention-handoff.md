# Handoff: Herdr Task Tabs, Balanced Layout, and Pane Retention

## Context

The initial Herdr backend implementation is committed on branch
`feat/herdr-backend`:

```text
52e275f feat: add isolated herdr subagent backend
```

That implementation successfully reduces Herdr subagent launch overhead to one
model-visible `task` tool call per subagent. It adds isolated `HerdrBackend` and
`TmuxBackend` classes, backend selection, backend-aware task persistence and
cleanup, and Herdr command/parsing tests.

The current Herdr behavior still loses two benefits of the earlier manual
Herdr-skill workflow:

1. subagents are split beside the orchestrator instead of being collected in a
   dedicated, readable tab;
2. completed panes are closed, preventing the human from inspecting their
   terminal history.

This follow-up should restore those benefits without changing tmux behavior.

## Confirmed decisions

### Task grouping

Treat overlapping active Herdr tasks as one launch wave:

- the first Herdr task with no active Herdr wave creates a new dedicated tab;
- later Herdr tasks started while any task in that wave remains active join the
  same tab;
- after every task in the wave reaches a terminal state, that tab becomes an
  archived inspection tab;
- the next Herdr task starts a new tab/wave.

This provides a deterministic grouping rule without requiring new parameters
or additional model-visible tool calls.

### Layout

Use balanced progressive tiling for now:

- inspect the current task-tab layout;
- select the pane with the largest visible area;
- split that pane at `0.5`;
- split right when the pane is visually wide, otherwise split down;
- keep focus on the orchestrator with `--no-focus`.

A practical terminal-cell aspect heuristic is to split right when width is at
least roughly twice the height; otherwise split down. Tests should define the
chosen threshold explicitly.

This produces a balanced grid and equal quadrants at powers of two. Exact equal
sizing for arbitrary pane counts is deferred until `task_batch` is implemented,
because independent `task` calls do not tell the first launch how many panes
will follow.

Do not use Herdr `layout.apply` to rebalance live tasks. Herdr documents that it
creates replacement panes and does not preserve live PTYs, scrollback, or
running processes.

### Pane retention

Herdr panes should remain available for human inspection after a task reaches a
terminal state.

- completed: retain the pane;
- failed: retain the pane;
- timeout: send `Ctrl+C` to stop the process, then retain the pane;
- cancelled/aborted: send `Ctrl+C` to stop the process, then retain the pane;
- internal tracking/poll failure: stop the process and retain the pane so the
  failure can be inspected;
- spawn rollback (for example, split succeeds but `pane run` fails): close the
  unusable pane.

Tmux must preserve its current behavior and continue closing task panes at the
end of their lifecycle.

## Recommended architecture

### Replace unconditional cleanup with lifecycle-aware cleanup

The shared backend currently exposes `kill()`, and `src/index.ts` calls it for
normal completion, failure, timeout, cancellation, and spawn rollback. Those
events now require different behavior.

Introduce an outcome type, for example:

```ts
export type SubagentOutcome =
  | "completed"
  | "failed"
  | "timeout"
  | "cancelled"
  | "tracking-error";
```

Replace or supplement `kill()` with lifecycle-specific operations, for example:

```ts
interface SubagentPaneBackend {
  // existing available/spawn/exists/steer operations
  finalize(
    paneId: string | undefined,
    originalPane: string | null,
    outcome: SubagentOutcome,
  ): void;
  rollbackSpawn(paneId?: string): void;
}
```

Exact method names are not important. The important constraint is that the
policy lives inside each backend class:

- `TmuxBackend.finalize()` closes the pane and restores focus, matching current
  behavior;
- `HerdrBackend.finalize()` retains normal terminal panes and interrupts only
  outcomes that may leave a process running;
- both backends may close a partially created pane during spawn rollback.

Avoid conditionals such as `if (backend === "herdr")` spread through
`src/index.ts`; backend-specific policy should remain encapsulated.

### Herdr wave/tab state

`HerdrBackend` needs transient wave state, conceptually:

```ts
interface HerdrWave {
  workspaceId: string;
  tabId: string;
  activePaneIds: Set<string>;
}
```

The backend should:

1. discover the focused parent pane and its `workspace_id`;
2. when no active wave exists, run `herdr tab create` with:
   - the parent workspace;
   - the task working directory;
   - a readable label such as `Agents 1`;
   - `--no-focus`;
3. parse `result.tab.tab_id` and `result.root_pane.pane_id`;
4. run the first subagent in that root pane;
5. for subsequent tasks, query the task tab layout, select the largest pane,
   split it using the balanced-layout heuristic, and run the task there;
6. track active pane ids;
7. remove a pane id from the active wave when its task finalizes;
8. retire the in-memory wave once its active set is empty, without closing the
   tab or its panes.

Herdr IDs can compact when panes or tabs close. Treat cached ids as live-session
references only. Revalidate the tab/panes through Herdr list/layout responses
before acting, and never treat them as durable task-session identifiers.

### Restore after extension reload

Registry entries already persist `backend` and `paneId`. During restore:

- active Herdr entries should be adopted into `HerdrBackend` wave state;
- obtain their current tab/workspace relationship from `herdr pane list` rather
  than assuming an old tab id;
- if multiple restored panes belong to the same tab, restore them as one wave;
- if the recorded pane no longer exists, keep the existing stale-task handling;
- completed retained panes are not active registry entries and should not be
  re-adopted.

If active restored tasks span multiple tabs, use the tab containing the most
recent active task for new launches, or start a fresh wave. Do not move live
restored panes merely to consolidate them.

### Labels

Use pane labels to improve inspection, ideally based on the task description
and/or agent type. Labels must be bounded to a reasonable length. Labeling
failure should not fail task launch.

Use incrementing readable tab labels (`Agents 1`, `Agents 2`, and so on) within
the parent workspace. Determine the next suffix from existing tab labels so an
extension reload does not restart at an already used label.

## Herdr CLI operations

Relevant commands:

```bash
herdr pane list
herdr tab list --workspace <workspace_id>
herdr tab create --workspace <workspace_id> --cwd <cwd> \
  --label "Agents N" --no-focus
herdr pane layout --pane <pane_id>
herdr pane split <pane_id> --direction right|down --ratio 0.5 \
  --cwd <cwd> --no-focus
herdr pane run <pane_id> <command>
herdr pane rename <pane_id> <label>
herdr pane send-keys <pane_id> ctrl+c
herdr pane close <pane_id>
```

Herdr response shapes already confirmed:

- `pane list`: `result.panes[]`, including `pane_id`, `tab_id`,
  `workspace_id`, and `focused`;
- `tab list`: `result.tabs[]`, including `tab_id`, `workspace_id`, `label`, and
  `pane_count`;
- `tab create`: documented to return `result.tab` and `result.root_pane`;
- `pane split`: `result.pane.pane_id`;
- `pane layout`: `result.layout`, containing pane rectangles and split geometry.

## Required `src/index.ts` changes

Audit every current pane cleanup call. They occur in normal completion,
foreground completion, timeout, repeated polling failure, and abort handling.
Each should call the backend lifecycle operation with the correct outcome.

Avoid duplicate finalization. The timeout and polling-failure paths currently
perform cleanup before calling `completeTask()`, which also performs cleanup.
Refactor so each task reaches backend finalization exactly once.

When restoring active tasks, notify/adopt them into the backend so Herdr can
reconstruct active wave state.

The completion checker should remain backend-neutral through the existing
`paneExists` callback. No Herdr output polling is needed. Session JSONL remains
the primary completion signal, and it is checked before pane liveness, so a
retained shell pane will not prevent completion.

## Testing requirements

Add tests for:

- parsing `tab create`, `tab list`, and `pane layout` responses;
- creating a new tab for the first task in a wave;
- reusing that tab while the wave has active tasks;
- starting a new tab after all tasks in a wave finalize;
- selecting the largest pane;
- choosing right versus down based on the aspect heuristic;
- using a `0.5` split ratio;
- retaining Herdr panes after completed/failed outcomes;
- sending `Ctrl+C` but not closing on timeout/cancel/tracking failure;
- closing a pane on spawn rollback;
- preserving tmux cleanup behavior for all outcomes;
- adopting restored active Herdr panes;
- not letting pane-label failures fail a task launch.

Run:

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

A live Herdr smoke test should create a temporary task wave, verify the tab and
balanced pane layout, allow the tasks to complete, confirm their panes remain
inspectable, and then clean up only the temporary smoke-test tab manually.

## Acceptance criteria

- one model-visible `task` call still launches one subagent;
- the first active Herdr task creates a dedicated unfocused task tab;
- overlapping Herdr tasks share that tab;
- panes are progressively arranged in a balanced grid;
- the orchestrator pane retains focus;
- completed/failed Herdr panes and scrollback remain available for inspection;
- timeout/cancel stops work without deleting its Herdr pane;
- the next non-overlapping task wave creates a new tab;
- tmux cleanup and behavior remain unchanged;
- SDK behavior remains unchanged;
- registry restore and background completion notifications still work;
- exact arbitrary-count sizing and `task_batch` remain explicitly deferred.

