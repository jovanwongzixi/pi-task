import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../helpers.js";

export interface RunSdkSubagentOptions {
  prompt: string;
  agent: AgentConfig;
  cwd: string;
  ctx: ExtensionContext;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  excludeTools?: string[];
  systemPrompt?: string;
}

async function resolveModel(ctx: ExtensionContext, requested?: string) {
  const registry = ctx.modelRegistry as any;
  if (requested) {
    const [provider, ...rest] = requested.split("/");
    const modelId = rest.join("/");
    const exact = modelId
      ? registry?.find?.(provider, modelId)
      : registry?.find?.(requested);
    if (exact) return exact;
  }

  const all = registry?.getAll?.() ?? [];
  const available = all.length > 0 ? all : ((await registry?.getAvailable?.()) ?? []);
  if (requested) {
    const byId = available.find(
      (model: any) =>
        model?.id === requested ||
        `${model?.provider?.id ?? model?.provider}/${model?.id}` === requested ||
        model?.name === requested,
    );
    if (byId) return byId;
  }
  return available[0];
}

export async function runSdkSubagent(options: RunSdkSubagentOptions): Promise<{
  output: string;
  sessionPath?: string;
}> {
  const model = await resolveModel(options.ctx, options.model ?? options.agent.model);
  if (!model) {
    throw new Error("No model available for SDK subagent execution");
  }

  const { createAgentSession, DefaultResourceLoader, getAgentDir } =
    await import("@earendil-works/pi-coding-agent");
  const previousDisabled = process.env.PI_TASK_TOOL_DISABLED;
  process.env.PI_TASK_TOOL_DISABLED = "1";
  let session: any;
  try {
    const agentDir = getAgentDir();
    const resourceLoader = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir,
      systemPromptOverride: () => options.systemPrompt,
      noExtensions: true,
    } as any);

    await resourceLoader.reload();

    ({ session } = await createAgentSession({
      cwd: options.cwd,
      agentDir,
      model,
      thinkingLevel: options.thinkingLevel as any,
      tools: options.tools,
      excludeTools: options.excludeTools,
      resourceLoader,
    }));

    await session.prompt(options.prompt);

    const sessionPath = session.sessionFile;
    const output = getLastAssistantText(session.messages);
    return { output: output.trim(), sessionPath };
  } finally {
    session?.dispose?.();
    if (previousDisabled === undefined) {
      delete process.env.PI_TASK_TOOL_DISABLED;
    } else {
      process.env.PI_TASK_TOOL_DISABLED = previousDisabled;
    }
  }
}

function getLastAssistantText(messages: readonly any[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .map((part) => {
          if (typeof part === "string") return part;
          if (typeof part?.text === "string") return part.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}
