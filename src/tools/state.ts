import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { authorizeThenAsk } from "./deps.js";

export function createStateTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Read the authoritative Goat Goal, Contract, workspace, evidence, and verification state.",
    args: {},
    execute: async (_args, context) => orchestrator.readGoatState(await authorizeThenAsk(orchestrator, context, "goat_state")),
  });
}
