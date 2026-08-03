import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { askNativePermission, toolContext } from "./deps.js";

export function createBlockTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Persist an actionable blocker for the active Goal.",
    args: { reason: z.string().min(1).max(20_000) },
    execute: async (args, context) => { await askNativePermission(context, "goat_block"); return orchestrator.block(toolContext(context, "goat_block"), args.reason); },
  });
}
