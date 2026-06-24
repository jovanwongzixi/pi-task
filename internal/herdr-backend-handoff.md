# Handoff: Add a Herdr Backend to `pi-task`

## Problem statement

The current way an orchestrator uses the `herdr` skill to spawn subagents is too expensive in model-visible tool calls and tokens:

1. inspect panes/workspaces;
2. create tabs/panes;
3. run `pi` in each pane;
4. wait for each pane to become ready;
5. paste a prompt into each pane;
6. repeatedly poll status/output.

This is the wrong abstraction boundary. The model should not manually orchestrate panes. `pi-task` already provides the right abstraction for tmux-backed subagents: one `task` tool call starts a subagent, background tasks return immediately, and the extension later sends a completion notification back to the parent via `pi.sendMessage(... triggerTurn: true)`.

The desired herdr implementation should mirror the existing tmux behavior, but use herdr panes instead of tmux panes.

---

## Existing `pi-task` architecture to reuse

Important files:

- `src/index.ts`
  - registers the `task` tool;
  - builds prompt content;
  - creates task/session ids;
  - manages background/foreground modes;
  - maintains registry/history;
  - polls task completion internally;
  - sends completion notification to the parent agent.
- `src/subagent/tmux.ts`
  - tmux pane helpers.
- `src/subagent/waitCompletion.ts`
  - detects completion from `RESULT.md` or Pi session JSONL;
  - gates JSONL completion on `hasAgentFinished()` so streaming intermediate text is not mistaken for a final result.
- `src/session-text.ts`
  - reads matching Pi session JSONL files by `session_info.name`.
- `src/subagent/buildArgv.ts`
  - builds `pi` CLI argv for subagents.
- `src/helpers.ts`
  - agent discovery, tool allowlist, result parsing, tmux arg helpers, receipt formatting.

Current flow:

```text
task tool
  -> discover/load agent config
  -> build prompt
  -> build pi args
  -> tmux split-window + run Pi
  -> for background: return receipt immediately
  -> extension polls RESULT.md/session JSONL internally
  -> on completion: kill pane, update registry/history, send follow-up message
```

The herdr backend should preserve this exact high-level flow.

---

## Core design: backend abstraction

Refactor terminal-specific code behind a small backend interface. Existing tmux functions and new herdr functions should implement the same shape.

Suggested interface:

```ts
export type SubagentBackendName = "tmux" | "herdr" | "sdk";

export interface SpawnedSubagentPane {
  paneId?: string;
  originalPane?: string | null;
}

export interface SubagentBackend {
  name: SubagentBackendName;
  available(): boolean;

  spawn(opts: {
    cwd: string;
    command: string;
    description?: string;
  }): SpawnedSubagentPane;

  exists(paneId: string): boolean;
  kill(paneId?: string, originalPane?: string | null): void;
  steer?(paneId: string, message: string): void;
}
```

Then `src/index.ts` should select a backend instead of calling tmux helpers directly.

Recommended auto-selection order:

1. herdr, if `process.env.HERDR_ENV === "1"` and `herdr` CLI works;
2. tmux, if tmux works;
3. SDK fallback.

This order is intentional: when the parent agent is running inside herdr, herdr panes are the native UI/UX and are visible in the herdr sidebar.

Potential user-facing option:

```ts
backend?: "auto" | "herdr" | "tmux" | "sdk";
```

This is optional. A first version can use auto-selection only.

---

## Herdr backend behavior

Add `src/subagent/herdr.ts`.

It should do internally what the herdr skill currently requires the model to do manually:

1. list panes;
2. identify the focused pane as the parent/original pane;
3. split it with `--no-focus`;
4. run the full subagent command in the new pane;
5. report the new `pane_id` to the task registry.

### Herdr CLI calls

Useful commands:

```bash
herdr pane list
herdr pane split <pane_id> --direction right --no-focus
herdr pane run <pane_id> "cd <cwd> && PI_TASK_TOOL_DISABLED=1 pi ..."
herdr pane close <pane_id>
herdr pane send-text <pane_id> "..."
herdr pane send-keys <pane_id> Enter
```

`herdr pane list` returns JSON. The focused pane is the parent/original pane:

```ts
const raw = herdr(["pane", "list"]);
const json = JSON.parse(raw);
const focused = json.result.panes.find((p: any) => p.focused);
```

`herdr pane split` returns JSON with the new pane id at:

```ts
json.result.pane.pane_id
```

### Draft implementation

```ts
import { execFileSync } from "node:child_process";

function herdr(args: string[]): string {
  return execFileSync("herdr", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function hasHerdr(): boolean {
  if (process.env.HERDR_ENV !== "1") return false;
  try {
    herdr(["pane", "list"]);
    return true;
  } catch {
    return false;
  }
}

export function getFocusedHerdrPaneId(): string | null {
  try {
    const raw = herdr(["pane", "list"]);
    const json = JSON.parse(raw);
    const pane = json.result?.panes?.find((p: any) => p.focused);
    return pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

export function herdrPaneExists(paneId: string): boolean {
  try {
    const raw = herdr(["pane", "list"]);
    const json = JSON.parse(raw);
    return Boolean(json.result?.panes?.some((p: any) => p.pane_id === paneId));
  } catch {
    return false;
  }
}

export function splitHerdrPane(
  cwd: string,
  command: string,
): { paneId: string; originalPane: string | null } {
  const originalPane = getFocusedHerdrPaneId();
  if (!originalPane) {
    throw new Error("Could not determine focused herdr pane");
  }

  const splitRaw = herdr([
    "pane",
    "split",
    originalPane,
    "--direction",
    "right",
    "--no-focus",
  ]);
  const split = JSON.parse(splitRaw);
  const paneId = split.result?.pane?.pane_id;
  if (!paneId) {
    throw new Error("herdr pane split did not return result.pane.pane_id");
  }

  herdr(["pane", "run", paneId, `cd ${shellQuote(cwd)} && ${command}`]);
  return { paneId, originalPane };
}

export function killHerdrPane(paneId?: string): void {
  if (!paneId) return;
  try {
    herdr(["pane", "close", paneId]);
  } catch {
    // pane already gone; ignore
  }
}

export function herdrSteerPane(paneId: string, message: string): void {
  herdr(["pane", "send-text", paneId, message]);
  herdr(["pane", "send-keys", paneId, "Enter"]);
}
```

Note: The backend may internally perform multiple herdr CLI calls. That is fine because these are not model-visible tool calls and do not consume orchestration tokens.

---

## Required `src/index.ts` changes

### 1. Store backend in task registry/history

Extend registry types:

```ts
interface RegistryEntry {
  // existing fields...
  backend?: "tmux" | "herdr" | "sdk";
}

interface TaskSessionHistoryEntry extends RegistryEntry {
  // existing fields...
  backend?: "tmux" | "herdr" | "sdk";
}

interface BackgroundTask {
  // existing fields...
  backend?: "tmux" | "herdr" | "sdk";
}
```

This matters for restore and cleanup. A task started in herdr should use herdr `exists()`/`kill()`, not tmux `paneExists()`/`kill-pane`.

### 2. Replace direct tmux calls with backend calls

Current code has direct calls like:

```ts
if (!hasTmux()) { ... sdk fallback ... }
const splitResult = splitWindowPane(ctx.cwd, command);
...
killAgentPane(paneId, originalPane);
...
paneExists(entry.paneId)
```

Refactor to something like:

```ts
const backend = chooseSubagentBackend(params.backend);

if (backend.name === "sdk") {
  // keep existing SDK path
}

const splitResult = backend.spawn({
  cwd: ctx.cwd,
  command: `cd ${shellQuote(ctx.cwd)} && ${shellCommand}`,
  description: descText,
});
```

For background completion:

```ts
backendFor(task.backend).kill(task.paneId, task.originalPane);
```

For restore:

```ts
const backend = backendFor(entry.backend ?? "tmux");
const paneAlive = entry.paneId ? backend.exists(entry.paneId) : false;
```

### 3. Completion detection can remain unchanged

Do not poll herdr output for completion.

Reuse existing completion logic:

```ts
checkTaskCompletion({
  resultPath: join(task.dir, "RESULT.md"),
  sessionDir: join(task.dir, "sessions"),
  sessionName: task.sessionName,
  paneId: task.paneId,
  sinceMs: task.startedAt,
});
```

Only `paneExists()` inside `waitCompletion.ts` is currently tmux-specific. This should be abstracted too.

Options:

1. Pass `paneExists` callback into `checkTaskCompletion()` / `waitForTaskCompletion()`.
2. Pass `backendName` and dispatch internally.
3. Create a generic `PaneHandle` abstraction.

Simplest change:

```ts
export interface TaskCompletionOptions {
  // existing fields...
  paneId?: string;
  paneExists?: (paneId: string) => boolean;
}
```

Then replace:

```ts
if (options.paneId && !paneExists(options.paneId)) { ... }
...
if (options.paneId && paneExists(options.paneId)) { ... }
```

with:

```ts
const exists = options.paneExists;
if (options.paneId && exists && !exists(options.paneId)) { ... }
...
if (options.paneId && exists && exists(options.paneId)) { ... }
```

The caller supplies `taskBackend.exists`.

---

## Receipt / renderer changes

The current receipt says:

```text
Started task <id> with <agent>.
Tmux session: <sessionName>.
Artifact directory: <dir>.
```

For backend-neutral behavior, rename this concept. Suggested text:

```text
Started task <id> with <agent>.
Backend: herdr.
Pane: w3:p7.
Session: task-<id>.
Artifact directory: <dir>.
A completion notification will arrive automatically; do not poll or duplicate this work.
```

Update details shape:

```ts
details: {
  task_id: id,
  agent_type: agent.name,
  description: descText,
  backend: backend.name,
  pane_id: paneId,
  session_name: sessionName,
  background: true,
}
```

For backwards compatibility, `tmux_session` can be kept temporarily but should be considered legacy/misnamed.

---

## Foreground vs background behavior

Preserve existing semantics:

### Background mode, default

```ts
task({
  agent_type: "explore",
  description: "auth session recon",
  prompt: "...",
  background: true
})
```

Behavior:

- spawn herdr pane;
- return immediately;
- parent should not poll;
- extension tracks completion internally;
- parent receives follow-up message when done.

### Foreground mode

```ts
task({
  agent_type: "explore",
  description: "auth session recon",
  prompt: "...",
  background: false
})
```

Behavior:

- spawn herdr pane;
- block the tool call until result/timeout/cancel;
- return summarized result inline;
- close the herdr pane afterwards.

---

## Optional but high-value: `task_batch`

To reduce tool calls even further, add a batch launcher:

```ts
pi.registerTool({
  name: "task_batch",
  parameters: Type.Object({
    tasks: Type.Array(Type.Object({
      agent_type: Type.String(),
      description: Type.String(),
      prompt: Type.String(),
      conversation_id: Type.Optional(Type.String()),
    })),
    background: Type.Optional(Type.Boolean({ default: true })),
    backend: Type.Optional(Type.String()),
  }),
});
```

This allows one model-visible tool call to spawn N subagents:

```ts
task_batch({
  background: true,
  tasks: [
    { agent_type: "explore", description: "session security", prompt: "..." },
    { agent_type: "explore", description: "oauth flow", prompt: "..." },
    { agent_type: "explore", description: "password reset", prompt: "..." }
  ]
})
```

Each subtask can still send its own completion follow-up.

Implementation can initially share most of `task.execute()` by factoring out an internal `startTask()` helper.

---

## Important pitfalls / implementation notes

### Do not use herdr pane output as the primary completion signal

Herdr can report `agent_status`, but `pi-task` already has a stronger signal: the subagent's Pi session JSONL and/or `RESULT.md`. Keep that as the source of truth.

### Do not require prompt injection after `pi` starts

Avoid the inefficient manual sequence:

```text
run pi
wait for prompt
send prompt
```

Instead pass the prompt as the final CLI argument, as `pi-task` already does via `buildPiArgs()` / `buildPiArgv()`.

### Keep `PI_TASK_TOOL_DISABLED=1`

The spawned command must preserve:

```bash
PI_TASK_TOOL_DISABLED=1 pi ...
```

This prevents recursive task-tool loading in subagents.

### Be careful with command quoting

The current tmux path constructs:

```ts
const shellCommand = `${envPrefix} pi ${piArgs.map((a) => shellQuote(a)).join(" ")}`;
```

The herdr backend should receive the same fully quoted command and run:

```ts
herdr(["pane", "run", paneId, `cd ${shellQuote(cwd)} && ${command}`]);
```

Because `herdr pane run` takes the whole command string as one argument, avoid manually splitting it after quoting.

### Herdr IDs are not durable

The herdr skill docs warn that pane/workspace/tab IDs can compact when panes close. Treat `pane_id` as live-session-only. It is acceptable in the active registry, but do not rely on it as a long-term session identifier. The durable identifier remains the Pi `sessionName` / JSONL session file.

### Restoring after extension reload

If a herdr task exists in the JSON registry but the pane id is no longer alive, mark it stale just like tmux. The session JSONL/history can still allow later conversation resume, but the background live task should not be tracked.

### Herdr tab creation is unnecessary

Do not create a new tab by default. The backend should split the focused pane with `--no-focus`. This keeps the implementation cheap and avoids unnecessary UI churn.

A future option could support `layout: "split" | "tab"`, but this is not needed for v1.

---

## Suggested implementation sequence

1. **Deduplicate current tmux code first**
   - `src/index.ts` currently duplicates helpers that also exist in `src/subagent/tmux.ts`.
   - Collapse to one tmux implementation before adding herdr, or the abstraction will be harder to reason about.

2. **Introduce backend interface**
   - Add `src/subagent/backend.ts`.
   - Wrap tmux helpers as `tmuxBackend`.

3. **Add herdr backend**
   - Add `src/subagent/herdr.ts`.
   - Implement `available`, `spawn`, `exists`, `kill`, optional `steer`.

4. **Make completion checker backend-neutral**
   - Add `paneExists?: (paneId: string) => boolean` to `TaskCompletionOptions`.

5. **Update registry/history types**
   - Add `backend` and maybe `pane_id` naming in details.

6. **Update receipts/renderers**
   - Replace tmux-specific wording with backend-neutral wording.

7. **Add tests**
   - Unit-test herdr JSON parsing with mocked command output if possible.
   - Unit-test backend selection: `HERDR_ENV=1` prefers herdr; otherwise tmux; otherwise SDK.
   - Unit-test registry restore dispatches to the right backend's `exists()`.

8. **Optional: add `task_batch`**
   - Factor task startup logic first, then expose batch tool.

---

## Acceptance criteria

A parent agent running inside herdr should be able to start an explorer with one model-visible tool call:

```ts
task({
  agent_type: "explore",
  description: "OAuth auth flow",
  prompt: "Investigate phpBB OAuth auth flow...",
  background: true
})
```

Expected behavior:

- no manual `herdr pane split` tool call by the model;
- no manual `herdr pane run` tool call by the model;
- no manual prompt injection;
- no model-visible polling;
- a herdr pane appears and runs the subagent;
- the parent receives a completion follow-up automatically;
- foreground mode still blocks and returns the result inline;
- SDK fallback still works outside tmux/herdr.

---

## Key rationale

The herdr skill is useful for ad hoc manual control, but subagent orchestration should live in `pi-task` because `pi-task` already owns:

- task identity;
- agent config;
- prompt construction;
- result format;
- session JSONL tracking;
- background notifications;
- registry/history;
- UI widget integration;
- foreground/background semantics.

Adding herdr as another backend gives the same clean UX as the tmux implementation while preserving herdr-native observability.
