import { expect, test } from "bun:test";
import { openDatabase } from "../src/store/database.js";
import { EXPECTED_SCHEMA_SIGNATURE, initializeSchema, SCHEMA_VERSION } from "../src/store/schema.js";
import { Store } from "../src/store/store.js";
import { buildSnapshot, type WorkspaceSnapshot } from "../src/core/workspace.js";

const readyGateFacts = { outcomeObservable: true, constraintsReviewed: true, assumptionsReviewed: true, outcomeChangingQuestionsResolved: true, workspaceAvailable: true, infeasibleCriterionIds: [] } as const;
const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const projectDirectory = platform === "win32" ? "C:\\Project" : "/tmp/goat-project";
const origin = { projectId: "project-1", rootWorkspaceId: null, projectDirectory, worktreeOrigin: projectDirectory };
const model = { providerID: "test-provider", id: "test-model" };

function freshStore(now = "2026-08-01T00:00:00.000Z") {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  let sequence = 0;
  let current = new Date(now);
  const store = new Store(db, { now: () => new Date(current) }, { next: () => `id-${++sequence}` }, "instance-1");
  return { db, store, advance: (ms: number) => { current = new Date(current.getTime() + ms); } };
}

function snapshot(commit = "a".repeat(40)): WorkspaceSnapshot {
  return buildSnapshot({ head: commit, status: [], diff: [], untracked: [], rawDiff: "", platform });
}

function createProposedApproved(store: Store, workspace: "current" | "worktree" = "current"): { goalId: string; token: number; runId: string; dispatchId: string } {
  const created = store.createGoal("store test", "root-session", origin, model);
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  const token = store.getOwnedFencingToken(goalId)!;
  const proposal = store.proposeContract(goalId, token, { outcome: "works", scope: { included: ["x"], excluded: [] }, constraints: [], assumptions: [], workspace }, [{ id: "c", priority: "must", description: "works", verification: [{ kind: "inspection", description: "inspect" }] }], readyGateFacts, "proposal-key-1", { head: "a".repeat(40), clean: true });
  if (!proposal.ok || !proposal.ready) throw new Error("proposal failed");
  const bound = store.bindApprovalQuestion(goalId, token, "call-1", proposal.nativeQuestion);
  if (!bound.ok) throw new Error(bound.error);
  const approved = store.resolveApproval(goalId, token, "call-1", [["Approve and start"]]);
  if (!approved.ok || approved.action !== "approved") throw new Error("approval failed");
  return { goalId, token, runId: approved.runId, dispatchId: approved.dispatchId };
}

test("end-to-end approval, activation, evidence, and verification completion", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId, dispatchId } = createProposedApproved(store);
    expect(store.recordWorkspacePrepared(goalId, token, runId, "C:\\Project").ok).toBe(true);
    const activated = store.activateRun(goalId, token, runId, snapshot());
    if (!activated.ok) throw new Error(activated.error);
    expect(activated.dispatchId).toBe(dispatchId);
    expect(store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model).ok).toBe(true);
    expect(store.markDispatchSent(dispatchId, token, "executor-session").ok).toBe(true);
    expect(store.markDispatchStarted(dispatchId, token).ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("ACTIVE");
    expect(store.getSessionBinding("executor-session")).toMatchObject({ role: "executor", goal: { goalId }, run: { runId } });

    const evidence = store.recordEvidence(goalId, token, runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: "executor-session" }, "evidence-key-1");
    if (!evidence.ok) throw new Error(evidence.error);
    expect(store.recordEvidence(goalId, token, runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: "executor-session" }, "evidence-key-1")).toEqual({ ok: true, evidenceId: evidence.evidenceId });

    expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
    expect(store.getRun(goalId)?.status).toBe("FINALIZING");
    const completion = store.proposeCompletion(goalId, token, runId, snapshot(), [], "completion-key-1");
    if (!completion.ok) throw new Error(completion.error);
    expect(store.proposeCompletion(goalId, token, runId, snapshot(), [], "completion-key-1")).toEqual(completion);
    expect(store.getGoal(goalId)?.state).toBe("VERIFYING");

    expect(store.bindVerifierSession(goalId, token, completion.dispatchId, "verifier-session", "verifier-key-1").ok).toBe(true);
    const reported = store.recordVerificationAndMaybeRemediate(goalId, token, runId, "verifier-session", [{ criterionId: "c", result: "pass", evidenceIds: [evidence.evidenceId] }], snapshot());
    if (!reported.ok) throw new Error(reported.error);
    expect(reported.outcome).toBe("VERIFYING");
    expect(store.completeVerifiedRun(goalId, token, runId, snapshot()).ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("COMPLETED");
    expect(store.getRun(goalId)?.status).toBe("COMPLETED");
    expect(store.ownsLease(goalId)).toBe(false);
    expect(store.getSessionBinding("executor-session")).toMatchObject({ role: "revoked", revokedRole: "executor" });
    expect(store.getSessionBinding("verifier-session")).toMatchObject({ role: "revoked", revokedRole: "verifier" });
  } finally { db.close(); }
});

test("verification failure creates a remediation dispatch and returns to ACTIVE", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = createProposedApproved(store);
    store.recordWorkspacePrepared(goalId, token, runId, "C:\\Project");
    store.activateRun(goalId, token, runId, snapshot());
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model);
    const evidence = store.recordEvidence(goalId, token, runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: "executor-session" }, "evidence-key-1");
    if (!evidence.ok) throw new Error(evidence.error);
    expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
    const completion = store.proposeCompletion(goalId, token, runId, snapshot(), [], "completion-key-1");
    if (!completion.ok) throw new Error(completion.error);
    store.bindVerifierSession(goalId, token, completion.dispatchId, "verifier-session", "verifier-key-1");
    const reported = store.recordVerificationAndMaybeRemediate(goalId, token, runId, "verifier-session", [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }]);
    if (!reported.ok) throw new Error(reported.error);
    expect(reported.outcome).toBe("ACTIVE");
    expect(reported.dispatchId).toBeDefined();
    expect(store.getGoal(goalId)?.state).toBe("ACTIVE");
    expect(store.getDispatch(reported.dispatchId!)?.kind).toBe("executor-remediation");
  } finally { db.close(); }
});

test("the tenth failure blocks and resume starts a new ten-round batch", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = createProposedApproved(store);
    store.recordWorkspacePrepared(goalId, token, runId, "C:\\Project");
    store.activateRun(goalId, token, runId, snapshot());
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model);
    const evidence = store.recordEvidence(goalId, token, runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: "executor-session" }, "evidence-key-1");
    if (!evidence.ok) throw new Error(evidence.error);
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
      const completion = store.proposeCompletion(goalId, token, runId, snapshot(), [], `completion-key-${attempt}`);
      if (!completion.ok) throw new Error(completion.error);
      store.bindVerifierSession(goalId, token, completion.dispatchId, `verifier-${attempt}`, `verifier-key-${attempt}`);
      const reported = store.recordVerificationAndMaybeRemediate(goalId, token, runId, `verifier-${attempt}`, [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }]);
      if (!reported.ok || reported.outcome !== "ACTIVE") throw new Error(`attempt ${attempt} did not remediate`);
    }
    expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
    const tenth = store.proposeCompletion(goalId, token, runId, snapshot(), [], "completion-key-10");
    if (!tenth.ok) throw new Error(tenth.error);
    store.bindVerifierSession(goalId, token, tenth.dispatchId, "verifier-10", "verifier-key-10");
    const tenthReport = store.recordVerificationAndMaybeRemediate(goalId, token, runId, "verifier-10", [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }]);
    if (!tenthReport.ok) throw new Error(tenthReport.error);
    expect(tenthReport.outcome).toBe("BLOCKED");
    expect(store.getGoal(goalId)?.blockerCode).toBe("verification-budget-exhausted");
    expect(store.recordVerificationAndMaybeRemediate(goalId, token, runId, "verifier-10", [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }])).toMatchObject({ ok: true, outcome: "BLOCKED" });

    const resumed = store.resumeAndDispatch(goalId, token, runId, snapshot(), []);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
    const eleventh = store.proposeCompletion(goalId, token, runId, snapshot(), [], "completion-key-11");
    if (!eleventh.ok) throw new Error(eleventh.error);
    expect(eleventh.attempt).toBe(11);
    store.bindVerifierSession(goalId, token, eleventh.dispatchId, "verifier-11", "verifier-key-11");
    const eleventhReport = store.recordVerificationAndMaybeRemediate(goalId, token, runId, "verifier-11", [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }]);
    if (!eleventhReport.ok || eleventhReport.outcome !== "ACTIVE") throw new Error("attempt 11 did not start the second batch");
    for (let attempt = 12; attempt <= 19; attempt += 1) {
      expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
      const completion = store.proposeCompletion(goalId, token, runId, snapshot(), [], `completion-key-${attempt}`);
      if (!completion.ok) throw new Error(completion.error);
      store.bindVerifierSession(goalId, token, completion.dispatchId, `verifier-${attempt}`, `verifier-key-${attempt}`);
      const reported = store.recordVerificationAndMaybeRemediate(goalId, token, runId, `verifier-${attempt}`, [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }]);
      if (!reported.ok || reported.outcome !== "ACTIVE") throw new Error(`attempt ${attempt} did not remediate`);
    }
    expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
    const twentieth = store.proposeCompletion(goalId, token, runId, snapshot(), [], "completion-key-20");
    if (!twentieth.ok) throw new Error(twentieth.error);
    store.bindVerifierSession(goalId, token, twentieth.dispatchId, "verifier-20", "verifier-key-20");
    const twentiethReport = store.recordVerificationAndMaybeRemediate(goalId, token, runId, "verifier-20", [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }]);
    if (!twentiethReport.ok) throw new Error(twentiethReport.error);
    expect(twentiethReport.outcome).toBe("BLOCKED");
    expect(store.getRun(goalId)?.verificationBatch).toBe(2);
  } finally { db.close(); }
});

test("a mutation under a stale fencing token fails even for the same instance", () => {
  const { db, store, advance } = freshStore();
  try {
    const { goalId, token, runId } = createProposedApproved(store);
    advance(11 * 60 * 1000);
    expect(store.recordWorkspacePrepared(goalId, token, runId, projectDirectory).ok).toBe(false);
    const reacquired = store.acquireLease(goalId);
    if (!reacquired.ok) throw new Error(reacquired.error);
    expect(reacquired.fencingToken).toBeGreaterThan(token);
    expect(store.recordWorkspacePrepared(goalId, token, runId, projectDirectory).ok).toBe(false);
    expect(store.recordWorkspacePrepared(goalId, reacquired.fencingToken, runId, projectDirectory).ok).toBe(true);
  } finally { db.close(); }
});

test("approval rejection blocks the Goal and resume creates a new generation on the same revision", () => {
  const { db, store } = freshStore();
  try {
    const created = store.createGoal("reject test", "root-session", origin, model);
    if (!created.ok) throw new Error(created.error);
    const goalId = created.goalId;
    const token = store.getOwnedFencingToken(goalId)!;
    const proposal = store.proposeContract(goalId, token, { outcome: "works", scope: { included: ["x"], excluded: [] }, constraints: [], assumptions: [], workspace: "current" }, [{ id: "c", priority: "must", description: "works", verification: [{ kind: "inspection", description: "inspect" }] }], readyGateFacts, "proposal-key-1", { head: "a".repeat(40), clean: true });
    if (!proposal.ok || !proposal.ready) throw new Error("proposal failed");

    expect(store.markApprovalRejected(goalId, token, "event-1")).toMatchObject({ ok: true });
    expect(store.getGoal(goalId)?.state).toBe("BLOCKED");
    expect(store.getGoal(goalId)?.blockerCode).toBe("approval-not-approved");
    expect(store.getLiveApproval(goalId)).toBeUndefined();
    expect(store.getRun(goalId)).toBeUndefined();
    expect(store.markApprovalRejected(goalId, token, "event-1")).toMatchObject({ ok: true });

    const resumed = store.resumeBlockedApproval(goalId, token);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.revision).toBe(proposal.revision);
    expect(store.getGoal(goalId)?.state).toBe("AWAITING_APPROVAL");
    expect(store.getLiveApproval(goalId)?.generation).toBe(2);
    expect(store.getLiveApproval(goalId)?.predecessorAttemptId).toBe(proposal.attemptId);
    expect(store.listPendingDispatches(goalId)).toContainEqual(expect.objectContaining({ kind: "approval-reissue", status: "PENDING" }));
  } finally { db.close(); }
});

test("expired approvals immediately create a pending reissue generation", () => {
  const { db, store, advance } = freshStore();
  try {
    const created = store.createGoal("expire test", "root-session", origin, model);
    if (!created.ok) throw new Error(created.error);
    const goalId = created.goalId;
    const token = store.getOwnedFencingToken(goalId)!;
    const proposal = store.proposeContract(goalId, token, { outcome: "works", scope: { included: ["x"], excluded: [] }, constraints: [], assumptions: [], workspace: "current" }, [{ id: "c", priority: "must", description: "works", verification: [{ kind: "inspection", description: "inspect" }] }], readyGateFacts, "proposal-key-expire", { head: "a".repeat(40), clean: true });
    if (!proposal.ok || !proposal.ready) throw new Error("proposal failed");
    const live = store.getLiveApproval(goalId)!;
    advance(16 * 60 * 1000);
    const reacquired = store.acquireLease(goalId);
    if (!reacquired.ok) throw new Error(reacquired.error);
    const reissued = store.reissueApproval(goalId, reacquired.fencingToken, "expired-native-question");
    if (!reissued.ok) throw new Error(reissued.error);
    expect(reissued.attemptId).not.toBe(live.attemptId);
    expect(store.getLiveApproval(goalId)?.status).toBe("PENDING");
    expect(store.getApprovalAttempt(live.attemptId)?.status).toBe("EXPIRED");
    expect(store.getApprovalAttempt(live.attemptId)?.resolvedAt).not.toBeNull();
    expect(store.getLiveApproval(goalId)?.generation).toBe(2);
  } finally { db.close(); }
});

test("completion blocks on unexplained workspace changes", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = createProposedApproved(store);
    store.recordWorkspacePrepared(goalId, token, runId, projectDirectory);
    store.activateRun(goalId, token, runId, snapshot());
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model);
    const evidence = store.recordEvidence(goalId, token, runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: "executor-session" }, "evidence-key-1");
    if (!evidence.ok) throw new Error(evidence.error);
    const finalState = buildSnapshot({
      head: "a".repeat(40),
      status: [{ path: "src/other.ts", status: "modified", additions: 1, deletions: 1 }],
      diff: [{ path: "src/other.ts", status: "modified", additions: 1, deletions: 1, patch: "user-change" }],
      untracked: [],
      rawDiff: "",
      platform,
    });
    expect(store.beginFinalization(goalId, token, runId).ok).toBe(true);
    const completion = store.proposeCompletion(goalId, token, runId, finalState, [], "completion-key-1");
    expect(completion.ok).toBe(false);
    expect(completion.ok || completion.error).toBe("workspace-concurrent-changes");
    expect(store.getGoal(goalId)?.state).toBe("BLOCKED");
    expect(store.getGoal(goalId)?.blockerCode).toBe("workspace-concurrent-changes");
  } finally { db.close(); }
});

test("pause supersedes dispatches, resume requires an attributable workspace", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId, dispatchId } = createProposedApproved(store);
    store.recordWorkspacePrepared(goalId, token, runId, projectDirectory);
    store.activateRun(goalId, token, runId, snapshot());
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model);
    const checkpoint = snapshot();
    expect(store.pauseGoal(goalId, token, checkpoint).ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("PAUSED");
    expect(store.getRun(goalId)?.status).toBe("PAUSED");
    expect(store.getDispatch(dispatchId)?.status).toBe("SUPERSEDED");

    const resumed = store.resumeAndDispatch(goalId, token, runId, checkpoint, []);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(store.getGoal(goalId)?.state).toBe("ACTIVE");
    expect(store.getDispatch(resumed.dispatchId)?.kind).toBe("executor-resume");
    expect(store.getDispatch(resumed.dispatchId)?.targetSessionId).toBe("executor-session");

    store.pauseGoal(goalId, token, checkpoint);
    const foreign = buildSnapshot({
      head: "a".repeat(40),
      status: [{ path: "x.ts", status: "added", additions: 1, deletions: 0 }],
      diff: [{ path: "x.ts", status: "added", additions: 1, deletions: 0, patch: "foreign" }],
      untracked: [],
      rawDiff: "",
      platform,
    });
    expect(store.resumeAndDispatch(goalId, token, runId, foreign, []).ok).toBe(false);
    expect(store.getGoal(goalId)?.state).toBe("BLOCKED");
  } finally { db.close(); }
});

test("revision invalidates live approvals, supersedes dispatches, and cancels runs", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token } = createProposedApproved(store);
    expect(store.reviseGoal(goalId, token, "change the outcome").ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("FORMING");
    expect(store.getGoal(goalId)?.formationRequest).toBe("change the outcome");
    expect(store.getRun(goalId)?.status).toBe("CANCELLED");
    expect(store.getLiveApproval(goalId)).toBeUndefined();
    expect(store.ownsLease(goalId)).toBe(true);
  } finally { db.close(); }
});

test("cancel releases the lease with an exact compare-and-set", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token } = createProposedApproved(store);
    expect(store.cancelGoal(goalId, token).ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("CANCELLED");
    expect(store.ownsLease(goalId)).toBe(false);
  } finally { db.close(); }
});

test("session bindings are strict and historical executor sessions are rejected", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = createProposedApproved(store);
    expect(store.getSessionBinding("root-session")).toMatchObject({ role: "root", goal: { goalId } });
    expect(store.getSessionBinding("unrelated-session")).toBeUndefined();
    store.recordWorkspacePrepared(goalId, token, runId, projectDirectory);
    store.activateRun(goalId, token, runId, snapshot());
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model);
    expect(store.getSessionBinding("executor-session")).toMatchObject({ role: "executor", goal: { goalId }, run: { runId } });
    store.reviseGoal(goalId, token, "revise");
    const goal2 = store.getGoal(goalId)!;
    expect(goal2.state).toBe("FORMING");
    expect(store.getSessionBinding("executor-session")).toMatchObject({ role: "revoked", revokedRole: "executor" });
  } finally { db.close(); }
});

test("dispatch payload tampering is rejected during delivery validation", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = createProposedApproved(store);
    store.recordWorkspacePrepared(goalId, token, runId, projectDirectory);
    store.activateRun(goalId, token, runId, snapshot());
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null }, model);
    const dispatch = store.getDispatch(store.getRun(goalId)!.runId === runId ? store.listPendingDispatches(goalId)[0]!.dispatchId : "");
    expect(dispatch).toBeDefined();
    const delivery = store.validateDispatchForDelivery(dispatch!.dispatchId, token);
    expect(delivery.ok).toBe(true);
  } finally { db.close(); }
});

test("schema version 3 and foreign schema objects are rejected without modification", () => {
  const db = openDatabase(":memory:");
  try {
    db.run("PRAGMA user_version = 3;");
    db.run("CREATE TABLE goals (goal_id TEXT PRIMARY KEY);");
    expect(() => initializeSchema(db)).toThrow(/incompatible/);
  } finally { db.close(); }
  const unversioned = openDatabase(":memory:");
  try {
    unversioned.run("CREATE TABLE unrelated (id TEXT PRIMARY KEY);");
    expect(() => initializeSchema(unversioned)).toThrow(/no recognized schema version/);
  } finally { unversioned.close(); }
});

test("schema signature is pinned by the golden constant", () => {
  expect(EXPECTED_SCHEMA_SIGNATURE.length).toBe(64);
    expect(SCHEMA_VERSION).toBe(8);
});
