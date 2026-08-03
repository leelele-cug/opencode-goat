import type { ToolContext } from "@opencode-ai/plugin";
import type { RegisteredGoatToolId } from "../core/role-capabilities.js";
import type { ToolCallContext } from "../core/ports.js";

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

export function operationKey(toolId: RegisteredGoatToolId, context: ToolContext, discriminator = ""): string {
  return `${toolId}:${context.messageID}${discriminator ? `:${discriminator}` : ""}`;
}

export async function askNativePermission(context: ToolContext, toolId: RegisteredGoatToolId): Promise<void> {
  await context.ask({
    permission: toolId,
    patterns: ["*"],
    always: ["*"],
    metadata: { goatTool: toolId },
  });
}
