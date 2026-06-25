import { execFileSync } from "node:child_process";
import type {
  SpawnSubagentBatchOptions,
  SpawnedSubagentBatch,
  SpawnedSubagentBatchItem,
  SpawnSubagentOptions,
  SpawnedSubagentPane,
  SubagentOutcome,
  SubagentPaneBackend,
} from "./backend.js";

export type HerdrCommand = (args: string[]) => string;

export interface HerdrPane {
  pane_id?: string;
  tab_id?: string;
  workspace_id?: string;
  focused?: boolean;
  label?: string;
}

export interface HerdrTab {
  tab_id?: string;
  workspace_id?: string;
  label?: string;
  pane_count?: number;
}

export interface HerdrCreatedTab {
  tabId: string;
  rootPaneId: string;
}

export interface HerdrLayoutPane {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

interface HerdrWave {
  workspaceId: string;
  tabId: string;
  activePaneIds: Set<string>;
  rootPaneId?: string;
}

function defaultHerdrCommand(args: string[]): string {
  return execFileSync("herdr", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Herdr returned invalid JSON.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getNumber(
  value: Record<string, unknown>,
  names: readonly string[],
): number | null {
  for (const name of names) {
    const raw = value[name];
    const number =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : Number.NaN;
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function getCoordinate(
  value: Record<string, unknown>,
  names: readonly string[],
): number {
  for (const name of names) {
    const raw = value[name];
    const number =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : Number.NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return 0;
}

function getDimension(
  value: Record<string, unknown>,
  names: readonly string[],
): number | null {
  const direct = getNumber(value, names);
  if (direct !== null) return direct;

  for (const nestedName of [
    "rect",
    "rectangle",
    "bounds",
    "frame",
    "geometry",
    "dimensions",
  ]) {
    const nested = value[nestedName];
    if (!isRecord(nested)) continue;
    const nestedValue = getNumber(nested, names);
    if (nestedValue !== null) return nestedValue;
  }

  return null;
}

export function parseHerdrPanes(raw: string): HerdrPane[] {
  const value = parseJson(raw) as { result?: { panes?: unknown } };
  return Array.isArray(value.result?.panes)
    ? (value.result.panes as HerdrPane[])
    : [];
}

export function parseHerdrTabs(raw: string): HerdrTab[] {
  const value = parseJson(raw) as { result?: { tabs?: unknown } };
  return Array.isArray(value.result?.tabs)
    ? (value.result.tabs as HerdrTab[])
    : [];
}

export function parseCreatedHerdrTab(raw: string): HerdrCreatedTab {
  const value = parseJson(raw) as {
    result?: {
      tab?: { tab_id?: unknown };
      root_pane?: { pane_id?: unknown };
    };
  };
  const tabId = asNonEmptyString(value.result?.tab?.tab_id);
  if (!tabId) {
    throw new Error("Herdr tab create did not return result.tab.tab_id.");
  }
  const rootPaneId = asNonEmptyString(value.result?.root_pane?.pane_id);
  if (!rootPaneId) {
    throw new Error(
      "Herdr tab create did not return result.root_pane.pane_id.",
    );
  }
  return { tabId, rootPaneId };
}

export function parseSplitHerdrPaneId(raw: string): string {
  const value = parseJson(raw) as {
    result?: { pane?: { pane_id?: unknown } };
  };
  const paneId = asNonEmptyString(value.result?.pane?.pane_id);
  if (!paneId) {
    throw new Error("Herdr pane split did not return result.pane.pane_id.");
  }
  return paneId;
}

export function parseHerdrLayoutPanes(raw: string): HerdrLayoutPane[] {
  const value = parseJson(raw) as { result?: { layout?: unknown } };
  const layout = value.result?.layout;
  if (!isRecord(layout)) {
    throw new Error("Herdr pane layout did not return result.layout.");
  }

  const panes: HerdrLayoutPane[] = [];
  const seen = new Set<unknown>();

  function visit(node: unknown): void {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);

    if (node.visible !== false && node.hidden !== true) {
      const paneId = asNonEmptyString(node.pane_id ?? node.paneId);
      const width = getDimension(node, [
        "width",
        "w",
        "cols",
        "columns",
      ]);
      const height = getDimension(node, ["height", "h", "rows"]);
      if (paneId && width !== null && height !== null) {
        panes.push({
          paneId,
          x: getCoordinate(node, ["x", "left", "col", "column"]),
          y: getCoordinate(node, ["y", "top", "row"]),
          width,
          height,
          area: width * height,
        });
      }
    }

    for (const child of Object.values(node)) {
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (isRecord(child)) {
        visit(child);
      }
    }
  }

  visit(layout);

  if (panes.length === 0) {
    throw new Error("Herdr pane layout did not contain visible pane rectangles.");
  }
  return panes;
}

export function selectLargestHerdrLayoutPane(
  panes: readonly HerdrLayoutPane[],
): HerdrLayoutPane {
  const largest = panes.reduce<HerdrLayoutPane | null>(
    (best, pane) => (!best || pane.area > best.area ? pane : best),
    null,
  );
  if (!largest) {
    throw new Error("Cannot select a split target from an empty Herdr layout.");
  }
  return largest;
}

export function sortHerdrLayoutPanesForAssignment(
  panes: readonly HerdrLayoutPane[],
): HerdrLayoutPane[] {
  return [...panes].sort(
    (left, right) =>
      left.y - right.y ||
      left.x - right.x ||
      left.paneId.localeCompare(right.paneId),
  );
}

export function chooseHerdrSplitDirection(
  width: number,
  height: number,
): "right" | "down" {
  return width >= 2 * height ? "right" : "down";
}

function shouldInterrupt(outcome: SubagentOutcome): boolean {
  return (
    outcome === "timeout" ||
    outcome === "cancelled" ||
    outcome === "tracking-error"
  );
}

function boundedLabel(options: SpawnSubagentOptions): string | null {
  const parts = [options.agentType, options.description]
    .map((part) => part?.replace(/\s+/g, " ").trim())
    .filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;

  return boundHerdrLabel(parts.join(": "));
}

function boundHerdrLabel(label: string): string {
  const normalized = label.replace(/\s+/g, " ").trim();
  return normalized.length <= 64
    ? normalized
    : `${normalized.slice(0, 61)}...`;
}

function nextAgentsTabLabel(tabs: readonly HerdrTab[]): string {
  let max = 0;
  for (const tab of tabs) {
    const label = tab.label ?? "";
    const match = /^Agents(?:\s+(\d+))?$/.exec(label);
    if (!match) continue;
    const suffix = match[1] ? Number(match[1]) : 1;
    if (Number.isInteger(suffix) && suffix > max) max = suffix;
  }
  return `Agents ${max + 1}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Herdr-specific pane lifecycle. No tmux behavior belongs in this class. */
export class HerdrBackend implements SubagentPaneBackend {
  readonly name = "herdr" as const;
  private readonly waves = new Map<string, HerdrWave>();
  private currentWaveTabId: string | null = null;

  constructor(private readonly command: HerdrCommand = defaultHerdrCommand) {}

  available(): boolean {
    if (process.env.HERDR_ENV !== "1") return false;
    try {
      this.listPanes();
      return true;
    } catch {
      return false;
    }
  }

  exists(paneId: string): boolean {
    try {
      return this.listPanes().some((pane) => pane.pane_id === paneId);
    } catch {
      return false;
    }
  }

  spawn(options: SpawnSubagentOptions): SpawnedSubagentPane {
    const panes = this.listPanes();
    const focusedPane = panes.find((pane) => pane.focused);
    const originalPane = focusedPane?.pane_id ?? null;
    if (!originalPane) {
      throw new Error("Could not determine the focused herdr pane.");
    }
    const workspaceId = focusedPane?.workspace_id;
    if (!workspaceId) {
      throw new Error("Focused herdr pane did not include workspace_id.");
    }

    const wave =
      this.revalidateCurrentWave(panes) ??
      this.createWave({
        workspaceId,
        cwd: options.cwd,
        label: nextAgentsTabLabel(this.listTabs(workspaceId)),
        makeCurrent: true,
      });
    const paneId =
      wave.activePaneIds.size === 0
        ? this.getRootPaneForNewWave(wave)
        : this.splitLargestPaneInWave(wave, options);

    try {
      this.renamePaneForInspection(paneId, options);
      this.command(["pane", "run", paneId, options.command]);
      wave.activePaneIds.add(paneId);
    } catch (error) {
      this.rollbackSpawn(paneId);
      this.removeEmptyWave(wave);
      throw error;
    }

    return { paneId, originalPane };
  }

  spawnBatch(options: SpawnSubagentBatchOptions): SpawnedSubagentBatch {
    if (options.tasks.length === 0) {
      throw new Error("Herdr batch spawn requires at least one task.");
    }

    const panes = this.listPanes();
    const focusedPane = panes.find((pane) => pane.focused);
    const originalPane = focusedPane?.pane_id ?? null;
    if (!originalPane) {
      throw new Error("Could not determine the focused herdr pane.");
    }
    const workspaceId = focusedPane?.workspace_id;
    if (!workspaceId) {
      throw new Error("Focused herdr pane did not include workspace_id.");
    }

    const tabLabel = boundHerdrLabel(
      options.tabLabel ??
        options.tab_label ??
        nextAgentsTabLabel(this.listTabs(workspaceId)),
    );
    const wave = this.createWave({
      workspaceId,
      cwd: options.cwd,
      label: tabLabel,
      makeCurrent: false,
    });

    const createdPaneIds = new Set<string>([this.getRootPaneForNewWave(wave)]);
    const itemErrors = new Map<number, Error>();

    for (let index = 1; index < options.tasks.length; index++) {
      try {
        createdPaneIds.add(this.splitLargestPaneInTab(wave, options.cwd));
      } catch (error) {
        itemErrors.set(index, toError(error));
      }
    }

    const runnableIndexes = options.tasks
      .map((_, index) => index)
      .filter((index) => !itemErrors.has(index));
    const assignments = new Map<number, string>();

    try {
      const sortedPanes = sortHerdrLayoutPanesForAssignment(
        parseHerdrLayoutPanes(
          this.command(["pane", "layout", "--pane", [...createdPaneIds][0]]),
        ),
      ).filter((pane) => createdPaneIds.has(pane.paneId));

      for (
        let index = 0;
        index < runnableIndexes.length && index < sortedPanes.length;
        index++
      ) {
        assignments.set(
          runnableIndexes[index] as number,
          sortedPanes[index]!.paneId,
        );
      }
      for (
        let index = sortedPanes.length;
        index < runnableIndexes.length;
        index++
      ) {
        itemErrors.set(
          runnableIndexes[index] as number,
          new Error("Herdr batch did not create enough panes for this task."),
        );
      }
    } catch (error) {
      for (const index of runnableIndexes) {
        itemErrors.set(index, toError(error));
      }
    }

    const usedPaneIds = new Set(assignments.values());
    const results: SpawnedSubagentBatchItem[] = options.tasks.map(
      (_, index) => ({
        originalPane,
        error:
          itemErrors.get(index) ??
          new Error("Herdr batch did not assign a pane for this task."),
      }),
    );

    for (const [index, paneId] of assignments) {
      const task = options.tasks[index]!;
      try {
        this.renamePaneForInspection(paneId, {
          cwd: options.cwd,
          command: task.command,
          description: task.description,
          agentType: task.agentType,
        });
        this.command(["pane", "run", paneId, task.command]);
        wave.activePaneIds.add(paneId);
        results[index] = { paneId, originalPane };
      } catch (error) {
        itemErrors.set(index, toError(error));
        results[index] = { originalPane, error: toError(error) };
        this.closePaneBestEffort(paneId);
      }
    }

    for (const paneId of createdPaneIds) {
      if (!usedPaneIds.has(paneId) || !wave.activePaneIds.has(paneId)) {
        this.closePaneBestEffort(paneId);
      }
    }
    this.removeEmptyWave(wave);

    return { tabId: wave.tabId, originalPane, items: results };
  }

  finalize(
    paneId: string | undefined,
    _originalPane: string | null | undefined,
    outcome: SubagentOutcome,
  ): void {
    if (paneId && shouldInterrupt(outcome) && this.paneIsLive(paneId)) {
      try {
        this.command(["pane", "send-keys", paneId, "ctrl+c"]);
      } catch {
        // The retained pane may already be gone or its live ID may be stale.
      }
    }

    if (paneId) {
      this.removePaneFromWaves(paneId);
    }
  }

  rollbackSpawn(paneId?: string): void {
    if (!paneId) return;
    this.removePaneFromWaves(paneId);
    this.closePaneBestEffort(paneId);
  }

  kill(paneId?: string): void {
    this.rollbackSpawn(paneId);
  }

  steer(paneId: string, message: string): void {
    this.command(["pane", "send-text", paneId, message]);
    this.command(["pane", "send-keys", paneId, "Enter"]);
  }

  adoptRestoredPanes(entries: { paneId: string; startedAt: number }[]): void {
    if (entries.length === 0) {
      this.waves.clear();
      this.currentWaveTabId = null;
      return;
    }

    let livePanes: HerdrPane[];
    try {
      livePanes = this.listPanes();
    } catch {
      this.waves.clear();
      this.currentWaveTabId = null;
      return;
    }

    const panesById = new Map(
      livePanes.map((pane) => [pane.pane_id, pane] as const),
    );
    const groups = new Map<
      string,
      {
        workspaceId: string;
        tabId: string;
        latestStartedAt: number;
        paneIds: Set<string>;
      }
    >();

    for (const entry of entries) {
      const pane = panesById.get(entry.paneId);
      const tabId = pane?.tab_id;
      const workspaceId = pane?.workspace_id;
      if (!tabId || !workspaceId) continue;

      const group =
        groups.get(tabId) ??
        {
          workspaceId,
          tabId,
          latestStartedAt: Number.NEGATIVE_INFINITY,
          paneIds: new Set<string>(),
        };
      group.latestStartedAt = Math.max(group.latestStartedAt, entry.startedAt);
      group.paneIds.add(entry.paneId);
      groups.set(tabId, group);
    }

    this.waves.clear();
    for (const group of groups.values()) {
      this.waves.set(group.tabId, {
        workspaceId: group.workspaceId,
        tabId: group.tabId,
        activePaneIds: group.paneIds,
      });
    }

    const current = [...groups.values()].reduce<
      | {
          workspaceId: string;
          tabId: string;
          latestStartedAt: number;
          paneIds: Set<string>;
        }
      | undefined
    >(
      (best, group) =>
        !best || group.latestStartedAt > best.latestStartedAt ? group : best,
      undefined,
    );

    this.currentWaveTabId = current?.tabId ?? null;
  }

  private listPanes(): HerdrPane[] {
    return parseHerdrPanes(this.command(["pane", "list"]));
  }

  private listTabs(workspaceId: string): HerdrTab[] {
    return parseHerdrTabs(
      this.command(["tab", "list", "--workspace", workspaceId]),
    );
  }

  private createWave(options: {
    workspaceId: string;
    cwd: string;
    label: string;
    makeCurrent: boolean;
  }): HerdrWave {
    const created = parseCreatedHerdrTab(
      this.command([
        "tab",
        "create",
        "--workspace",
        options.workspaceId,
        "--cwd",
        options.cwd,
        "--label",
        boundHerdrLabel(options.label),
        "--no-focus",
      ]),
    );
    const wave = {
      workspaceId: options.workspaceId,
      tabId: created.tabId,
      activePaneIds: new Set<string>(),
      rootPaneId: created.rootPaneId,
    };
    this.waves.set(wave.tabId, wave);
    if (options.makeCurrent) this.currentWaveTabId = wave.tabId;
    return wave;
  }

  private getRootPaneForNewWave(wave: HerdrWave): string {
    const rootPaneId = wave.rootPaneId;
    if (!rootPaneId) {
      throw new Error("Could not find root pane for new Herdr task tab.");
    }
    delete wave.rootPaneId;
    return rootPaneId;
  }

  private splitLargestPaneInWave(
    wave: HerdrWave,
    options: SpawnSubagentOptions,
  ): string {
    const panes = this.listPanes();
    const anchorPane = panes.find(
      (pane) =>
        pane.tab_id === wave.tabId &&
        pane.pane_id &&
        wave.activePaneIds.has(pane.pane_id),
    );
    if (!anchorPane?.pane_id) {
      throw new Error("Could not find an active pane in the Herdr task tab.");
    }

    return this.splitLargestPaneInTab(wave, options.cwd, anchorPane.pane_id);
  }

  private splitLargestPaneInTab(
    wave: HerdrWave,
    cwd: string,
    anchorPaneId?: string,
  ): string {
    const layoutAnchorPaneId =
      anchorPaneId ??
      wave.rootPaneId ??
      this.listPanes().find((pane) => pane.tab_id === wave.tabId)?.pane_id;
    if (!layoutAnchorPaneId) {
      throw new Error("Could not find a Herdr pane for task tab layout.");
    }

    const largestPane = selectLargestHerdrLayoutPane(
      parseHerdrLayoutPanes(
        this.command(["pane", "layout", "--pane", layoutAnchorPaneId]),
      ),
    );
    const direction = chooseHerdrSplitDirection(
      largestPane.width,
      largestPane.height,
    );
    return parseSplitHerdrPaneId(
      this.command([
        "pane",
        "split",
        largestPane.paneId,
        "--direction",
        direction,
        "--ratio",
        "0.5",
        "--cwd",
        cwd,
        "--no-focus",
      ]),
    );
  }

  private revalidateCurrentWave(panes: readonly HerdrPane[]): HerdrWave | null {
    const wave = this.currentWaveTabId
      ? this.waves.get(this.currentWaveTabId)
      : undefined;
    if (!wave) return null;

    try {
      const tabs = this.listTabs(wave.workspaceId);
      if (!tabs.some((tab) => tab.tab_id === wave.tabId)) {
        this.removeWave(wave.tabId);
        return null;
      }
    } catch {
      this.removeWave(wave.tabId);
      return null;
    }

    const liveActivePaneIds = new Set(
      panes
        .filter(
          (pane) =>
            pane.tab_id === wave.tabId &&
            pane.pane_id &&
            wave.activePaneIds.has(pane.pane_id),
        )
        .map((pane) => pane.pane_id as string),
    );
    wave.activePaneIds = liveActivePaneIds;
    if (wave.activePaneIds.size === 0 && !wave.rootPaneId) {
      this.removeWave(wave.tabId);
      return null;
    }
    return wave;
  }

  private renamePaneForInspection(
    paneId: string,
    options: SpawnSubagentOptions,
  ): void {
    const label = boundedLabel(options);
    if (!label) return;
    try {
      this.command(["pane", "rename", paneId, label]);
    } catch {
      // Labeling improves inspection but must not fail launch.
    }
  }

  private paneIsLive(paneId: string): boolean {
    try {
      return this.listPanes().some((pane) => pane.pane_id === paneId);
    } catch {
      return false;
    }
  }

  private removePaneFromWaves(paneId: string): void {
    for (const wave of this.waves.values()) {
      if (!wave.activePaneIds.delete(paneId)) continue;
      this.removeEmptyWave(wave);
      return;
    }
  }

  private removeEmptyWave(wave: HerdrWave): void {
    if (wave.activePaneIds.size === 0 && !wave.rootPaneId) {
      this.removeWave(wave.tabId);
    }
  }

  private removeWave(tabId: string): void {
    this.waves.delete(tabId);
    if (this.currentWaveTabId === tabId) this.currentWaveTabId = null;
  }

  private closePaneBestEffort(paneId: string): void {
    try {
      this.command(["pane", "close", paneId]);
    } catch {
      // Pane already exited or its live ID is no longer valid.
    }
  }
}
