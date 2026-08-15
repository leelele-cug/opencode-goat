import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { authorizeThenAsk, operationKey } from "./deps.js";

export function createCompletionProposeTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Request independent verification after evidence covers every MUST criterion.",
    args: {},
    execute: async (_args, context) => orchestrator.proposeCompletion(await authorizeThenAsk(orchestrator, context, "goat_completion_propose"), operationKey("goat_completion_propose", context)),
  });
}
