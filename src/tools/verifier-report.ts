import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { askNativePermission, toolContext } from "./deps.js";

export function createVerifierReportTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Submit independent per-criterion verification findings. Store derives the Goal outcome.",
    args: { findings: z.array(z.object({ criterionId: z.string().min(1), result: z.enum(["pass", "fail", "blocked"]), evidenceIds: z.array(z.string()), note: z.string().min(1).optional() }).strict()).min(1) },
    execute: async (args, context) => { await askNativePermission(context, "goat_verifier_report"); return orchestrator.recordVerifierReport(toolContext(context, "goat_verifier_report"), args.findings); },
  });
}
