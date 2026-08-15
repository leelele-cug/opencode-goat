import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/canonical.js";
import { createRevision, evaluateReadiness, isApprovedVerificationCommand, type ContractBody, type ReadyGateFacts } from "../src/core/contract.js";
import { deriveVerificationOutcome } from "../src/core/evidence.js";
import { canTransition, ownerForState, type WorkflowState } from "../src/core/state.js";
import { guardGenericTool, isRegisteredGoatTool, ROLE_CAPABILITIES, sessionDenyRules, validateGoatToolAccess } from "../src/core/role-capabilities.js";
import { createApprovalQuestion, mapApprovalAnswers } from "../src/core/question.js";
import { assertHeadUnchanged, assertSnapshotUnchanged, buildSnapshot, canonicalizeDiff, canonicalizeStatus, validateWorkspaceToolArguments, type CanonicalDiffEntry, type WorkspaceSnapshot } from "../src/core/workspace.js";
import { requiresLiveLease } from "../src/runtime/invocation-policy.js";

const body: ContractBody = { sourceRequest: "add auth", outcome: "authentication works", scope: { included: ["login"], excluded: [] }, constraints: [], assumptions: [] };
const mustCriterion = { id: "auth", priority: "must" as const, description: "login works", verification: [{ kind: "command" as const, command: "run auth test" }] };
const readyFacts: ReadyGateFacts = { outcomeObservable: true, constraintsReviewed: true, assumptionsReviewed: true, outcomeChangingQuestionsResolved: true, infeasibleCriterionIds: [] };

describe("Goat state", () => {
  test("terminal states are absorbing and the workflow has explicit preparation/finalization phases", () => {
     for (const state of ["COMPLETED", "CANCELLED"] satisfies WorkflowState[]) {
       for (const target of ["PLANNING", "AWAITING_APPROVAL", "PREPARING", "EXECUTING", "FINALIZING_EXECUTION", "VERIFYING", "FINALIZING_VERIFICATION", "PAUSED", "BLOCKED", "COMPLETED", "CANCELLED"] satisfies WorkflowState[]) expect(canTransition(state, target)).toBe(false);
    }
    expect(canTransition("AWAITING_APPROVAL", "PREPARING")).toBe(true);
     expect(canTransition("PREPARING", "EXECUTING")).toBe(true);
     expect(canTransition("EXECUTING", "FINALIZING_EXECUTION")).toBe(true);
     expect(canTransition("FINALIZING_EXECUTION", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "FINALIZING_VERIFICATION")).toBe(true);
    expect(canTransition("BLOCKED", "AWAITING_APPROVAL")).toBe(true);
    expect(ownerForState("FINALIZING_EXECUTION")).toBe("orchestrator");
    expect(ownerForState("EXECUTING")).toBe("executor");
  });
});

describe("Contract and approval", () => {
  test("canonical Contract revision sorting is locale-independent", () => {
    const first = createRevision("goal-1", 0, body, [{ id: "z", priority: "should", description: "docs", verification: [{ kind: "inspection", description: "inspect" }] }, mustCriterion], "2026-08-01T00:00:00.000Z");
    const second = createRevision("goal-1", 0, body, [mustCriterion, { id: "z", priority: "should", description: "docs", verification: [{ kind: "inspection", description: "inspect" }] }], "2026-08-01T00:00:00.000Z");
    expect(first.hash).toBe(second.hash);
    expect(canonicalJson({ value: -0 })).toBe(canonicalJson({ value: 0 }));
  });

  test("Ready Gate accepts explicitly reviewed constraints and assumptions", () => {
    expect(evaluateReadiness(body, [mustCriterion], readyFacts).ready).toBe(true);
    expect(evaluateReadiness(body, [mustCriterion], { ...readyFacts, outcomeChangingQuestionsResolved: false, infeasibleCriterionIds: ["auth"] }).ready).toBe(false);
  });

  test("only exact command verification steps are executable", () => {
    expect(isApprovedVerificationCommand([mustCriterion], "run auth test")).toBe(true);
    expect(isApprovedVerificationCommand([mustCriterion], "run auth test --verbose")).toBe(false);
  });

  test("approval mapping rejects stale identity and replay", () => {
    const mapping = { approvalId: "approval-1", goalId: "goal-1", revision: 0, contractHash: "hash-1", rootSessionId: "root-1", requestId: "request-1", callId: "call-1", canonicalPayload: "payload-1", expiresAt: "2026-08-01T01:00:00.000Z", consumed: false, questions: [{ id: "contract-approval" as const, options: [{ id: "approve" as const, label: "Approve and start" }, { id: "revise" as const, label: "Revise" }, { id: "cancel" as const, label: "Cancel" }] }] as const };
    const identity = { approvalId: "approval-1", goalId: "goal-1", revision: 0, contractHash: "hash-1", rootSessionId: "root-1", requestId: "request-1", callId: "call-1", canonicalPayload: "payload-1" };
    expect(mapApprovalAnswers(mapping, { ...identity, contractHash: "stale" }, [["Approve and start"]], new Date("2026-08-01T00:00:00.000Z"))).toEqual({ ok: false, reason: "stale-identity" });
    expect(mapApprovalAnswers({ ...mapping, consumed: true }, identity, [["Approve and start"]], new Date("2026-08-01T00:00:00.000Z"))).toEqual({ ok: false, reason: "replay" });
    expect(createApprovalQuestion("Outcome: authentication works").questions[0].question).toContain("Outcome: authentication works");
  });
});

describe("Evidence and roles", () => {
  test("missing MUST evidence requests correction while an actionable blocker stops verification", () => {
    const evidence = [{ evidenceId: "evidence-1", criterionId: "auth" }];
    expect(deriveVerificationOutcome([mustCriterion], evidence, [])).toMatchObject({ ok: true, outcome: "EXECUTING" });
    expect(deriveVerificationOutcome([mustCriterion], evidence, [{ criterionId: "auth", result: "blocked", evidenceIds: ["evidence-1"] }])).toMatchObject({ ok: true, outcome: "BLOCKED" });
  });

  test("only the fixed Goat tools are registered", () => {
    expect(isRegisteredGoatTool("goat_state")).toBe(true);
    expect(isRegisteredGoatTool("goat_state_attack")).toBe(false);
     expect(guardGenericTool("EXECUTING", "executor", "edit")).toEqual({ allowed: true });
     expect(guardGenericTool("EXECUTING", "verifier", "edit").allowed).toBe(false);
     expect(validateGoatToolAccess({ toolId: "goat_evidence_record", state: "EXECUTING", role: "executor", sessionBindingMatchesRole: true, leaseOwned: true, workspaceMatches: true })).toEqual({ allowed: true });
    expect(sessionDenyRules("verifier")).toContainEqual({ permission: "edit", pattern: "*", action: "deny" });
    expect(ROLE_CAPABILITIES.verifier.mode).toBe("subagent");
  });
});

describe("Workspace snapshots", () => {
  const head = "a".repeat(40);
  const platform = "linux";
  const entry = (path: string): CanonicalDiffEntry => ({ path, status: "modified", additions: 1, deletions: 1, patch: "patch" });
  const snapshot = (diff: readonly CanonicalDiffEntry[] = []): WorkspaceSnapshot => buildSnapshot({ head, status: diff.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })), diff, untracked: [], platform });

  test("canonicalization normalizes paths and rejects invalid diffs", () => {
    expect(canonicalizeStatus([{ file: "a\\b.txt", status: "modified", additions: 1, deletions: 0 }], "win32")).toMatchObject({ ok: true, entries: [{ path: "a/b.txt" }] });
    expect(canonicalizeDiff([{ file: "a", status: "modified", additions: 1, deletions: 1 }], platform)).toEqual({ ok: false, code: "patch-missing" });
    expect(canonicalizeDiff([{ file: "../escape", status: "modified", additions: 1, deletions: 1, patch: "x" }], platform)).toEqual({ ok: false, code: "invalid-diff-shape" });
  });

  test("Git HEAD changes fail closed while ordinary worktree changes remain observable", () => {
    expect(assertHeadUnchanged(snapshot(), snapshot())).toEqual({ ok: true });
    expect(assertHeadUnchanged(snapshot(), { ...snapshot(), head: "b".repeat(40) })).toMatchObject({ ok: false, code: "head-changed" });
    expect(assertSnapshotUnchanged(snapshot(), buildSnapshot({ head, status: ["x.ts"].map((path) => ({ path, status: "modified", additions: 1, deletions: 1 })), diff: [entry("x.ts")], untracked: [], platform }))).toMatchObject({ ok: false, code: "workspace-changed" });
  });

  test("tool targets stay inside the approved directory", () => {
    const root = process.cwd();
    const currentPlatform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    expect(validateWorkspaceToolArguments("write", { filePath: "src/app.ts" }, root, currentPlatform)).toEqual({ ok: true });
    expect(validateWorkspaceToolArguments("write", { filePath: "../outside.ts" }, root, currentPlatform).ok).toBe(false);
    expect(validateWorkspaceToolArguments("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch" }, root, currentPlatform)).toEqual({ ok: true });
    expect(validateWorkspaceToolArguments("bash", { command: "bun test" }, root, currentPlatform)).toEqual({ ok: true });
    expect(validateWorkspaceToolArguments("bash", { command: "git commit -am nope" }, root, currentPlatform)).toEqual({ ok: false, error: "git-lifecycle-command-forbidden" });
    expect(validateWorkspaceToolArguments("bash", { command: "cd .. && bun test" }, root, currentPlatform)).toEqual({ ok: false, error: "workspace-shell-boundary-forbidden" });
    expect(requiresLiveLease("executor", "edit")).toBe(true);
    expect(requiresLiveLease("verifier", "read")).toBe(false);
  });
});
