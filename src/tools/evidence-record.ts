import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { authorizeThenAsk, operationKey } from "./deps.js";

export function createEvidenceRecordTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Record immutable evidence for one criterion in the active Run.",
    args: { criterionId: z.string().min(1), source: z.string().min(1), method: z.string().min(1), expectedResult: z.string().min(1), actualReference: z.string().min(1) },
    execute: async (args, context) => orchestrator.recordEvidence(await authorizeThenAsk(orchestrator, context, "goat_evidence_record"), {
      criterionId: args.criterionId,
      source: args.source,
      method: args.method,
      expectedResult: args.expectedResult,
      actualReference: args.actualReference,
    }, operationKey("goat_evidence_record", context, args.criterionId, args)),
  });
}
