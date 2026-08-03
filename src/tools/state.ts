import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { askNativePermission, toolContext } from "./deps.js";

export function createStateTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Read the authoritative Goat Goal, Contract, workspace, evidence, and verification state.",
    args: {},
    execute: async (_args, context) => { await askNativePermission(context, "goat_state"); return orchestrator.readGoatState(toolContext(context, "goat_state")); },
  });
}
