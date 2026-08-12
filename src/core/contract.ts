import { z } from "zod";
import { canonicalHash, compareCanonicalStrings } from "./canonical.js";
const ContractTextSchema = z.string().min(1).max(20_000);
const ContractListSchema = z.array(ContractTextSchema).max(100);
export const WorkspaceStrategySchema = z.enum(["current", "worktree"]);
export type WorkspaceStrategy = z.infer<typeof WorkspaceStrategySchema>;

export const ContractBodySchema = z.object({
  sourceRequest: z.string().min(1).max(50_000),
  outcome: ContractTextSchema,
  scope: z.object({
    included: ContractListSchema.min(1),
    excluded: ContractListSchema,
  }).strict(),
  constraints: ContractListSchema,
  assumptions: ContractListSchema,
  workspace: WorkspaceStrategySchema,
}).strict().readonly();
export type ContractBody = z.infer<typeof ContractBodySchema>;

export const VerificationStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("inspection"), description: ContractTextSchema }).strict(),
  z.object({ kind: z.literal("command"), command: ContractTextSchema }).strict(),
]).readonly();
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

export const AcceptanceCriterionSchema = z.object({
  id: z.string().min(1).max(200),
  priority: z.enum(["must", "should"]),
  description: ContractTextSchema,
  verification: z.array(VerificationStepSchema).min(1).max(20),
}).strict().readonly();
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

export const GoalRevisionSchema = z.object({
  goalId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  body: ContractBodySchema,
  criteria: z.array(AcceptanceCriterionSchema).min(1).max(200),
  hash: z.string().min(1),
  createdAt: z.string().min(1),
}).strict().readonly();
export type GoalRevision = z.infer<typeof GoalRevisionSchema>;

export function computeRevisionHash(body: ContractBody, criteria: readonly AcceptanceCriterion[]): string {
  return canonicalHash({ body, criteria: [...criteria].sort((a, b) => compareCanonicalStrings(a.id, b.id)) });
}

export function isApprovedVerificationCommand(criteria: readonly AcceptanceCriterion[], command: string): boolean {
  return criteria.some((criterion) => criterion.verification.some((step) => step.kind === "command" && step.command === command));
}

export function createRevision(goalId: string, revision: number, body: ContractBody, criteria: readonly AcceptanceCriterion[], createdAt: string): GoalRevision {
  const parsedBody = ContractBodySchema.parse(body);
  const parsedCriteria = z.array(AcceptanceCriterionSchema).min(1).parse(criteria);
  const ids = new Set<string>();
  for (const criterion of parsedCriteria) {
    if (ids.has(criterion.id)) throw new TypeError(`duplicate criterion id: ${criterion.id}`);
    ids.add(criterion.id);
  }
  if (!parsedCriteria.some((criterion) => criterion.priority === "must")) throw new TypeError("at least one MUST criterion is required");
  const hash = computeRevisionHash(parsedBody, parsedCriteria);
  return GoalRevisionSchema.parse({ goalId, revision, body: parsedBody, criteria: parsedCriteria, hash, createdAt });
}

export function formatContractApprovalSummary(body: ContractBody, criteria: readonly AcceptanceCriterion[]): string {
  return [
    `Source request: ${body.sourceRequest}`,
    `Outcome: ${body.outcome}`,
    `Included: ${body.scope.included.join("; ")}`,
    `Excluded: ${body.scope.excluded.length ? body.scope.excluded.join("; ") : "None"}`,
    `Constraints: ${body.constraints.length ? body.constraints.join("; ") : "None"}`,
    `Criteria: ${criteria.map((criterion) => `${criterion.priority.toUpperCase()} ${criterion.id}: ${criterion.description} [${criterion.verification.map((step) => step.kind === "command" ? step.command : `inspect: ${step.description}`).join(" | ")}]`).join("; ")}`,
    `Workspace: ${body.workspace}`,
    `Assumptions: ${body.assumptions.length ? body.assumptions.join("; ") : "None"}`,
  ].join("\n");
}

export const ReadinessDimensionSchema = z.object({
  dimension: z.string().min(1),
  status: z.enum(["pass", "block"]),
  reason: z.string().optional(),
}).strict().readonly();
export type ReadinessDimension = z.infer<typeof ReadinessDimensionSchema>;

export const ReadyGateFactsSchema = z.object({
  outcomeObservable: z.boolean(),
  constraintsReviewed: z.boolean(),
  assumptionsReviewed: z.boolean(),
  outcomeChangingQuestionsResolved: z.boolean(),
  workspaceAvailable: z.boolean(),
  infeasibleCriterionIds: z.array(z.string().min(1).max(200)).max(200).readonly(),
}).strict().readonly();
export type ReadyGateFacts = z.infer<typeof ReadyGateFactsSchema>;

export type ReadinessResult = { readonly ready: boolean; readonly dimensions: readonly ReadinessDimension[] };

export function evaluateReadiness(body: ContractBody, criteria: readonly AcceptanceCriterion[], facts: ReadyGateFacts): ReadinessResult {
  const parsedBody = ContractBodySchema.parse(body);
  const parsedCriteria = z.array(AcceptanceCriterionSchema).parse(criteria);
  const parsedFacts = ReadyGateFactsSchema.parse(facts);
  const dimensions: ReadinessDimension[] = [];
  const outcomeObservable = parsedBody.outcome.trim().length > 0 && parsedFacts.outcomeObservable;
  dimensions.push({
    dimension: "outcome-observable",
    status: outcomeObservable ? "pass" : "block",
    reason: outcomeObservable ? undefined : "Outcome must be observable",
  });

  const criterionIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const criterion of parsedCriteria) {
    if (criterionIds.has(criterion.id)) duplicateIds.add(criterion.id);
    criterionIds.add(criterion.id);
  }
  const criteriaStable = parsedCriteria.length > 0 && duplicateIds.size === 0;
  dimensions.push({
    dimension: "criteria-stable",
    status: criteriaStable ? "pass" : "block",
    reason: criteriaStable ? undefined : duplicateIds.size > 0 ? `Duplicate criterion IDs: ${[...duplicateIds].sort(compareCanonicalStrings).join(", ")}` : "At least one criterion is required",
  });

  const scopeSufficient = parsedBody.scope.included.length > 0;
  dimensions.push({
    dimension: "scope-sufficient",
    status: scopeSufficient ? "pass" : "block",
    reason: scopeSufficient ? undefined : "Included scope is empty",
  });

  const hasMustCriterion = parsedCriteria.some((criterion) => criterion.priority === "must");
  dimensions.push({
    dimension: "must-criterion-present",
    status: hasMustCriterion ? "pass" : "block",
    reason: hasMustCriterion ? undefined : "No MUST criterion defined",
  });

  const infeasibleIds = new Set(parsedFacts.infeasibleCriterionIds);
  const unknownInfeasibleIds = [...infeasibleIds].filter((id) => !criterionIds.has(id));
  const criteriaFeasible = parsedCriteria.every((criterion) => criterion.verification.length > 0 && !infeasibleIds.has(criterion.id)) && unknownInfeasibleIds.length === 0;
  dimensions.push({
    dimension: "criteria-verifiable",
    status: criteriaFeasible ? "pass" : "block",
    reason: criteriaFeasible ? undefined : unknownInfeasibleIds.length > 0 ? `Unknown infeasible criterion IDs: ${unknownInfeasibleIds.sort(compareCanonicalStrings).join(", ")}` : "One or more criteria have no feasible verification method",
  });

  dimensions.push({
    dimension: "constraints-reviewed",
    status: parsedFacts.constraintsReviewed ? "pass" : "block",
    reason: parsedFacts.constraintsReviewed ? undefined : "Material constraints and risks have not been reviewed",
  });
  dimensions.push({
    dimension: "assumptions-reviewed",
    status: parsedFacts.assumptionsReviewed ? "pass" : "block",
    reason: parsedFacts.assumptionsReviewed ? undefined : "Material assumptions have not been reviewed",
  });
  dimensions.push({
    dimension: "outcome-changing-questions-resolved",
    status: parsedFacts.outcomeChangingQuestionsResolved ? "pass" : "block",
    reason: parsedFacts.outcomeChangingQuestionsResolved ? undefined : "Outcome-changing questions remain unresolved",
  });
  dimensions.push({
    dimension: "workspace-available",
    status: parsedFacts.workspaceAvailable ? "pass" : "block",
    reason: parsedFacts.workspaceAvailable ? undefined : `Workspace strategy ${parsedBody.workspace} is unavailable`,
  });

  return { ready: dimensions.every((dimension) => dimension.status === "pass"), dimensions };
}
