import { z } from "zod";
import { AcceptanceCriterionSchema, type AcceptanceCriterion } from "./contract.js";
import { DEFAULT_MAX_VERIFICATION_ATTEMPTS } from "./state.js";

export const EvidenceSchema = z.object({
  criterionId: z.string().min(1).max(200),
  source: z.string().min(1).max(1_000),
  method: z.string().min(1).max(20_000),
  expectedResult: z.string().min(1).max(20_000),
  actualReference: z.string().min(1).max(100_000),
  producer: z.string().min(1).max(1_000),
  recordedAt: z.string().min(1),
}).strict().readonly();
export type Evidence = z.infer<typeof EvidenceSchema>;

export type CompletionCoverage = { readonly complete: boolean; readonly gaps: readonly string[] };

export function checkCompletionCoverage(criteria: readonly AcceptanceCriterion[], evidence: readonly Evidence[]): CompletionCoverage {
  const gaps: string[] = [];
  for (const criterion of criteria) {
    if (criterion.priority !== "must") continue;
    const hasEvidence = evidence.some((item) => item.criterionId === criterion.id);
    if (!hasEvidence) gaps.push(criterion.id);
  }
  return { complete: gaps.length === 0, gaps };
}

export const VerificationFindingSchema = z.object({
  criterionId: z.string().min(1).max(200),
  result: z.enum(["pass", "fail", "blocked"]),
  evidenceIds: z.array(z.string().min(1).max(200)).max(500),
  note: z.string().min(1).max(20_000).optional(),
}).strict().readonly();
export type VerificationFinding = z.infer<typeof VerificationFindingSchema>;

export const VerificationEvidenceReferenceSchema = z.object({
  evidenceId: z.string().min(1),
  criterionId: z.string().min(1),
}).strict().readonly();
export type VerificationEvidenceReference = z.infer<typeof VerificationEvidenceReferenceSchema>;

export type VerificationDerivation =
  | { readonly ok: true; readonly outcome: "COMPLETED" | "ACTIVE" | "BLOCKED"; readonly findings: readonly VerificationFinding[]; readonly missingMustCriterionIds: readonly string[] }
  | { readonly ok: false; readonly error: "invalid-input" | "duplicate-finding" | "unknown-criterion" | "unknown-evidence" | "evidence-criterion-mismatch" | "passing-must-needs-evidence" };

export function deriveVerificationOutcome(
  criteriaValue: readonly AcceptanceCriterion[],
  evidenceValue: readonly VerificationEvidenceReference[],
  findingsValue: readonly VerificationFinding[],
  attempt: number,
  automaticAttemptLimit = DEFAULT_MAX_VERIFICATION_ATTEMPTS,
): VerificationDerivation {
  const criteriaResult = z.array(AcceptanceCriterionSchema).safeParse(criteriaValue);
  const evidenceResult = z.array(VerificationEvidenceReferenceSchema).safeParse(evidenceValue);
  const findingsResult = z.array(VerificationFindingSchema).safeParse(findingsValue);
  if (!criteriaResult.success || !evidenceResult.success || !findingsResult.success || !Number.isInteger(attempt) || attempt < 1 || !Number.isInteger(automaticAttemptLimit) || automaticAttemptLimit < 1) return { ok: false, error: "invalid-input" };

  const criteria = criteriaResult.data;
  const evidence = new Map(evidenceResult.data.map((item) => [item.evidenceId, item]));
  const findings = findingsResult.data;
  const knownCriteria = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const byCriterion = new Map<string, VerificationFinding>();
  for (const finding of findings) {
    if (byCriterion.has(finding.criterionId)) return { ok: false, error: "duplicate-finding" };
    if (!knownCriteria.has(finding.criterionId)) return { ok: false, error: "unknown-criterion" };
    for (const evidenceId of finding.evidenceIds) {
      const reference = evidence.get(evidenceId);
      if (!reference) return { ok: false, error: "unknown-evidence" };
      if (reference.criterionId !== finding.criterionId) return { ok: false, error: "evidence-criterion-mismatch" };
    }
    if (knownCriteria.get(finding.criterionId)?.priority === "must" && finding.result === "pass" && finding.evidenceIds.length === 0) return { ok: false, error: "passing-must-needs-evidence" };
    byCriterion.set(finding.criterionId, finding);
  }

  const missingMustCriterionIds: string[] = [];
  const normalized = [...findings];
  for (const criterion of criteria) {
    if (criterion.priority !== "must" || byCriterion.has(criterion.id)) continue;
    missingMustCriterionIds.push(criterion.id);
    normalized.push({ criterionId: criterion.id, result: "fail", evidenceIds: [], note: "Verifier did not submit a finding for this MUST criterion." });
  }

  const mustFindings = normalized.filter((finding) => knownCriteria.get(finding.criterionId)?.priority === "must");
  if (mustFindings.some((finding) => finding.result === "blocked")) return { ok: true, outcome: "BLOCKED", findings: normalized, missingMustCriterionIds };
  if (mustFindings.some((finding) => finding.result === "fail")) return { ok: true, outcome: attempt >= automaticAttemptLimit ? "BLOCKED" : "ACTIVE", findings: normalized, missingMustCriterionIds };
  return { ok: true, outcome: "COMPLETED", findings: normalized, missingMustCriterionIds };
}
