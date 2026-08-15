import { expect, test } from "bun:test";
import { openDatabase } from "../src/store/database.js";
import { EXPECTED_SCHEMA_SIGNATURE, initializeSchema, SCHEMA_VERSION } from "../src/store/schema.js";
import { Store } from "../src/store/store.js";
import { buildSnapshot, type WorkspaceSnapshot } from "../src/core/workspace.js";

const readyGateFacts = { outcomeObservable: true, constraintsReviewed: true, assumptionsReviewed: true, outcomeChangingQuestionsResolved: true, infeasibleCriterionIds: [] } as const;
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
  return buildSnapshot({ head: commit, status: [], diff: [], untracked: [], platform });
}

function approvedGoal(store: Store): { goalId: string; token: number; runId: string; initialDispatchId: string } {
  const created = store.createGoal("store test", "root-session", origin, model);
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  const token = store.getOwnedFencingToken(goalId)!;
  const proposal = store.proposeContract(goalId, token, { outcome: "works", scope: { included: ["x"], excluded: [] }, constraints: [], assumptions: [] }, [{ id: "c", priority: "must", description: "works", verification: [{ kind: "inspection", description: "inspect" }] }], readyGateFacts, "proposal-key-1", { head: "a".repeat(40), clean: true });
  if (!proposal.ok || !proposal.ready) throw new Error("proposal failed");
  const bound = store.bindApprovalQuestion(goalId, token, "call-1", proposal.nativeQuestion);
  if (!bound.ok) throw new Error(bound.error);
  const approved = store.resolveApproval(goalId, token, "call-1", [["Approve and start"]]);
  if (!approved.ok || approved.action !== "approved") throw new Error("approval failed");
  return { goalId, token, runId: approved.runId, initialDispatchId: approved.dispatchId };
}

function activate(store: Store, goalId: string, token: number, runId: string): void {
  expect(store.recordWorkspacePrepared(goalId, token, runId, projectDirectory).ok).toBe(true);
  expect(store.activateRun(goalId, token, runId, snapshot()).ok).toBe(true);
}

function addEvidence(store: Store, goalId: string, token: number, runId: string, operationKey = "evidence-1") {
  const evidence = store.recordEvidence(goalId, token, runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: "executor-session" }, operationKey);
  if (!evidence.ok) throw new Error(evidence.error);
  return evidence;
}

function startVerification(store: Store, goalId: string, token: number, runId: string, operationKey: string, verifierSessionId: string) {
  const started = store.beginFinalization(goalId, token, runId, operationKey);
  if (!started.ok) throw new Error(started.error);
  const handoff = store.completeExecutorHandoff(goalId, token, runId, snapshot());
  if (!handoff.ok) throw new Error(handoff.error);
  expect(store.bindVerifierSession(goalId, token, handoff.dispatchId, verifierSessionId, `${verifierSessionId}-key`).ok).toBe(true);
  return handoff;
}

test("schema initializes with the reviewed signature", () => {
  const db = openDatabase(":memory:");
  try {
    initializeSchema(db);
    expect(SCHEMA_VERSION).toBe(9);
    expect(EXPECTED_SCHEMA_SIGNATURE).toHaveLength(64);
    expect(db.query<{ name: string }>("PRAGMA table_info(runs)").map((column) => column.name)).not.toContain("state");
  } finally { db.close(); }
});

test("approval and activation use the unified workflow state", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId, initialDispatchId } = approvedGoal(store);
    expect(store.getGoal(goalId)?.state).toBe("PREPARING");
    activate(store, goalId, token, runId);
    expect(store.getGoal(goalId)?.state).toBe("EXECUTING");
    expect(store.getCurrentRun(goalId)?.endedAt).toBeNull();
    expect(store.getDispatch(initialDispatchId)?.status).toBe("PENDING");
  } finally { db.close(); }
});

test("executor and verifier handoff completes atomically", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null });
    const evidence = addEvidence(store, goalId, token, runId);
    const handoff = startVerification(store, goalId, token, runId, "finalization-1", "verifier-session");
    expect(store.completeExecutorHandoff(goalId, token, runId, snapshot())).toEqual(handoff);
    expect(store.getGoal(goalId)?.state).toBe("VERIFYING");
    const report = store.recordVerificationReport(goalId, token, runId, "verifier-session", [{ criterionId: "c", result: "pass", evidenceIds: [evidence.evidenceId] }], "report-pass");
    expect(report).toMatchObject({ ok: true, outcome: "PASS" });
    expect(store.recordVerificationReport(goalId, token, runId, "verifier-session", [], "report-pass")).toEqual(report);
    const completed = store.completeVerifierHandoff(goalId, token, runId, snapshot());
    expect(completed).toMatchObject({ ok: true, outcome: "COMPLETED" });
    expect(store.completeVerifierHandoff(goalId, token, runId, snapshot())).toEqual(completed);
    expect(store.getGoal(goalId)?.state).toBe("COMPLETED");
    expect(store.getLatestRun(goalId)).toMatchObject({ endReason: "COMPLETED" });
    expect(store.ownsLease(goalId)).toBe(false);
    expect(store.getSessionBinding("executor-session")).toMatchObject({ role: "revoked", revokedRole: "executor" });
    expect(store.getSessionBinding("verifier-session")).toMatchObject({ role: "revoked", revokedRole: "verifier" });
    expect(store.getDispatch(handoff.dispatchId)?.status).toBe("COMPLETED");
  } finally { db.close(); }
});

test("missing MUST evidence leaves the Executor in the write phase", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    expect(store.beginFinalization(goalId, token, runId, "missing-evidence")).toMatchObject({ ok: false, error: "must-evidence-incomplete", gaps: ["c"] });
    expect(store.getGoal(goalId)?.state).toBe("EXECUTING");
  } finally { db.close(); }
});

test("verification failure returns to Executor with a remediation dispatch", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null });
    const evidence = addEvidence(store, goalId, token, runId);
    startVerification(store, goalId, token, runId, "failure-1", "verifier-session");
    expect(store.recordVerificationReport(goalId, token, runId, "verifier-session", [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }], "report-fail")).toMatchObject({ ok: true, outcome: "FAIL" });
    const remediation = store.completeVerifierHandoff(goalId, token, runId, snapshot());
    expect(remediation).toMatchObject({ ok: true, outcome: "EXECUTING" });
    expect(store.getGoal(goalId)?.state).toBe("EXECUTING");
    if (remediation.ok && remediation.dispatchId) expect(store.getDispatch(remediation.dispatchId)?.kind).toBe("executor-remediation");
  } finally { db.close(); }
});

test("ten corrections are allowed before the next failed verification blocks", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null });
    const evidence = addEvidence(store, goalId, token, runId);
    for (let attempt = 1; attempt <= 11; attempt += 1) {
      startVerification(store, goalId, token, runId, `failure-${attempt}`, `verifier-${attempt}`);
      const report = store.recordVerificationReport(goalId, token, runId, `verifier-${attempt}`, [{ criterionId: "c", result: "fail", evidenceIds: [evidence.evidenceId] }], `report-${attempt}`);
      expect(report).toMatchObject({ ok: true, outcome: "FAIL" });
      const result = store.completeVerifierHandoff(goalId, token, runId, snapshot());
      if (attempt <= 10) expect(result).toMatchObject({ ok: true, outcome: "EXECUTING" });
      else expect(result).toMatchObject({ ok: true, outcome: "BLOCKED" });
    }
    expect(store.getGoal(goalId)).toMatchObject({ state: "BLOCKED", blockerCode: "verification-budget-exhausted" });
  } finally { db.close(); }
});

test("a changed Git HEAD blocks the executor handoff", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    addEvidence(store, goalId, token, runId, "head-change-evidence");
    expect(store.beginFinalization(goalId, token, runId, "head-change").ok).toBe(true);
    expect(store.completeExecutorHandoff(goalId, token, runId, snapshot("b".repeat(40)))).toMatchObject({ ok: false, error: "workspace-head-changed" });
    expect(store.getGoal(goalId)).toMatchObject({ state: "BLOCKED", blockerCode: "workspace-head-changed" });
    expect(store.getGoal(goalId)?.resumeState).toBe("FINALIZING_EXECUTION");
    expect(store.resumeFinalization(goalId, token, runId, "FINALIZING_EXECUTION")).toEqual({ ok: true });
    expect(store.completeExecutorHandoff(goalId, token, runId, snapshot())).toMatchObject({ ok: true, attempt: 1 });
  } finally { db.close(); }
});

test("preparation blockers resume through the persisted origin state", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    expect(store.failRunPreparation(goalId, token, runId, "workspace-preparation-failed", "failed")).toEqual({ ok: true });
    expect(store.getGoal(goalId)).toMatchObject({ state: "BLOCKED", resumeState: "PREPARING" });
    expect(store.resumePreparation(goalId, token, runId)).toEqual({ ok: true });
    expect(store.getGoal(goalId)?.state).toBe("PREPARING");
  } finally { db.close(); }
});

test("pause and resume preserve the checkpoint boundary", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    expect(store.pauseGoal(goalId, token).ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("PAUSED");
    expect(store.resumeAndDispatch(goalId, token, runId, snapshot())).toMatchObject({ ok: false, error: "pause-not-finalized" });
    expect(store.completePause(goalId, token, runId, snapshot()).ok).toBe(true);
    const resumed = store.resumeAndDispatch(goalId, token, runId, snapshot());
    expect(resumed.ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("EXECUTING");
  } finally { db.close(); }
});

test("a failed pause checkpoint preserves the underlying execution resume target", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    expect(store.pauseGoal(goalId, token)).toEqual({ ok: true });
    expect(store.blockGoal(goalId, token, "workspace-comparison-invalid", "capture failed", { state: "PAUSED", runId })).toEqual({ ok: true });
    expect(store.getGoal(goalId)).toMatchObject({ state: "BLOCKED", resumeState: "EXECUTING" });
    expect(store.resumeAndDispatch(goalId, token, runId, snapshot())).toMatchObject({ ok: true });
    expect(store.getGoal(goalId)?.state).toBe("EXECUTING");
  } finally { db.close(); }
});

test("leases fence mutations and revision invalidates sessions", () => {
  const { db, store, advance } = freshStore();
  try {
    const { goalId, token, runId } = approvedGoal(store);
    advance(11 * 60 * 1000);
    expect(store.recordWorkspacePrepared(goalId, token, runId, projectDirectory).ok).toBe(false);
    const reacquired = store.acquireLease(goalId);
    if (!reacquired.ok) throw new Error(reacquired.error);
    expect(store.recordWorkspacePrepared(goalId, token, runId, projectDirectory).ok).toBe(false);
    expect(store.reviseGoal(goalId, reacquired.fencingToken, "change outcome").ok).toBe(true);
    expect(store.getGoal(goalId)?.state).toBe("PLANNING");
    expect(store.getLatestRun(goalId)?.endReason).toBe("REVISED");
  } finally { db.close(); }
});

test("dispatch payload integrity is checked before delivery", () => {
  const { db, store } = freshStore();
  try {
    const { goalId, token, runId, initialDispatchId } = approvedGoal(store);
    activate(store, goalId, token, runId);
    store.bindExecutorSession(goalId, token, runId, "executor-session", { projectId: "project-1", workspaceId: null });
    expect(store.validateDispatchForDelivery(initialDispatchId, token)).toMatchObject({ ok: true });
  } finally { db.close(); }
});

test("foreign and unversioned schemas are rejected", () => {
  const versioned = openDatabase(":memory:");
  try {
    versioned.run("PRAGMA user_version = 3;");
    versioned.run("CREATE TABLE goals (goal_id TEXT PRIMARY KEY);");
    expect(() => initializeSchema(versioned)).toThrow(/incompatible/);
  } finally { versioned.close(); }
  const unversioned = openDatabase(":memory:");
  try {
    unversioned.run("CREATE TABLE unrelated (id TEXT PRIMARY KEY);");
    expect(() => initializeSchema(unversioned)).toThrow(/no recognized schema version/);
  } finally { unversioned.close(); }
});
