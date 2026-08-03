import { z } from "zod";
import type { SafeDiagnosticValue } from "./redaction.js";

export const ErrorTagSchema = z.enum([
  "invalid-input",
  "invalid-transition",
  "stale-revision",
  "approval-mismatch",
  "approval-rejected",
  "lifecycle-denial",
  "workspace-failure",
  "workspace-conflict",
  "dispatch-conflict",
  "session-interruption",
  "verification-failure",
  "storage-failure",
  "external-tool-failure",
  "stale-lease",
]);
export type ErrorTag = z.infer<typeof ErrorTagSchema>;

export const ErrorContextSchema = z.object({
  tag: ErrorTagSchema,
  goalId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative().optional(),
  sessionId: z.string().min(1).optional(),
  callId: z.string().min(1).optional(),
  toolId: z.string().min(1).optional(),
  message: z.string().min(1),
  diagnostic: z.unknown().optional(),
}).strict();
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

export class GoatError extends Error {
  readonly tag: ErrorTag;
  readonly goalId?: string;
  readonly revision?: number;
  readonly sessionId?: string;
  readonly callId?: string;
  readonly toolId?: string;
  readonly diagnostic?: SafeDiagnosticValue;

  constructor(context: ErrorContext) {
    const validated = ErrorContextSchema.parse(context);
    super(validated.message);
    this.name = "GoatError";
    this.tag = validated.tag;
    if (validated.goalId !== undefined) this.goalId = validated.goalId;
    if (validated.revision !== undefined) this.revision = validated.revision;
    if (validated.sessionId !== undefined) this.sessionId = validated.sessionId;
    if (validated.callId !== undefined) this.callId = validated.callId;
    if (validated.toolId !== undefined) this.toolId = validated.toolId;
    if (validated.diagnostic !== undefined) this.diagnostic = validated.diagnostic as SafeDiagnosticValue;
  }
}

export function isGoatError(value: unknown): value is GoatError {
  return value instanceof GoatError;
}

export const BlockerCodeSchema = z.enum([
  "approval-not-approved",
  "workspace-preparation-failed",
  "workspace-head-changed",
  "workspace-dirty-at-activation",
  "workspace-concurrent-changes",
  "workspace-comparison-invalid",
  "workspace-changed-during-verification",
  "verification-budget-exhausted",
  "verification-failed",
  "executor-prompt-rejected",
  "verifier-prompt-rejected",
  "multiple-matching-approval-questions",
  "multiple-matching-executor-sessions",
  "multiple-matching-verifier-sessions",
  "multiple-stable-worktrees",
  "resume-worktree-missing",
  "run-workspace-missing",
  "recovery-workspace-invalid",
  "executor-session-mismatch",
  "verifier-session-mismatch",
  "dispatch-identity-mismatch",
  "executor-blocked",
  "user-blocked",
]);
export type BlockerCode = z.infer<typeof BlockerCodeSchema>;
