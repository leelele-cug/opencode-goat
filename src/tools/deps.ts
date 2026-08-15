import type { ToolContext } from "@opencode-ai/plugin";
import type { RegisteredGoatToolId } from "../core/role-capabilities.js";
import type { ToolCallContext } from "../core/ports.js";
import { canonicalHash } from "../core/canonical.js";
import type { Orchestrator } from "../runtime/orchestrator.js";

export function toolContext(context: ToolContext, toolId: RegisteredGoatToolId): ToolCallContext {
  return {
    toolId,
    sessionID: context.sessionID,
    messageID: context.messageID,
    agent: context.agent,
    directory: context.directory,
    worktree: context.worktree,
  };
}

export function operationKey(toolId: RegisteredGoatToolId, context: ToolContext, discriminator = "", input?: unknown): string {
  const suffix = discriminator ? `:${discriminator}` : "";
  return `${toolId}:${context.messageID}${suffix}${input === undefined ? "" : `:${canonicalHash(input)}`}`;
}

export async function askNativePermission(context: ToolContext, toolId: RegisteredGoatToolId): Promise<void> {
  await context.ask({
    permission: toolId,
    patterns: ["*"],
    always: ["*"],
    metadata: { goatTool: toolId },
  });
}

export async function authorizeThenAsk(orchestrator: Orchestrator, context: ToolContext, toolId: RegisteredGoatToolId): Promise<ToolCallContext> {
  const call = toolContext(context, toolId);
  const authorized = orchestrator.preauthorizeGoatTool(call);
  if (!authorized.ok) throw new Error(authorized.error);
  await askNativePermission(context, toolId);
  return call;
}
