import { z } from "zod";

export const APPROVAL_OPTION_IDS = ["approve", "revise", "cancel"] as const;

export const NativeApprovalQuestionSchema = z.object({
  questions: z.tuple([
    z.object({
      question: z.string().min(1),
      header: z.string().min(1),
      options: z.tuple([
        z.object({ label: z.literal("Approve and start"), description: z.string().min(1) }).strict(),
        z.object({ label: z.literal("Revise"), description: z.string().min(1) }).strict(),
        z.object({ label: z.literal("Cancel"), description: z.string().min(1) }).strict(),
      ]),
      multiple: z.literal(false),
      custom: z.literal(false),
    }).strict(),
  ]),
}).strict();
export type NativeApprovalQuestion = z.infer<typeof NativeApprovalQuestionSchema>;

const GENERATION_SUFFIX = /[\r\n]+Approval request generation \d+\.?$/;

export function createApprovalQuestion(contractSummary: string, generation = 1): NativeApprovalQuestion {
  const base = `${contractSummary.replace(GENERATION_SUFFIX, "")}\n\nApprove this exact Goal Contract and start execution?`;
  return NativeApprovalQuestionSchema.parse({
    questions: [{
      question: `${base}\n\nApproval request generation ${Math.max(1, Math.floor(generation))}.`,
      header: "Goal Contract approval",
      options: [
        { label: "Approve and start", description: "Approve this exact Contract and prepare execution." },
        { label: "Revise", description: "Return to formulation and create a new revision." },
        { label: "Cancel", description: "Cancel this Goal without changing the target project." },
      ],
      multiple: false,
      custom: false,
    }],
  });
}

const ApprovalOptionSchema = z.object({
  id: z.enum(APPROVAL_OPTION_IDS),
  label: z.string().min(1),
}).strict().readonly();

export const ApprovalResponseMapSchema = z.object({
  approvalId: z.string().min(1),
  goalId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  contractHash: z.string().min(1),
  rootSessionId: z.string().min(1),
  requestId: z.string().min(1).nullable(),
  callId: z.string().min(1),
  canonicalPayload: z.string().min(1),
  expiresAt: z.string().datetime(),
  consumed: z.boolean(),
  questions: z.tuple([
    z.object({
      id: z.literal("contract-approval"),
      options: z.tuple([ApprovalOptionSchema, ApprovalOptionSchema, ApprovalOptionSchema]),
    }).strict().readonly(),
  ]),
}).strict().readonly();
export type ApprovalResponseMap = z.infer<typeof ApprovalResponseMapSchema>;

export const ApprovalAnswerIdentitySchema = z.object({
  approvalId: z.string().min(1),
  goalId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  contractHash: z.string().min(1),
  rootSessionId: z.string().min(1),
  requestId: z.string().min(1).nullable(),
  callId: z.string().min(1),
  canonicalPayload: z.string().min(1),
}).strict().readonly();
export type ApprovalAnswerIdentity = z.infer<typeof ApprovalAnswerIdentitySchema>;

export type ApprovalAnswerValidation =
  | { readonly ok: true; readonly optionId: typeof APPROVAL_OPTION_IDS[number] }
  | { readonly ok: false; readonly reason: "stale-identity" | "expired" | "replay" | "question-cardinality" | "answer-cardinality" | "duplicate-label" | "unknown-label" | "invalid-mapping" };

export function mapApprovalAnswers(mappingValue: unknown, identityValue: unknown, answers: readonly (readonly string[])[], now: Date): ApprovalAnswerValidation {
  const mappingResult = ApprovalResponseMapSchema.safeParse(mappingValue);
  const identityResult = ApprovalAnswerIdentitySchema.safeParse(identityValue);
  if (!mappingResult.success || !identityResult.success) return { ok: false, reason: "invalid-mapping" };
  const mapping = mappingResult.data;
  const identity = identityResult.data;
  const identityKeys: readonly (keyof ApprovalAnswerIdentity)[] = ["approvalId", "goalId", "revision", "contractHash", "rootSessionId", "requestId", "callId", "canonicalPayload"];
  if (identityKeys.some((key) => mapping[key] !== identity[key])) return { ok: false, reason: "stale-identity" };
  if (mapping.consumed) return { ok: false, reason: "replay" };
  if (Date.parse(mapping.expiresAt) <= now.getTime()) return { ok: false, reason: "expired" };
  if (answers.length !== mapping.questions.length) return { ok: false, reason: "question-cardinality" };

  const labels = answers[0];
  if (!labels || labels.length !== 1) return { ok: false, reason: "answer-cardinality" };
  const options = mapping.questions[0].options;
  if (new Set(options.map((option) => option.label)).size !== options.length) return { ok: false, reason: "duplicate-label" };
  const option = options.find((candidate) => candidate.label === labels[0]);
  return option ? { ok: true, optionId: option.id } : { ok: false, reason: "unknown-label" };
}
