import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/core/canonical.js";
import { createRevision, evaluateReadiness, isApprovedVerificationCommand, type ContractBody, type ReadyGateFacts } from "../src/core/contract.js";
import { deriveVerificationOutcome } from "../src/core/evidence.js";
import { canTransition, canTransitionRun, type GoalState } from "../src/core/state.js";
import { guardGenericTool, isRegisteredGoatTool, ROLE_CAPABILITIES, sessionDenyRules, validateGoatToolAccess } from "../src/core/role-capabilities.js";
import { createApprovalQuestion, mapApprovalAnswers } from "../src/core/question.js";
import { assertExecutorOwnsSnapshot, assertSnapshotUnchanged, buildSnapshot, canonicalizeDiff, canonicalizeExecutorDiff, canonicalizeStatus, validateWorkspaceToolArguments, type CanonicalDiffEntry, type WorkspaceSnapshot } from "../src/core/workspace.js";

const body: ContractBody = { sourceRequest: "add auth", outcome: "authentication works", scope: { included: ["login"], excluded: [] }, constraints: [], assumptions: [], workspace: "current" };
const mustCriterion = { id: "auth", priority: "must" as const, description: "login works", verification: [{ kind: "command" as const, command: "run auth test" }] };
const readyFacts: ReadyGateFacts = { outcomeObservable: true, constraintsReviewed: true, assumptionsReviewed: true, outcomeChangingQuestionsResolved: true, workspaceAvailable: true, infeasibleCriterionIds: [] };

describe("Goat state", () => {
  test("terminal states are absorbing and preparation may block", () => {
    for (const state of ["COMPLETED", "CANCELLED"] satisfies GoalState[]) {
      for (const target of ["FORMING", "AWAITING_APPROVAL", "ACTIVE", "VERIFYING", "PAUSED", "BLOCKED", "COMPLETED", "CANCELLED"] satisfies GoalState[]) expect(canTransition(state, target)).toBe(false);
    }
    expect(canTransition("AWAITING_APPROVAL", "BLOCKED")).toBe(true);
    expect(canTransition("ACTIVE", "FORMING")).toBe(true);
    expect(canTransition("VERIFYING", "FORMING")).toBe(true);
    expect(canTransition("BLOCKED", "AWAITING_APPROVAL")).toBe(true);
  });

  test("run transitions enforce the execution loop", () => {
    expect(canTransitionRun("PREPARING", "ACTIVE")).toBe(true);
    expect(canTransitionRun("PREPARING", "BLOCKED")).toBe(true);
     expect(canTransitionRun("ACTIVE", "FINALIZING")).toBe(true);
     expect(canTransitionRun("FINALIZING", "VERIFYING")).toBe(true);
    expect(canTransitionRun("ACTIVE", "PAUSED")).toBe(true);
    expect(canTransitionRun("VERIFYING", "COMPLETED")).toBe(true);
    expect(canTransitionRun("VERIFYING", "ACTIVE")).toBe(true);
    expect(canTransitionRun("BLOCKED", "ACTIVE")).toBe(true);
    expect(canTransitionRun("COMPLETED", "ACTIVE")).toBe(false);
    expect(canTransitionRun("ACTIVE", "COMPLETED")).toBe(false);
  });
});

describe("Contract and canonicalization", () => {
  test("canonical Contract revision sorting is locale-independent", () => {
    const first = createRevision("goal-1", 0, body, [{ id: "z", priority: "should", description: "docs", verification: [{ kind: "inspection", description: "inspect" }] }, mustCriterion], "2026-08-01T00:00:00.000Z");
    const second = createRevision("goal-1", 0, body, [mustCriterion, { id: "z", priority: "should", description: "docs", verification: [{ kind: "inspection", description: "inspect" }] }], "2026-08-01T00:00:00.000Z");
    expect(first.hash).toBe(second.hash);
    expect(canonicalJson({ value: -0 })).toBe(canonicalJson({ value: 0 }));
    expect(() => canonicalJson([, "value"])).toThrow(/sparse array/);
    expect(() => canonicalJson(Number.NaN)).toThrow(/finite/);
  });

  test("Ready Gate accepts explicitly reviewed empty constraints and assumptions", () => {
    expect(evaluateReadiness(body, [mustCriterion], readyFacts).ready).toBe(true);
  });

  test("only exact command verification steps are executable", () => {
    expect(isApprovedVerificationCommand([mustCriterion], "run auth test")).toBe(true);
    expect(isApprovedVerificationCommand([mustCriterion], "run auth test --verbose")).toBe(false);
    expect(isApprovedVerificationCommand([{ id: "inspect", priority: "must", description: "inspect", verification: [{ kind: "inspection", description: "read the result" }] }], "read result")).toBe(false);
  });

  test("Ready Gate blocks unresolved decisions, unavailable workspace, and infeasible criteria", () => {
    const result = evaluateReadiness(body, [mustCriterion], { ...readyFacts, outcomeChangingQuestionsResolved: false, workspaceAvailable: false, infeasibleCriterionIds: ["auth"] });
    expect(result.ready).toBe(false);
    expect(result.dimensions.filter((item) => item.status === "block").map((item) => item.dimension)).toEqual(["criteria-verifiable", "outcome-changing-questions-resolved", "workspace-available"]);
  });
});

describe("Approval mapping", () => {
  const mapping = {
    approvalId: "approval-1", goalId: "goal-1", revision: 0, contractHash: "hash-1", rootSessionId: "root-1", requestId: "request-1", callId: "call-1", canonicalPayload: "payload-1", expiresAt: "2026-08-01T01:00:00.000Z", consumed: false,
    questions: [{ id: "contract-approval" as const, options: [{ id: "approve" as const, label: "Approve and start" }, { id: "revise" as const, label: "Revise" }, { id: "cancel" as const, label: "Cancel" }] }] as const,
  };
  const identity = { approvalId: "approval-1", goalId: "goal-1", revision: 0, contractHash: "hash-1", rootSessionId: "root-1", requestId: "request-1", callId: "call-1", canonicalPayload: "payload-1" };

  test("maps one exact nested label to its stored option ID", () => {
    expect(createApprovalQuestion("Outcome: authentication works").questions[0].question).toContain("Outcome: authentication works");
    expect(mapApprovalAnswers(mapping, identity, [["Approve and start"]], new Date("2026-08-01T00:00:00.000Z"))).toEqual({ ok: true, optionId: "approve" });
  });

  test("generations are distinct canonical payloads", () => {
    const first = createApprovalQuestion("Outcome: authentication works", 1);
    const second = createApprovalQuestion("Outcome: authentication works", 2);
    expect(first.questions[0].question).not.toBe(second.questions[0].question);
    expect(first.questions[0].question).toContain("Approval request generation 1.");
    expect(second.questions[0].question).toContain("Approval request generation 2.");
    expect(canonicalJson(first)).not.toBe(canonicalJson(second));
  });

  test("rejects stale identity, replay, expiry, and malformed cardinality", () => {
    expect(mapApprovalAnswers(mapping, { ...identity, contractHash: "stale" }, [["Approve and start"]], new Date("2026-08-01T00:00:00.000Z"))).toEqual({ ok: false, reason: "stale-identity" });
    expect(mapApprovalAnswers({ ...mapping, consumed: true }, identity, [["Approve and start"]], new Date("2026-08-01T00:00:00.000Z"))).toEqual({ ok: false, reason: "replay" });
    expect(mapApprovalAnswers(mapping, identity, [["Approve and start"]], new Date("2026-08-01T01:00:00.000Z"))).toEqual({ ok: false, reason: "expired" });
    expect(mapApprovalAnswers(mapping, identity, [], new Date("2026-08-01T00:00:00.000Z"))).toEqual({ ok: false, reason: "question-cardinality" });
  });
});

describe("Evidence and verification", () => {
  const evidence = [{ evidenceId: "evidence-1", criterionId: "auth" }];

  test("derives a missing MUST finding as failure", () => {
    const result = deriveVerificationOutcome([mustCriterion], evidence, [], 1);
    expect(result.ok && result.outcome).toBe("ACTIVE");
    expect(result.ok && result.missingMustCriterionIds).toEqual(["auth"]);
  });

  test("blocks the tenth failure and allows SHOULD failures", () => {
    expect(deriveVerificationOutcome([mustCriterion], evidence, [{ criterionId: "auth", result: "fail", evidenceIds: ["evidence-1"] }], 9)).toMatchObject({ ok: true, outcome: "ACTIVE" });
    expect(deriveVerificationOutcome([mustCriterion], evidence, [{ criterionId: "auth", result: "fail", evidenceIds: ["evidence-1"] }], 10)).toMatchObject({ ok: true, outcome: "BLOCKED" });
    expect(deriveVerificationOutcome([mustCriterion, { id: "docs", priority: "should", description: "docs", verification: [{ kind: "inspection", description: "inspect" }] }], evidence, [{ criterionId: "auth", result: "pass", evidenceIds: ["evidence-1"] }, { criterionId: "docs", result: "fail", evidenceIds: [] }], 1)).toMatchObject({ ok: true, outcome: "COMPLETED" });
  });

  test("requires criterion-matched evidence for a passing MUST", () => {
    expect(deriveVerificationOutcome([mustCriterion], evidence, [{ criterionId: "auth", result: "pass", evidenceIds: [] }], 1)).toEqual({ ok: false, error: "passing-must-needs-evidence" });
    expect(deriveVerificationOutcome([mustCriterion], [{ evidenceId: "evidence-1", criterionId: "other" }], [{ criterionId: "auth", result: "pass", evidenceIds: ["evidence-1"] }], 1)).toEqual({ ok: false, error: "evidence-criterion-mismatch" });
  });
});

describe("Role capabilities", () => {
  test("only the exact six Goat tools are registered", () => {
    expect(isRegisteredGoatTool("goat_state")).toBe(true);
    expect(isRegisteredGoatTool("goat_state_attack")).toBe(false);
    expect(isRegisteredGoatTool("goat_custom")).toBe(false);
  });

  test("generic tools follow the fixed role matrix", () => {
    expect(guardGenericTool("FORMING", "formulator", "read")).toEqual({ allowed: true });
    expect(guardGenericTool("FORMING", "formulator", "question")).toEqual({ allowed: true });
    expect(guardGenericTool("FORMING", "formulator", "edit").allowed).toBe(false);
    expect(guardGenericTool("FORMING", "formulator", "bash").allowed).toBe(false);
    expect(guardGenericTool("FORMING", "formulator", "task").allowed).toBe(false);
    expect(guardGenericTool("BLOCKED", "formulator", "mcp_side_effect").allowed).toBe(false);
    expect(guardGenericTool("ACTIVE", "verifier", "edit").allowed).toBe(false);
    expect(guardGenericTool("ACTIVE", "verifier", "question").allowed).toBe(false);
    expect(guardGenericTool("ACTIVE", "executor", "edit")).toEqual({ allowed: true });
    expect(guardGenericTool("ACTIVE", "executor", "apply_patch")).toEqual({ allowed: true });
    expect(guardGenericTool("ACTIVE", "executor", "question").allowed).toBe(false);
    expect(guardGenericTool("PAUSED", "executor", "edit").allowed).toBe(false);
    expect(guardGenericTool("PAUSED", "executor", "read")).toEqual({ allowed: true });
  });

  test("Goat mutations require exact role, state, binding, lease, and workspace", () => {
    const valid = { toolId: "goat_evidence_record" as const, state: "ACTIVE" as const, role: "executor" as const, sessionBindingMatchesRole: true, leaseOwned: true, workspaceMatches: true };
    expect(validateGoatToolAccess(valid)).toEqual({ allowed: true });
    expect(validateGoatToolAccess({ ...valid, role: "formulator" }).allowed).toBe(false);
    expect(validateGoatToolAccess({ ...valid, leaseOwned: false }).allowed).toBe(false);
    expect(validateGoatToolAccess({ ...valid, workspaceMatches: false }).allowed).toBe(false);
    expect(validateGoatToolAccess({ ...valid, state: "VERIFYING" }).allowed).toBe(false);
  });

  test("child Session permission envelopes are generated from capabilities", () => {
    expect(sessionDenyRules("executor")).toEqual([
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "question", pattern: "*", action: "deny" },
    ]);
    expect(sessionDenyRules("verifier")).toEqual([
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "write", pattern: "*", action: "deny" },
      { permission: "apply_patch", pattern: "*", action: "deny" },
      { permission: "task", pattern: "*", action: "deny" },
      { permission: "question", pattern: "*", action: "deny" },
    ]);
    expect(sessionDenyRules("formulator")).toEqual([]);
    expect(ROLE_CAPABILITIES.formulator.agentId).toBe("goat-formulator");
    expect(ROLE_CAPABILITIES.verifier.mode).toBe("subagent");
  });
});

describe("Workspace snapshots", () => {
  const head = "a".repeat(40);
  const platform = "linux";
  const entry = (path: string, patch: string, status: "added" | "modified" | "deleted" = "modified"): CanonicalDiffEntry => ({ path, status, additions: 1, deletions: 1, patch });

  function snapshot(diff: readonly CanonicalDiffEntry[], untracked: { path: string; contentHash: string }[] = []): WorkspaceSnapshot {
    return buildSnapshot({ head, status: diff.map((item) => ({ path: item.path, status: item.status, additions: item.additions, deletions: item.deletions })), diff, untracked, rawDiff: "", platform });
  }

  test("canonicalization normalizes paths, rejects duplicates and missing patches", () => {
    expect(canonicalizeStatus([{ file: "a\\b.txt", status: "modified", additions: 1, deletions: 0 }], "win32")).toMatchObject({ ok: true, entries: [{ path: "a/b.txt", status: "modified" }] });
    expect(canonicalizeStatus([{ file: "a", status: "modified", additions: 1, deletions: 0 }, { file: "a", status: "modified", additions: 1, deletions: 0 }], "linux")).toMatchObject({ ok: false });
    expect(canonicalizeDiff([{ file: "a", status: "modified", additions: 1, deletions: 1 }], "linux")).toEqual({ ok: false, code: "patch-missing" });
    expect(canonicalizeDiff([{ file: "../escape", status: "modified", additions: 1, deletions: 1, patch: "x" }], "linux")).toEqual({ ok: false, code: "invalid-diff-shape" });
    expect(canonicalizeDiff([{ file: "a", status: "modified", additions: 1, deletions: 1, patch: "x" }], "linux")).toMatchObject({ ok: true, entries: [{ path: "a", patch: "x" }] });
  });

  test("an unchanged workspace passes with no executor diff", () => {
    const base = snapshot([]);
    expect(assertExecutorOwnsSnapshot(base, snapshot([]), [])).toEqual({ ok: true });
  });

  test("workspace tool targets stay inside the approved directory", () => {
    const root = process.cwd();
    const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
    expect(validateWorkspaceToolArguments("write", { filePath: "src/app.ts" }, root, platform)).toEqual({ ok: true });
    expect(validateWorkspaceToolArguments("write", { filePath: "../outside.ts" }, root, platform).ok).toBe(false);
    expect(validateWorkspaceToolArguments("edit", { filePath: "../outside.ts" }, root, platform).ok).toBe(false);
    expect(validateWorkspaceToolArguments("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/app.ts\n*** End Patch" }, root, platform)).toEqual({ ok: true });
    expect(validateWorkspaceToolArguments("apply_patch", { patch: "*** Begin Patch\n*** Update File: ../outside.ts\n*** End Patch" }, root, platform).ok).toBe(false);
    expect(validateWorkspaceToolArguments("bash", {}, root, platform).ok).toBe(true);
  });

  test("status-only changes require Executor attribution", () => {
    const base = snapshot([]);
    const changed = buildSnapshot({ head, status: [{ path: "mode-only", status: "modified", additions: 0, deletions: 0 }], diff: [], untracked: [], platform });
    expect(assertExecutorOwnsSnapshot(base, changed, [])).toMatchObject({ ok: false, code: "unattributed-change" });
  });

  test("an exact executor diff attributes a final change", () => {
    const base = snapshot([]);
    const change = entry("src/main.ts", "patch-a");
    expect(assertExecutorOwnsSnapshot(base, snapshot([change]), [change])).toEqual({ ok: true });
  });

  test("a matching file set with different patch content fails closed", () => {
    const base = snapshot([]);
    expect(assertExecutorOwnsSnapshot(base, snapshot([entry("src/main.ts", "patch-b")]), [entry("src/main.ts", "patch-a")])).toMatchObject({ ok: false, code: "unattributed-change" });
  });

  test("equivalent diff hunks with different line ranges are accepted", () => {
    const base = snapshot([]);
    const finalPatch = "diff --git a/src/main.ts b/src/main.ts\nindex 000..111\n--- /dev/null\n+++ b/src/main.ts\n@@ -0,0 +1,1 @@\n+content\n";
    const executorPatch = "diff --git a/src/main.ts b/src/main.ts\nindex 000..111\n--- /dev/null\n+++ b/src/main.ts\n@@ -0,0 +1 @@\n+content\n";
    expect(assertExecutorOwnsSnapshot(base, snapshot([entry("src/main.ts", finalPatch)]), [entry("src/main.ts", executorPatch)])).toEqual({ ok: true });
  });

  test("a file already dirty at baseline changed again during the run fails closed", () => {
    const base = snapshot([entry("src/main.ts", "patch-base")]);
    expect(assertExecutorOwnsSnapshot(base, snapshot([entry("src/main.ts", "patch-base"), entry("src/other.ts", "patch-x")]), [entry("src/other.ts", "patch-x")])).toEqual({ ok: true });
    expect(assertExecutorOwnsSnapshot(base, snapshot([entry("src/main.ts", "patch-concurrent"), entry("src/other.ts", "patch-x")]), [entry("src/other.ts", "patch-x")])).toMatchObject({ ok: false, code: "unattributed-change" });
  });

  test("an unexplained added file fails closed", () => {
    const base = snapshot([]);
    expect(assertExecutorOwnsSnapshot(base, snapshot([entry("new.ts", "patch-n", "added")]), [])).toMatchObject({ ok: false, code: "unattributed-change" });
  });

  test("new untracked files require a patchful executor attribution", () => {
    const base = snapshot([]);
    const patch = "diff --git a/untracked.txt b/untracked.txt\n--- /dev/null\n+++ b/untracked.txt\n@@ -0,0 +1 @@\n+content\n";
    const untracked = { path: "untracked.txt", contentHash: "434728a410a78f56fc1b5899c3593436e61ab0c731e9072d95e96db290205e53" };
    expect(assertExecutorOwnsSnapshot(base, snapshot([], [untracked]), [])).toMatchObject({ ok: false, code: "attribution-incomplete" });
    expect(assertExecutorOwnsSnapshot(base, snapshot([], [untracked]), [entry("untracked.txt", patch, "added")])).toEqual({ ok: true });
    expect(assertExecutorOwnsSnapshot(base, snapshot([], [{ ...untracked, contentHash: "c".repeat(64) }]), [entry("untracked.txt", patch, "added")])).toMatchObject({ ok: false, code: "attribution-incomplete" });
  });

  test("a moved HEAD fails closed", () => {
    const base = snapshot([]);
    const moved = { ...snapshot([]), head: "b".repeat(40) };
    expect(assertExecutorOwnsSnapshot(base, moved, [])).toMatchObject({ ok: false, code: "head-changed" });
  });

  test("executor diff with a missing patch is attribution-incomplete", () => {
    expect(canonicalizeExecutorDiff([{ file: "a", status: "modified", additions: 1, deletions: 1 }], platform)).toEqual({ ok: false, code: "patch-missing" });
  });

  test("removed files must be attributed as deletions", () => {
    const base = snapshot([entry("gone.ts", "patch-g")]);
    const final = snapshot([]);
    expect(assertExecutorOwnsSnapshot(base, final, [])).toMatchObject({ ok: false, code: "unattributed-change" });
    expect(assertExecutorOwnsSnapshot(base, final, [entry("gone.ts", "patch-g", "deleted")])).toEqual({ ok: true });
    expect(assertSnapshotUnchanged(base, snapshot([]))).toMatchObject({ ok: false, code: "unattributed-change" });
  });
});
