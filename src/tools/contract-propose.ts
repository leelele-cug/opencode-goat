import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { z } from "zod";
import type { Orchestrator } from "../runtime/orchestrator.js";
import { authorizeThenAsk, operationKey } from "./deps.js";

export function createContractProposeTool(orchestrator: Orchestrator): ToolDefinition {
  return tool({
    description: "Propose one immutable Goal Contract revision. The source request comes from durable Goat state. A passing Ready Gate returns status awaiting-approval and an exact question payload. Immediately pass that payload to the native question tool; do not ask for approval in prose.",
    args: {
      outcome: z.string().min(1),
      included: z.array(z.string().min(1)).min(1),
      excluded: z.array(z.string().min(1)),
      constraints: z.array(z.string().min(1)),
      assumptions: z.array(z.string().min(1)),
      criteria: z.array(z.object({
        id: z.string().min(1),
        priority: z.enum(["must", "should"]),
        description: z.string().min(1),
        verification: z.array(z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("inspection"), description: z.string().min(1) }).strict(),
          z.object({ kind: z.literal("command"), command: z.string().min(1) }).strict(),
        ])).min(1),
      }).strict()).min(1),
      outcomeObservable: z.boolean(),
      constraintsReviewed: z.boolean(),
      assumptionsReviewed: z.boolean(),
      outcomeChangingQuestionsResolved: z.boolean(),
      infeasibleCriterionIds: z.array(z.string().min(1)),
    },
    execute: async (args, context) => orchestrator.proposeContract(await authorizeThenAsk(orchestrator, context, "goat_contract_propose"), {
      outcome: args.outcome,
      included: args.included,
      excluded: args.excluded,
      constraints: args.constraints,
      assumptions: args.assumptions,
      criteria: args.criteria,
      outcomeObservable: args.outcomeObservable,
      constraintsReviewed: args.constraintsReviewed,
      assumptionsReviewed: args.assumptionsReviewed,
      outcomeChangingQuestionsResolved: args.outcomeChangingQuestionsResolved,
      infeasibleCriterionIds: args.infeasibleCriterionIds,
    }, operationKey("goat_contract_propose", context, "", args)),
  });
}
