import type { SessionIdentity, SessionModel } from "./ports.js";
import type { GoalView, RunView, VerificationResultView } from "../store/store.js";

export type GoatSessionRole = "formulator" | "executor" | "verifier";

export type ExpectedSessionIdentity = {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  readonly parentId: string | null;
  readonly directory: string;
  readonly role: GoatSessionRole;
  readonly model: SessionModel;
  readonly metadata: Record<string, unknown>;
};

export type SessionAssociation =
  | { readonly kind: "unrelated" }
  | { readonly kind: "root"; readonly goal: GoalView }
  | { readonly kind: "executor"; readonly live: boolean; readonly goal: GoalView; readonly run: RunView }
  | { readonly kind: "verifier"; readonly live: boolean; readonly goal: GoalView; readonly run: RunView; readonly result: VerificationResultView };

export function matchesExpectedSessionIdentity(actual: SessionIdentity, expected: ExpectedSessionIdentity, samePath: (left: string, right: string) => boolean): boolean {
  return actual.id === expected.id
    && actual.projectID === expected.projectId
    && actual.workspaceID === expected.workspaceId
    && actual.parentID === expected.parentId
    && samePath(actual.directory, expected.directory)
    && actual.agent === `goat-${expected.role}`
    && !!actual.model
    && actual.model.providerID === expected.model.providerID
    && actual.model.id === expected.model.id
    && (actual.model.variant ?? null) === (expected.model.variant ?? null)
    && JSON.stringify(actual.metadata) === JSON.stringify(expected.metadata);
}

export function buildGoatSessionMetadata(input: {
  role: GoatSessionRole;
  projectId: string;
  goalId: string;
  runId: string;
  sessionKey: string;
  model: SessionModel;
  verificationAttempt?: number;
}): Record<string, unknown> {
  return {
    goat: {
      role: input.role,
      projectId: input.projectId,
      goalId: input.goalId,
      runId: input.runId,
      sessionKey: input.sessionKey,
      providerId: input.model.providerID,
      modelId: input.model.id,
      variant: input.model.variant ?? null,
      ...(input.verificationAttempt === undefined ? {} : { verificationAttempt: input.verificationAttempt }),
    },
  };
}

export function matchesGoatSessionMetadata(metadata: Record<string, unknown> | null, expected: Record<string, unknown>): boolean {
  return JSON.stringify(metadata) === JSON.stringify(expected);
}
