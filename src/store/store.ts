import { z } from "zod";
import { normalize, parse, resolve } from "node:path";
import { openCodeMessageId, type Clock, type IDGenerator, type SessionModel } from "../core/ports.js";
import { assertTransition, DEFAULT_MAX_VERIFICATION_ATTEMPTS, type GoalState, type RunStatus, isTerminal } from "../core/state.js";
import { AcceptanceCriterionSchema, ContractBodySchema, VerificationStepSchema, computeRevisionHash, evaluateReadiness, formatContractApprovalSummary, type AcceptanceCriterion, type ContractBody, type GoalRevision, type ReadyGateFacts } from "../core/contract.js";
import { EvidenceSchema, VerificationFindingSchema, checkCompletionCoverage, deriveVerificationOutcome, type Evidence, type VerificationFinding } from "../core/evidence.js";
import { canonicalHash, canonicalJson } from "../core/canonical.js";
import { redact } from "../core/redaction.js";
import { createApprovalQuestion, mapApprovalAnswers, NativeApprovalQuestionSchema, type ApprovalResponseMap, type NativeApprovalQuestion } from "../core/question.js";
import { CanonicalDiffEntrySchema, WorkspaceSnapshotSchema, assertExecutorOwnsSnapshot, assertSnapshotUnchanged, isWorkspaceClean, type CanonicalDiffEntry, type WorkspaceSnapshot } from "../core/workspace.js";
import type { BlockerCode } from "../core/errors.js";
import type { DatabaseConnection } from "./database.js";

export type GoalView = {
  goalId: string;
  projectId: string;
  rootSessionId: string;
  rootWorkspaceId: string | null;
  projectDirectory: string;
  worktreeOrigin: string;
  sourceRequest: string;
  formationRequest: string | null;
  model: SessionModel | null;
  state: GoalState;
  currentRevision: number | null;
  approvedRevisionHash: string | null;
  currentRunId: string | null;
  blockerCode: BlockerCode | null;
  blocker: string | null;
  stateVersion: number;
  createdAt: string;
  updatedAt: string;
};
export type RevisionView = GoalRevision;
export type CriterionView = AcceptanceCriterion & { readonly goalId: string; readonly revision: number };
export type EvidenceView = Evidence & { readonly evidenceId: string; readonly goalId: string; readonly runId: string; readonly revision: number };
export type ApprovalAttemptView = {
  attemptId: string;
  goalId: string;
  generation: number;
  predecessorAttemptId: string | null;
  revision: number;
  contractHash: string;
  rootSessionId: string;
  nativeRequestId: string | null;
  callId: string | null;
  nativeQuestionJson: string;
  status: "PENDING" | "APPROVED" | "REVISED" | "CANCELLED" | "REJECTED" | "EXPIRED" | "INVALIDATED";
  expiresAt: string;
  expired: boolean;
  createdAt: string;
  resolvedAt: string | null;
  preflight: { head: string; clean: boolean } | null;
};
export type RunView = {
  runId: string;
  goalId: string;
  approvalAttemptId: string;
  revision: number;
  approvedRevisionHash: string;
  workspaceStrategy: "current" | "worktree";
  worktreeName: string | null;
  workspacePath: string | null;
  baseline: WorkspaceSnapshot | null;
  checkpoint: WorkspaceSnapshot | null;
  finalSnapshot: WorkspaceSnapshot | null;
  executorDiff: readonly CanonicalDiffEntry[] | null;
  executorSessionId: string | null;
  executorSessionKey: string;
  executorProjectId: string | null;
  executorWorkspaceId: string | null;
  model: SessionModel | null;
  status: RunStatus;
  verificationAttempts: number;
  verificationBatch: number;
  preparationRetryRequested: boolean;
  rowVersion: number;
};
export type DispatchView = {
  dispatchId: string;
  goalId: string;
  runId: string | null;
  approvalAttemptId: string;
  revision: number;
  contractHash: string;
  kind: "approval-reissue" | "executor-initial" | "executor-remediation" | "executor-resume" | "verifier";
  role: "formulator" | "executor" | "verifier";
  verificationAttempt: number | null;
  targetSessionId: string | null;
  directory: string | null;
  messageId: string;
  payload: unknown;
  promptHash: string;
  status: "PENDING" | "SENT" | "STARTED" | "COMPLETED" | "FAILED" | "SUPERSEDED";
  rowVersion: number;
};
export type VerificationResultView = {
  attempt: number;
  verifierSessionId: string | null;
  verifierSessionKey: string | null;
  findings: readonly VerificationFinding[];
  outcome: "PENDING" | "PASS" | "FAIL" | "ERROR" | "BLOCKED";
  createdAt: string;
  finalizedAt: string | null;
};
export type AuditView = { kind: string; actor: string; previousState: string | null; nextState: string | null; goalSequence: number; sourceEventId: string | null; createdAt: string };
export type SessionBinding =
  | { readonly role: "root"; readonly goal: GoalView }
  | { readonly role: "executor"; readonly goal: GoalView; readonly run: RunView }
  | { readonly role: "verifier"; readonly goal: GoalView; readonly run: RunView; readonly result: VerificationResultView }
  | { readonly role: "revoked"; readonly revokedRole: "executor" | "verifier"; readonly goal: GoalView; readonly run: RunView };
export type { VerificationFinding } from "../core/evidence.js";

type Lease = { fencing_token: number; holder_instance_id: string | null; expires_at: string | null };
type Result = { ok: true } | { ok: false; error: string };

const RUN_SQL = "SELECT * FROM runs WHERE goal_id = ? ORDER BY revision DESC, created_at DESC, rowid DESC LIMIT 1";

export class Store {
  constructor(
    private readonly db: DatabaseConnection,
    private readonly clock: Clock,
    private readonly ids: IDGenerator,
    private readonly instanceId: string,
    private readonly leaseTtlMs = 10 * 60 * 1000,
  ) {}

  getGoal(goalId: string): GoalView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM goals WHERE goal_id = ?", goalId);
    return row ? toGoal(row) : undefined;
  }

  getLatestGoalForRootSession(sessionId: string, projectId: string): GoalView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM goals WHERE root_session_id=? AND project_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      sessionId, projectId,
    );
    return row ? toGoal(row) : undefined;
  }

  getSessionBinding(sessionId: string): SessionBinding | undefined {
    const root = this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM goals WHERE root_session_id = ? AND state IN ('FORMING','AWAITING_APPROVAL','ACTIVE','VERIFYING','PAUSED','BLOCKED') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      sessionId,
    );
    if (root) return { role: "root", goal: toGoal(root) };
    const binding = this.db.queryOne<{ role: "executor" | "verifier"; status: "ACTIVE" | "REVOKED"; goal_id: string; run_id: string }>(
      "SELECT role,status,goal_id,run_id FROM session_bindings WHERE session_id = ?",
      sessionId,
    );
    if (!binding) return undefined;
    const goal = this.getGoal(binding.goal_id);
    const run = this.getRunById(binding.run_id);
    if (!goal || !run) return undefined;
    if (binding.status === "REVOKED") return { role: "revoked", revokedRole: binding.role, goal, run };
    if (binding.role === "executor" && goal.currentRunId === run.runId && ["ACTIVE", "VERIFYING", "PAUSED", "BLOCKED"].includes(run.status) && run.executorSessionId === sessionId) {
      return { role: "executor", goal, run };
    }
    if (binding.role === "verifier" && goal.state === "VERIFYING" && run.status === "VERIFYING") {
      const verifier = this.db.queryOne<Record<string, unknown>>(
        "SELECT * FROM verification_results WHERE run_id = ? AND verifier_session_id = ? AND attempt = ? AND outcome = 'PENDING' LIMIT 1",
        run.runId,
        sessionId,
        run.verificationAttempts,
      );
      if (verifier) return { role: "verifier", goal, run, result: toVerificationResult(verifier) };
    }
    return { role: "revoked", revokedRole: binding.role, goal, run };
  }

  getSessionBindingForProject(sessionId: string, projectId: string): SessionBinding | undefined {
    const root = this.db.queryOne<Record<string, unknown>>(
      "SELECT * FROM goals WHERE root_session_id = ? AND project_id = ? AND state IN ('FORMING','AWAITING_APPROVAL','ACTIVE','VERIFYING','PAUSED','BLOCKED') ORDER BY created_at DESC, rowid DESC LIMIT 1",
      sessionId, projectId,
    );
    if (root) return { role: "root", goal: toGoal(root) };
    const binding = this.db.queryOne<{ role: "executor" | "verifier"; status: "ACTIVE" | "REVOKED"; goal_id: string; run_id: string }>(
      "SELECT b.role,b.status,b.goal_id,b.run_id FROM session_bindings b JOIN goals g ON g.goal_id=b.goal_id WHERE b.session_id = ? AND g.project_id = ?",
      sessionId, projectId,
    );
    if (!binding) return undefined;
    const goal = this.getGoal(binding.goal_id);
    const run = this.getRunById(binding.run_id);
    if (!goal || !run) return undefined;
    if (binding.status === "REVOKED") return { role: "revoked", revokedRole: binding.role, goal, run };
    if (binding.role === "executor" && goal.currentRunId === run.runId && ["ACTIVE", "VERIFYING", "PAUSED", "BLOCKED"].includes(run.status) && run.executorSessionId === sessionId) {
      return { role: "executor", goal, run };
    }
    if (binding.role === "verifier" && goal.state === "VERIFYING" && run.status === "VERIFYING") {
      const verifier = this.db.queryOne<Record<string, unknown>>(
        "SELECT * FROM verification_results WHERE run_id = ? AND verifier_session_id = ? AND attempt = ? AND outcome = 'PENDING' LIMIT 1",
        run.runId, sessionId, run.verificationAttempts,
      );
      if (verifier) return { role: "verifier", goal, run, result: toVerificationResult(verifier) };
    }
    return { role: "revoked", revokedRole: binding.role, goal, run };
  }

  getRevision(goalId: string, revision: number): RevisionView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM contract_revisions WHERE goal_id = ? AND revision = ?", goalId, revision);
    return row ? this.readRevision(row) : undefined;
  }

  getLatestRevision(goalId: string): RevisionView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM contract_revisions WHERE goal_id = ? ORDER BY revision DESC LIMIT 1", goalId);
    return row ? this.readRevision(row) : undefined;
  }

  getCriteria(goalId: string, revision?: number): CriterionView[] {
    const rows = revision === undefined
      ? this.db.query<Record<string, unknown>>("SELECT * FROM acceptance_criteria WHERE goal_id = ? ORDER BY revision, criterion_id", goalId)
      : this.db.query<Record<string, unknown>>("SELECT * FROM acceptance_criteria WHERE goal_id = ? AND revision = ? ORDER BY criterion_id", goalId, revision);
    return rows.map((row) => {
      const verification = z.array(VerificationStepSchema).parse(JSON.parse(String(row.verification_json)));
      return { id: String(row.criterion_id), criterionId: String(row.criterion_id), priority: row.priority as "must" | "should", description: String(row.description), verification, goalId: String(row.goal_id), revision: Number(row.revision) };
    });
  }

  getEvidence(goalId: string, runId?: string): EvidenceView[] {
    const rows = runId === undefined
      ? this.db.query<Record<string, unknown>>("SELECT * FROM evidence WHERE goal_id = ? ORDER BY created_at, rowid", goalId)
      : this.db.query<Record<string, unknown>>("SELECT * FROM evidence WHERE goal_id = ? AND run_id = ? ORDER BY created_at, rowid", goalId, runId);
    return rows.map((row) => ({ evidenceId: String(row.evidence_id), goalId: String(row.goal_id), runId: String(row.run_id), revision: Number(row.revision), criterionId: String(row.criterion_id), source: row.source as Evidence["source"], method: String(row.method), expectedResult: String(row.expected_result), actualReference: String(row.actual_reference), producer: String(row.producer), recordedAt: String(row.created_at) }));
  }

  getRun(goalId: string): RunView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>(RUN_SQL, goalId);
    return row ? toRun(row) : undefined;
  }

  getCurrentRun(goalId: string): RunView | undefined {
    const goal = this.getGoal(goalId);
    return goal?.currentRunId ? this.getRunById(goal.currentRunId) : undefined;
  }

  getRunById(runId: string): RunView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM runs WHERE run_id = ?", runId);
    return row ? toRun(row) : undefined;
  }

  getLiveApproval(goalId: string): ApprovalAttemptView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM approval_attempts WHERE goal_id = ? AND status = 'PENDING' ORDER BY generation DESC LIMIT 1", goalId);
    return row ? toApprovalAttempt(row, this.clock.now()) : undefined;
  }

  getApprovalAttempt(attemptId: string): ApprovalAttemptView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM approval_attempts WHERE attempt_id = ?", attemptId);
    return row ? toApprovalAttempt(row, this.clock.now()) : undefined;
  }

  getVerificationResults(runId: string): VerificationResultView[] {
    return this.db.query<Record<string, unknown>>("SELECT * FROM verification_results WHERE run_id=? ORDER BY attempt", runId).map(toVerificationResult);
  }

  getRecentAudit(goalId: string, limit = 12): AuditView[] {
    const bounded = Math.max(1, Math.min(50, Math.floor(limit)));
    return this.db.query<Record<string, unknown>>("SELECT kind,actor,previous_state,next_state,goal_sequence,source_event_id,created_at FROM audit_events WHERE goal_id=? ORDER BY goal_sequence DESC LIMIT ?", goalId, bounded).reverse().map((row) => ({ kind: String(row.kind), actor: String(row.actor), previousState: row.previous_state === null ? null : String(row.previous_state), nextState: row.next_state === null ? null : String(row.next_state), goalSequence: Number(row.goal_sequence), sourceEventId: row.source_event_id === null ? null : String(row.source_event_id), createdAt: String(row.created_at) }));
  }

  getDispatch(dispatchId: string): DispatchView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM dispatches WHERE dispatch_id = ?", dispatchId);
    return row ? toDispatch(row) : undefined;
  }

  getDispatchByMessageId(messageId: string): DispatchView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM dispatches WHERE message_id=?", messageId);
    return row ? toDispatch(row) : undefined;
  }

  getDispatchForSession(sessionId: string): DispatchView | undefined {
    const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM dispatches WHERE target_session_id=? AND status IN ('PENDING','SENT','STARTED') ORDER BY created_at DESC, rowid DESC LIMIT 1", sessionId);
    return row ? toDispatch(row) : undefined;
  }

  listPendingDispatches(goalId?: string): DispatchView[] {
    const rows = goalId === undefined
      ? this.db.query<Record<string, unknown>>("SELECT * FROM dispatches WHERE status IN ('PENDING','SENT','STARTED') ORDER BY created_at, rowid")
      : this.db.query<Record<string, unknown>>("SELECT * FROM dispatches WHERE goal_id=? AND status IN ('PENDING','SENT','STARTED') ORDER BY created_at, rowid", goalId);
    return rows.map(toDispatch);
  }

  listRecoverableGoalsForProject(projectId: string): GoalView[] {
    return this.db.query<Record<string, unknown>>("SELECT * FROM goals WHERE project_id=? AND state IN ('FORMING','AWAITING_APPROVAL','ACTIVE','VERIFYING','PAUSED','BLOCKED') ORDER BY created_at", projectId).map(toGoal);
  }

  getFormulatorState(goalId: string): unknown {
    const goal = this.getGoal(goalId);
    const revision = goal?.currentRevision === null || goal?.currentRevision === undefined ? undefined : this.getRevision(goalId, goal.currentRevision);
    const live = goal ? this.getLiveApproval(goalId) : undefined;
    return {
      state: goal?.state ?? "missing",
      sourceRequest: goal?.sourceRequest ?? null,
      formationRequest: goal?.formationRequest ?? null,
      latestContract: revision ? { body: revision.body, criteria: revision.criteria, hash: revision.hash } : null,
      approvalPending: !!live,
      approvalGeneration: live?.generation ?? null,
      blockerCode: goal?.blockerCode ?? null,
      blocker: goal?.blocker ?? null,
    };
  }

  getExecutorState(goalId: string): unknown {
    const goal = this.getGoal(goalId);
    const run = this.getCurrentRun(goalId);
    const revision = goal?.currentRevision === null || goal?.currentRevision === undefined ? undefined : this.getRevision(goalId, goal.currentRevision);
    const evidence = run ? this.getEvidence(goalId, run.runId) : [];
    const results = run ? this.getVerificationResults(run.runId) : [];
    return {
      state: goal?.state ?? "missing",
      contract: revision ? { body: revision.body, criteria: revision.criteria, hash: revision.hash } : null,
      workspace: run ? { strategy: run.workspaceStrategy, path: run.workspacePath, baseline: run.baseline } : null,
      evidence,
      evidenceCoverage: revision ? revision.criteria.map((criterion) => ({ criterionId: criterion.id, count: evidence.filter((item) => item.criterionId === criterion.id).length })) : [],
      latestFindings: results.at(-1)?.findings ?? [],
      verificationAttempt: run?.verificationAttempts ?? 0,
       maxVerificationAttempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
       verificationBatch: run?.verificationBatch ?? 1,
      blockerCode: goal?.blockerCode ?? null,
      blocker: goal?.blocker ?? null,
    };
  }

  getVerifierState(goalId: string): unknown {
    const goal = this.getGoal(goalId);
    const run = this.getCurrentRun(goalId);
    const revision = goal?.currentRevision === null || goal?.currentRevision === undefined ? undefined : this.getRevision(goalId, goal.currentRevision);
    const results = run ? this.getVerificationResults(run.runId) : [];
    return {
      state: goal?.state ?? "missing",
      contract: revision ? { body: revision.body, criteria: revision.criteria } : null,
      evidence: run ? this.getEvidence(goalId, run.runId) : [],
      workspace: run ? { strategy: run.workspaceStrategy, path: run.workspacePath, baseline: run.baseline, finalSnapshot: run.finalSnapshot, executorSessionDiff: run.executorDiff } : null,
      activeAttempt: run?.verificationAttempts ?? 0,
       maxVerificationAttempts: DEFAULT_MAX_VERIFICATION_ATTEMPTS,
       verificationBatch: run?.verificationBatch ?? 1,
      priorResults: results,
      blockerCode: goal?.blockerCode ?? null,
      blocker: goal?.blocker ?? null,
    };
  }

  createGoal(sourceRequest: string, rootSessionId: string, origin: { projectId: string; rootWorkspaceId: string | null; projectDirectory: string; worktreeOrigin: string }, model: SessionModel): { ok: true; goalId: string } | { ok: false; error: string } {
    if (!sourceRequest.trim() || sourceRequest.length > 50_000 || !rootSessionId || !origin.projectId || !origin.projectDirectory || !origin.worktreeOrigin || !model?.providerID || !model.id) return { ok: false, error: "invalid-goal-origin" };
    const goalId = this.ids.next();
    const projectDirectory = persistedPath(origin.projectDirectory); const worktreeOrigin = persistedPath(origin.worktreeOrigin);
    const now = this.clock.now().toISOString();
    const txn = this.db.transaction(() => {
      try {
        this.db.run("INSERT INTO goals(goal_id,project_id,root_session_id,root_workspace_id,project_directory,worktree_origin,source_request,formation_request,model_provider_id,model_id,model_variant,state,current_revision,approved_revision_hash,current_run_id,blocker_code,blocker,state_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", goalId, origin.projectId, rootSessionId, origin.rootWorkspaceId, projectDirectory, worktreeOrigin, sourceRequest, null, model.providerID, model.id, model.variant ?? null, "FORMING", null, null, null, null, null, 0, now, now);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE|goals_one_non_terminal_root|root_session_id/i.test(message)) return { ok: false as const, error: "active-goal-exists" };
        throw error;
      }
      this.db.run("INSERT INTO leases(goal_id,fencing_token,holder_instance_id,expires_at) VALUES(?,?,?,?)", goalId, 1, this.instanceId, new Date(this.clock.now().getTime() + this.leaseTtlMs).toISOString());
      this.audit(goalId, "goal_created", rootSessionId, { sourceRequest, origin: { projectId: origin.projectId, projectDirectory, worktreeOrigin } }, undefined, "FORMING", now);
      return { ok: true as const, goalId };
    });
    return txn.immediate();
  }

  acquireLease(goalId: string, allowTerminal = false): { ok: true; fencingToken: number } | { ok: false; error: "lease-held" | "goal-not-found" | "goal-terminal" } {
    const result = this.db.transaction(() => {
      const now = this.clock.now();
       const goal = this.getGoal(goalId);
       if (!goal) return { ok: false as const, error: "goal-not-found" as const };
        if (isTerminal(goal.state) && !allowTerminal) return { ok: false as const, error: "goal-terminal" as const };
      const lease = this.db.queryOne<Lease>("SELECT fencing_token,holder_instance_id,expires_at FROM leases WHERE goal_id = ?", goalId);
      const expires = lease?.expires_at ? Date.parse(lease.expires_at) : 0;
      if (lease?.holder_instance_id && lease.holder_instance_id !== this.instanceId && expires > now.getTime()) return { ok: false as const, error: "lease-held" as const };
      const liveOwned = lease?.holder_instance_id === this.instanceId && expires > now.getTime();
      const token = liveOwned ? lease.fencing_token : lease ? lease.fencing_token + 1 : 1;
      this.db.run("INSERT INTO leases(goal_id,fencing_token,holder_instance_id,expires_at) VALUES(?,?,?,?) ON CONFLICT(goal_id) DO UPDATE SET fencing_token=excluded.fencing_token,holder_instance_id=excluded.holder_instance_id,expires_at=excluded.expires_at", goalId, token, this.instanceId, new Date(now.getTime() + this.leaseTtlMs).toISOString());
      this.audit(goalId, liveOwned ? "lease_renewed" : "lease_acquired", this.instanceId, { fencingToken: token }, undefined, undefined, now.toISOString());
      return { ok: true as const, fencingToken: token };
    });
    return result.immediate();
  }

  renewLease(goalId: string, fencingToken: number): Result {
    return this.db.transaction(() => {
      const now = this.clock.now();
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      this.db.run("UPDATE leases SET expires_at=? WHERE goal_id=? AND fencing_token=? AND holder_instance_id=?", new Date(now.getTime() + this.leaseTtlMs).toISOString(), goalId, fencingToken, this.instanceId);
      this.audit(goalId, "lease_renewed", this.instanceId, { fencingToken }, undefined, undefined, now.toISOString());
      return { ok: true as const };
    }).immediate();
  }

  releaseLease(goalId: string, fencingToken: number): Result {
    const now = this.clock.now().toISOString();
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      this.audit(goalId, "lease_released", this.instanceId, { fencingToken }, undefined, undefined, now);
      this.db.run("UPDATE leases SET holder_instance_id=NULL,expires_at=NULL WHERE goal_id=? AND fencing_token=? AND holder_instance_id=?", goalId, fencingToken, this.instanceId);
      return { ok: true as const };
    }).immediate();
  }

  ownsLease(goalId: string): boolean {
    return this.requireLease(goalId).ok;
  }

  getOwnedFencingToken(goalId: string): number | undefined {
    const lease = this.requireLease(goalId);
    return lease.ok ? lease.fencingToken : undefined;
  }

  proposeContract(goalId: string, fencingToken: number, body: Omit<ContractBody, "sourceRequest"> & { sourceRequest?: string }, criteria: readonly AcceptanceCriterion[], readyGateFacts: ReadyGateFacts, operationKey: string, preflight: { head: string; clean: boolean }): { ok: true; ready: true; revision: number; hash: string; attemptId: string; generation: number; nativeQuestion: NativeApprovalQuestion } | { ok: true; ready: false; dimensions: readonly { dimension: string; status: "pass" | "block"; reason?: string | undefined }[] } | { ok: false; error: string } {
    const goal = this.getGoal(goalId);
    if (!goal) return { ok: false, error: "goal-not-found" };
    const parsedBody = ContractBodySchema.safeParse({ ...body, sourceRequest: goal.sourceRequest });
    const parsedCriteria = z.array(AcceptanceCriterionSchema).safeParse(criteria);
    if (!parsedBody.success || !parsedCriteria.success) return { ok: false, error: "invalid-contract" };
    const criterionIds = new Set<string>();
    for (const criterion of parsedCriteria.data) {
      if (criterionIds.has(criterion.id)) return { ok: false, error: "duplicate-criterion-id" };
      criterionIds.add(criterion.id);
    }
    const readiness = evaluateReadiness(parsedBody.data, parsedCriteria.data, readyGateFacts);
    if (!readiness.ready) return { ok: true, ready: false, dimensions: readiness.dimensions };
    if (!preflight.clean) return { ok: false, error: "workspace-dirty-before-approval" };
    const replay = this.db.queryOne<{ revision: number; hash: string; attempt_id: string; generation: number; native_question_json: string }>(
      "SELECT r.revision,r.hash,a.attempt_id,a.generation,a.native_question_json FROM contract_revisions r JOIN approval_attempts a ON a.goal_id=r.goal_id AND a.revision=r.revision AND a.contract_hash=r.hash WHERE r.goal_id=? AND r.operation_key=? ORDER BY a.generation DESC LIMIT 1",
      goalId, operationKey,
    );
    if (replay) {
      const parsed = NativeApprovalQuestionSchema.safeParse(JSON.parse(String(replay.native_question_json)) as { value?: unknown } | unknown);
      const question = parsed.success ? parsed.data : JSON.parse(String(replay.native_question_json));
      return { ok: true, ready: true, revision: Number(replay.revision), hash: String(replay.hash), attemptId: String(replay.attempt_id), generation: Number(replay.generation), nativeQuestion: question as NativeApprovalQuestion };
    }
    const hash = computeRevisionHash(parsedBody.data, parsedCriteria.data);
    const attemptId = this.ids.next();
    const now = this.clock.now().toISOString();
    const txn = this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const currentGoal = this.getGoal(goalId);
      if (!currentGoal || currentGoal.state !== "FORMING" || currentGoal.sourceRequest !== goal.sourceRequest) return { ok: false as const, error: "invalid-state" };
      const revision = (this.db.queryOne<{ revision: number }>("SELECT MAX(revision) AS revision FROM contract_revisions WHERE goal_id = ?", goalId)?.revision ?? -1) + 1;
      this.db.run("INSERT INTO contract_revisions(goal_id,revision,body_json,hash,operation_key,created_at) VALUES(?,?,?,?,?,?)", goalId, revision, JSON.stringify(parsedBody.data), hash, operationKey, now);
       for (const criterion of parsedCriteria.data) this.db.run("INSERT INTO acceptance_criteria(criterion_row_id,goal_id,revision,criterion_id,priority,description,verification_json) VALUES(?,?,?,?,?,?,?)", this.ids.next(), goalId, revision, criterion.id, criterion.priority, criterion.description, JSON.stringify(criterion.verification));
      const generation = (this.db.queryOne<{ generation: number }>("SELECT COALESCE(MAX(generation),0) AS generation FROM approval_attempts WHERE goal_id=?", goalId)?.generation ?? 0) + 1;
      const predecessor = this.db.queryOne<{ attempt_id: string }>("SELECT attempt_id FROM approval_attempts WHERE goal_id=? ORDER BY generation DESC LIMIT 1", goalId)?.attempt_id ?? null;
      this.db.run("INSERT INTO approval_attempts(attempt_id,goal_id,generation,predecessor_attempt_id,revision,contract_hash,root_session_id,native_request_id,call_id,native_question_json,option_mapping_json,answer_json,preflight_snapshot_json,status,expires_at,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", attemptId, goalId, generation, predecessor, revision, hash, currentGoal.rootSessionId, null, null, canonicalJson(createApprovalQuestion(formatContractApprovalSummary(parsedBody.data, parsedCriteria.data), generation)), JSON.stringify({ "Approve and start": "approve", Revise: "revise", Cancel: "cancel" }), null, JSON.stringify(preflight), "PENDING", new Date(this.clock.now().getTime() + 15 * 60 * 1000).toISOString(), now, null);
      this.setState(goalId, "AWAITING_APPROVAL", now);
      this.db.run("UPDATE goals SET current_revision = ?, formation_request = NULL, updated_at = ? WHERE goal_id = ?", revision, now, goalId);
       this.audit(goalId, "contract_proposed", this.instanceId, { revision, hash, attemptId, generation }, "FORMING", "AWAITING_APPROVAL", now);
       return { ok: true as const, ready: true as const, revision, hash, attemptId, generation, nativeQuestion: createApprovalQuestion(formatContractApprovalSummary(parsedBody.data, parsedCriteria.data), generation) };
    });
     return txn.immediate();
   }

  beginFinalization(goalId: string, fencingToken: number, runId: string): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId);
      const run = this.getRunById(runId);
      if (!goal || !run || goal.state !== "ACTIVE" || run.runId !== runId || run.status === "FINALIZING") return run?.status === "FINALIZING" ? { ok: true as const } : { ok: false as const, error: "stale-completion-proposal" };
      if (run.status !== "ACTIVE") return { ok: false as const, error: "stale-completion-proposal" };
      const now = this.clock.now().toISOString();
      this.db.run("UPDATE runs SET status='FINALIZING',row_version=row_version+1,updated_at=? WHERE run_id=? AND status='ACTIVE'", now, runId);
      if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) return { ok: false as const, error: "stale-completion-proposal" };
      this.audit(goalId, "run_finalization_started", this.instanceId, { runId }, "ACTIVE", "ACTIVE", now);
      return { ok: true as const };
    }).immediate();
  }

  bindApprovalQuestion(goalId: string, fencingToken: number, callId: string, args: unknown): { ok: true; attemptId: string } | { ok: false; error: string } {
    const actual = canonicalJson(args);
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const row = this.db.queryOne<{ attempt_id: string; goal_id: string; call_id: string | null; native_question_json: string }>("SELECT attempt_id,goal_id,call_id,native_question_json FROM approval_attempts WHERE goal_id = ? AND status = 'PENDING' AND (call_id IS NULL OR call_id=?) ORDER BY generation DESC", goalId, callId);
      if (!row || row.native_question_json !== actual) return { ok: false as const, error: "question-does-not-match-pending-approval" };
      if (row.call_id === callId) return { ok: true as const, attemptId: row.attempt_id };
      this.db.run("UPDATE approval_attempts SET call_id = ? WHERE attempt_id = ? AND status = 'PENDING' AND call_id IS NULL", callId, row.attempt_id);
      if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) return { ok: false as const, error: "approval-already-bound" };
      this.db.run("UPDATE dispatches SET status='COMPLETED',updated_at=? WHERE approval_attempt_id=? AND kind='approval-reissue' AND status IN ('PENDING','SENT','STARTED')", this.clock.now().toISOString(), row.attempt_id);
      this.audit(goalId, "approval_question_bound", goalId, { attemptId: row.attempt_id, callId }, undefined, undefined, this.clock.now().toISOString());
      return { ok: true as const, attemptId: row.attempt_id };
    }).immediate();
  }

  bindApprovalNativeRequest(goalId: string, fencingToken: number, attemptId: string, requestId: string, callId: string): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const attempt = this.db.queryOne<{ call_id: string | null; native_request_id: string | null; status: string }>("SELECT call_id,native_request_id,status FROM approval_attempts WHERE attempt_id=? AND goal_id=? ", attemptId, goalId);
      if (!attempt || attempt.status !== "PENDING" || attempt.call_id !== callId) return { ok: false as const, error: "approval-binding-mismatch" };
      if (attempt.native_request_id && attempt.native_request_id !== requestId) return { ok: false as const, error: "approval-request-already-bound" };
      if (!attempt.native_request_id) {
        this.db.run("UPDATE approval_attempts SET native_request_id=? WHERE attempt_id=?", requestId, attemptId);
        this.audit(goalId, "approval_native_request_bound", this.instanceId, { attemptId, requestId }, undefined, undefined, this.clock.now().toISOString());
      }
      return { ok: true as const };
    }).immediate();
  }

  resolveApproval(goalId: string, fencingToken: number, callId: string, answerLabels: readonly (readonly string[])[]): { ok: true; action: "approved"; runId: string; dispatchId: string; messageId: string; revision: number; hash: string } | { ok: true; action: "revise" | "cancel" } | { ok: false; error: string } {
    const now = this.clock.now().toISOString();
    const txn = this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
       const row = this.db.queryOne<Record<string, unknown>>("SELECT * FROM approval_attempts WHERE goal_id = ? AND (call_id = ? OR native_request_id = ?) AND status = 'PENDING'", goalId, callId, callId);
       if (!row) return { ok: false as const, error: "approval-not-found" };
       const boundCallId = String(row.call_id);
      const optionMapping = JSON.parse(String(row.option_mapping_json)) as Record<string, string>;
       const mapping: ApprovalResponseMap = {
         approvalId: String(row.attempt_id), goalId: String(row.goal_id), revision: Number(row.revision), contractHash: String(row.contract_hash), rootSessionId: String(row.root_session_id), requestId: row.native_request_id === null ? null : String(row.native_request_id), callId: boundCallId, canonicalPayload: String(row.native_question_json), expiresAt: String(row.expires_at), consumed: false,
        questions: [{ id: "contract-approval", options: [{ id: "approve", label: "Approve and start" }, { id: "revise", label: "Revise" }, { id: "cancel", label: "Cancel" }] }],
      };
      if (optionMapping["Approve and start"] !== "approve" || optionMapping.Revise !== "revise" || optionMapping.Cancel !== "cancel") return { ok: false as const, error: "approval-option-mapping-missing" };
       const identity = { approvalId: mapping.approvalId, goalId: mapping.goalId, revision: mapping.revision, contractHash: mapping.contractHash, rootSessionId: String(row.root_session_id), requestId: mapping.requestId, callId: boundCallId, canonicalPayload: mapping.canonicalPayload };
      const answer = mapApprovalAnswers(mapping, identity, answerLabels, this.clock.now());
      if (!answer.ok) return { ok: false as const, error: `invalid-approval-answer:${answer.reason}` };
      const optionId = answer.optionId;
      const goal = this.getGoal(goalId);
      if (!goal || goal.state !== "AWAITING_APPROVAL") return { ok: false as const, error: "invalid-state" };
      if (!goal.model) return { ok: false as const, error: "model-pin-missing" };
      const answerJson = JSON.stringify({ labels: answerLabels, optionIds: [[optionId]] });
      if (optionId === "revise") {
         this.db.run("UPDATE dispatches SET status='COMPLETED',updated_at=? WHERE approval_attempt_id=? AND kind='approval-reissue' AND status IN ('PENDING','SENT','STARTED')", now, String(row.attempt_id));
         this.db.run("UPDATE approval_attempts SET status='REVISED',answer_json=?,resolved_at=? WHERE attempt_id=?", answerJson, now, String(row.attempt_id));
        this.setState(goalId, "FORMING", now);
        this.audit(goalId, "contract_rejected_for_revision", goalId, {}, "AWAITING_APPROVAL", "FORMING", now);
        return { ok: true as const, action: "revise" as const };
      }
      if (optionId === "cancel") {
         this.db.run("UPDATE dispatches SET status='COMPLETED',updated_at=? WHERE approval_attempt_id=? AND kind='approval-reissue' AND status IN ('PENDING','SENT','STARTED')", now, String(row.attempt_id));
         this.db.run("UPDATE approval_attempts SET status='CANCELLED',answer_json=?,resolved_at=? WHERE attempt_id=?", answerJson, now, String(row.attempt_id));
        this.setState(goalId, "CANCELLED", now);
        this.audit(goalId, "goal_cancelled", goalId, {}, "AWAITING_APPROVAL", "CANCELLED", now);
        this.db.run("UPDATE leases SET holder_instance_id=NULL,expires_at=NULL WHERE goal_id=? AND fencing_token=? AND holder_instance_id=?", goalId, fencingToken, this.instanceId);
        return { ok: true as const, action: "cancel" as const };
      }
      const runId = this.ids.next(); const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next());
      const revision = Number(row.revision); const contractHash = String(row.contract_hash); const workspaceStrategy = this.workspaceForRevision(goalId, revision);
      const payload = { kind: "executor-initial", instruction: "Execute the exact approved Contract. Start with goat_state, record criterion evidence, then call goat_completion_propose or goat_block." };
       this.db.run("UPDATE approval_attempts SET status='APPROVED',answer_json=?,resolved_at=? WHERE attempt_id=?", answerJson, now, String(row.attempt_id));
      this.db.run("UPDATE goals SET approved_revision_hash=?,updated_at=? WHERE goal_id=?", contractHash, now, goalId);
       this.db.run("INSERT INTO runs(run_id,goal_id,approval_attempt_id,revision,approved_revision_hash,workspace_strategy,worktree_name,workspace_path,baseline_json,checkpoint_json,final_snapshot_json,executor_diff_json,executor_session_id,executor_session_key,executor_project_id,executor_workspace_id,model_provider_id,model_id,model_variant,status,verification_attempts,verification_batch,preparation_retry_requested,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", runId, goalId, String(row.attempt_id), revision, contractHash, workspaceStrategy, workspaceStrategy === "worktree" ? `goat-${runId}` : null, null, null, null, null, null, null, runId, null, null, goal.model!.providerID, goal.model!.id, goal.model!.variant ?? null, "PREPARING", 0, 1, 0, 0, now, now);
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, runId, String(row.attempt_id), revision, contractHash, "executor-initial", "executor", null, null, null, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, now, now);
      this.db.run("UPDATE goals SET current_run_id=?,updated_at=? WHERE goal_id=?", runId, now, goalId);
      this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "executor-initial" }, undefined, undefined, now);
      this.audit(goalId, "contract_approved", goalId, { revision, attemptId: String(row.attempt_id) }, "AWAITING_APPROVAL", "AWAITING_APPROVAL", now);
      return { ok: true as const, action: "approved" as const, runId, dispatchId, messageId, revision, hash: contractHash };
    });
    return txn.immediate();
  }

  markApprovalRejected(goalId: string, fencingToken: number, sourceEventId: string | null): { ok: true; attemptId: string | null } | { ok: false; error: string } {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const attempt = this.db.queryOne<{ attempt_id: string; status: string }>("SELECT attempt_id,status FROM approval_attempts WHERE goal_id=? AND status = 'PENDING' ORDER BY generation DESC LIMIT 1", goalId);
      if (!attempt) return { ok: true as const, attemptId: null };
      const goal = this.getGoal(goalId);
      if (!goal || goal.state !== "AWAITING_APPROVAL") return { ok: false as const, error: "invalid-state" };
      const now = this.clock.now().toISOString();
       this.db.run("UPDATE approval_attempts SET status='REJECTED',resolved_at=? WHERE attempt_id=? AND status='PENDING'", now, attempt.attempt_id);
      this.db.run("UPDATE goals SET blocker_code='approval-not-approved',blocker='The native approval question was rejected or closed.',updated_at=? WHERE goal_id=?", now, goalId);
      this.setState(goalId, "BLOCKED", now);
      this.supersedeDispatches(goalId, null, "approval-not-approved", now);
      this.audit(goalId, "approval_rejected", this.instanceId, { attemptId: attempt.attempt_id }, "AWAITING_APPROVAL", "BLOCKED", now, sourceEventId);
      this.audit(goalId, "goal_blocked", this.instanceId, { code: "approval-not-approved" }, "AWAITING_APPROVAL", "BLOCKED", now, sourceEventId);
      return { ok: true as const, attemptId: attempt.attempt_id };
    }).immediate();
  }

  reissueApproval(goalId: string, fencingToken: number, reason: string): { ok: true; attemptId: string; dispatchId: string; messageId: string } | { ok: false; error: string } {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const attempt = this.db.queryOne<Record<string, unknown>>("SELECT * FROM approval_attempts WHERE goal_id=? AND status = 'PENDING' ORDER BY generation DESC LIMIT 1", goalId);
      const goal = this.getGoal(goalId);
      if (!attempt || !goal || goal.state !== "AWAITING_APPROVAL") return { ok: false as const, error: "approval-not-pending" };
      const now = this.clock.now();
      const nowIso = now.toISOString();
      const nextGeneration = Number(attempt.generation) + 1;
      const nextAttemptId = this.ids.next();
      const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next());
      const question = this.reissueQuestion(JSON.parse(String(attempt.native_question_json)) as { value?: unknown } | unknown, nextGeneration);
       this.db.run("UPDATE approval_attempts SET status='EXPIRED',resolved_at=? WHERE attempt_id=? AND status='PENDING'", nowIso, String(attempt.attempt_id));
       this.db.run("UPDATE dispatches SET status='SUPERSEDED',failure_reason='approval-generation-replaced',updated_at=? WHERE approval_attempt_id=? AND kind='approval-reissue' AND status IN ('PENDING','SENT','STARTED')", nowIso, String(attempt.attempt_id));
       this.db.run("INSERT INTO approval_attempts(attempt_id,goal_id,generation,predecessor_attempt_id,revision,contract_hash,root_session_id,native_request_id,call_id,native_question_json,option_mapping_json,answer_json,preflight_snapshot_json,status,expires_at,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", nextAttemptId, goalId, nextGeneration, String(attempt.attempt_id), Number(attempt.revision), String(attempt.contract_hash), String(attempt.root_session_id), null, null, canonicalJson(question), String(attempt.option_mapping_json), null, String(attempt.preflight_snapshot_json), "PENDING", new Date(now.getTime() + 15 * 60 * 1000).toISOString(), nowIso, null);
      const payload = { kind: "approval-reissue", nativeQuestion: question };
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, null, nextAttemptId, Number(attempt.revision), String(attempt.contract_hash), "approval-reissue", "formulator", null, String(attempt.root_session_id), goal.projectDirectory, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, nowIso, nowIso);
      this.audit(goalId, "approval_expired", this.instanceId, { attemptId: String(attempt.attempt_id), reason }, undefined, undefined, nowIso);
      this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "approval-reissue" }, undefined, undefined, nowIso);
      return { ok: true as const, attemptId: nextAttemptId, dispatchId, messageId };
    }).immediate();
  }

  resumeBlockedApproval(goalId: string, fencingToken: number): { ok: true; attemptId: string; dispatchId: string; messageId: string; revision: number; hash: string } | { ok: false; error: string } {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId);
      if (!goal || goal.state !== "BLOCKED" || goal.blockerCode !== "approval-not-approved") return { ok: false as const, error: "invalid-state" };
      const latest = this.db.queryOne<Record<string, unknown>>("SELECT * FROM approval_attempts WHERE goal_id=? ORDER BY generation DESC LIMIT 1", goalId);
      if (!latest) return { ok: false as const, error: "approval-not-found" };
       if (latest.status === "PENDING") return { ok: false as const, error: "approval-already-live" };
      const now = this.clock.now();
      const nowIso = now.toISOString();
      const nextGeneration = Number(latest.generation) + 1;
      const nextAttemptId = this.ids.next();
      const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next());
      const question = this.reissueQuestion(JSON.parse(String(latest.native_question_json)) as { value?: unknown } | unknown, nextGeneration);
       this.db.run("INSERT INTO approval_attempts(attempt_id,goal_id,generation,predecessor_attempt_id,revision,contract_hash,root_session_id,native_request_id,call_id,native_question_json,option_mapping_json,answer_json,preflight_snapshot_json,status,expires_at,created_at,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", nextAttemptId, goalId, nextGeneration, String(latest.attempt_id), Number(latest.revision), String(latest.contract_hash), String(latest.root_session_id), null, null, canonicalJson(question), String(latest.option_mapping_json), null, String(latest.preflight_snapshot_json), "PENDING", new Date(now.getTime() + 15 * 60 * 1000).toISOString(), nowIso, null);
      const payload = { kind: "approval-reissue", nativeQuestion: question };
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, null, nextAttemptId, Number(latest.revision), String(latest.contract_hash), "approval-reissue", "formulator", null, String(latest.root_session_id), goal.projectDirectory, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, nowIso, nowIso);
      this.db.run("UPDATE goals SET blocker_code=NULL,blocker=NULL,updated_at=? WHERE goal_id=?", nowIso, goalId);
      this.setState(goalId, "AWAITING_APPROVAL", nowIso);
      this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "approval-reissue" }, undefined, undefined, nowIso);
      this.audit(goalId, "approval_resumed", this.instanceId, { attemptId: nextAttemptId, generation: nextGeneration }, "BLOCKED", "AWAITING_APPROVAL", nowIso);
      return { ok: true as const, attemptId: nextAttemptId, dispatchId, messageId, revision: Number(latest.revision), hash: String(latest.contract_hash) };
    }).immediate();
  }

  recordWorkspacePrepared(goalId: string, fencingToken: number, runId: string, workspacePath: string): Result {
    const now = this.clock.now().toISOString();
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!goal || !run || run.runId !== runId || !["PREPARING", "BLOCKED"].includes(run.status)) return { ok: false as const, error: "run-not-preparing" };
      if (run.status === "BLOCKED" && !run.preparationRetryRequested) return { ok: false as const, error: "preparation-retry-not-requested" };
      const normalizedWorkspacePath = persistedPath(workspacePath);
      this.db.run("UPDATE runs SET workspace_path=?,updated_at=? WHERE run_id=?", normalizedWorkspacePath, now, runId);
      this.audit(goalId, "workspace_prepared", this.instanceId, { runId, workspacePath: normalizedWorkspacePath }, goal.state, goal.state, now);
      return { ok: true as const };
    }).immediate();
  }

  activateRun(goalId: string, fencingToken: number, runId: string, baselineValue: WorkspaceSnapshot): { ok: true; dispatchId: string; messageId: string } | { ok: false; error: string } {
    const baseline = WorkspaceSnapshotSchema.safeParse(baselineValue); if (!baseline.success) return { ok: false, error: "invalid-workspace-baseline" };
    if (!isWorkspaceClean(baseline.data)) return { ok: false, error: "workspace-baseline-not-clean" };
    const now = this.clock.now().toISOString();
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!goal || !run || run.runId !== runId || !run.workspacePath || !["PREPARING", "BLOCKED"].includes(run.status)) return { ok: false as const, error: "run-not-prepared" };
      if (!goal.approvedRevisionHash || goal.approvedRevisionHash !== run.approvedRevisionHash) return { ok: false as const, error: "approved-revision-mismatch" };
       const retry = run.status === "BLOCKED";
      if (!((goal.state === "AWAITING_APPROVAL" && !retry) || (goal.state === "BLOCKED" && retry && run.preparationRetryRequested))) return { ok: false as const, error: "invalid-activation-state" };
       this.db.run("UPDATE runs SET baseline_json=?,status='ACTIVE',preparation_retry_requested=0,row_version=row_version+1,updated_at=? WHERE run_id=?", JSON.stringify(baseline.data), now, runId);
       this.db.run("UPDATE goals SET blocker_code=NULL,blocker=NULL,updated_at=? WHERE goal_id=?", now, goalId);
       this.setState(goalId, "ACTIVE", now);
      if (!retry) {
       this.db.run("UPDATE dispatches SET directory=?,updated_at=? WHERE run_id=? AND kind='executor-initial' AND status='PENDING'", run.workspacePath, now, runId);
       const dispatch = this.db.queryOne<{ dispatch_id: string; message_id: string }>("SELECT dispatch_id,message_id FROM dispatches WHERE run_id=? AND kind='executor-initial' AND status='PENDING'", runId);
        this.audit(goalId, "run_activated", this.instanceId, { runId, workspacePath: run.workspacePath }, goal.state, "ACTIVE", now);
        if (!dispatch) return { ok: false as const, error: "executor-dispatch-missing" };
        return { ok: true as const, dispatchId: String(dispatch.dispatch_id), messageId: String(dispatch.message_id) };
      }
      const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next());
      const payload = { kind: "executor-resume", reason: "workspace-preparation-retry-succeeded" };
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, runId, run.approvalAttemptId, run.revision, run.approvedRevisionHash, "executor-resume", "executor", null, run.executorSessionId, run.workspacePath, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, now, now);
      this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "executor-resume" }, undefined, undefined, now);
      this.audit(goalId, "run_preparation_recovered", this.instanceId, { runId, dispatchId }, goal.state, "ACTIVE", now);
      return { ok: true as const, dispatchId, messageId };
    }).immediate();
  }

  failRunPreparation(goalId: string, fencingToken: number, runId: string, code: BlockerCode, reason: string): Result {
    const now = this.clock.now().toISOString();
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      const initialPreparation = goal?.state === "AWAITING_APPROVAL" && run?.status === "PREPARING";
      const retriedPreparation = goal?.state === "BLOCKED" && run?.status === "BLOCKED" && run.preparationRetryRequested;
      if (!goal || !run || run.runId !== runId || (!initialPreparation && !retriedPreparation)) return { ok: false as const, error: "run-not-preparing" };
      const safeReason = diagnosticReason(reason);
       this.db.run("UPDATE runs SET status='BLOCKED',preparation_retry_requested=0,row_version=row_version+1,updated_at=? WHERE run_id=?", now, runId);
      this.db.run("UPDATE dispatches SET status='FAILED',failure_reason=?,updated_at=? WHERE run_id=? AND kind='executor-initial' AND status IN ('PENDING','SENT','STARTED')", safeReason, now, runId);
      this.db.run("UPDATE goals SET blocker_code=?,blocker=?,updated_at=? WHERE goal_id=?", code, safeReason, now, goalId);
      if (initialPreparation) this.setState(goalId, "BLOCKED", now);
      this.audit(goalId, "run_preparation_failed", this.instanceId, { runId, reason, retry: retriedPreparation }, goal.state, "BLOCKED", now);
      return { ok: true as const };
    }).immediate();
  }

  bindExecutorSession(goalId: string, fencingToken: number, runId: string, sessionId: string, identity: { projectId: string | null; workspaceId: string | null }, model?: SessionModel): { ok: true } | { ok: false; error: string } {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const current = this.getRun(goalId); const goal = this.getGoal(goalId);
      if (!current || current.runId !== runId || !goal || !sessionId) return { ok: false as const, error: "executor-session-not-bindable" };
      if (!["PREPARING", "ACTIVE", "BLOCKED", "VERIFYING"].includes(current.status)) return { ok: false as const, error: "executor-session-not-bindable" };
      if (current.executorSessionId && current.executorSessionId !== sessionId) return { ok: false as const, error: "executor-session-already-bound" };
      const now = this.clock.now().toISOString();
      if (!this.bindSession(sessionId, goalId, runId, "executor", now)) return { ok: false as const, error: "executor-session-revoked" };
      this.db.run("UPDATE runs SET executor_session_id=?,executor_project_id=?,executor_workspace_id=?,model_provider_id=COALESCE(model_provider_id,?),model_id=COALESCE(model_id,?),model_variant=COALESCE(model_variant,?),row_version=row_version+1,updated_at=? WHERE run_id=?", sessionId, identity.projectId, identity.workspaceId, model?.providerID ?? null, model?.id ?? null, model?.variant ?? null, now, runId);
      this.db.run("UPDATE dispatches SET target_session_id=? WHERE run_id=? AND role='executor' AND status IN ('PENDING','SENT','STARTED')", sessionId, runId);
      this.audit(goalId, "executor_session_bound", this.instanceId, { runId, sessionId }, undefined, undefined, now);
      return { ok: true as const };
    }).immediate();
  }

  replaceExecutorSession(goalId: string, fencingToken: number, runId: string, previousSessionId: string, sessionId: string, identity: { projectId: string | null; workspaceId: string | null }): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const current = this.getRun(goalId);
      if (!current || current.runId !== runId || current.executorSessionId !== previousSessionId) return { ok: false as const, error: "executor-session-not-replaceable" };
      const now = this.clock.now().toISOString();
      if (!this.bindSession(sessionId, goalId, runId, "executor", now)) return { ok: false as const, error: "executor-session-revoked" };
      this.revokeSession(previousSessionId, now);
      this.db.run("UPDATE runs SET executor_session_id=?,executor_project_id=?,executor_workspace_id=?,row_version=row_version+1,updated_at=? WHERE run_id=? AND executor_session_id=?", sessionId, identity.projectId, identity.workspaceId, now, runId, previousSessionId);
      if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) return { ok: false as const, error: "executor-session-replacement-race" };
      this.db.run("UPDATE dispatches SET target_session_id=? WHERE run_id=? AND role='executor' AND status IN ('PENDING','SENT','STARTED')", sessionId, runId);
      this.audit(goalId, "executor_session_replaced", this.instanceId, { runId, previousSessionId, sessionId }, undefined, undefined, now);
      return { ok: true as const };
    }).immediate();
  }

  recordEvidence(goalId: string, fencingToken: number, runId: string, criterionId: string, value: Omit<Evidence, "criterionId" | "recordedAt">, operationKey: string): { ok: true; evidenceId: string } | { ok: false; error: string } {
    const replay = this.db.queryOne<{ evidence_id: string }>("SELECT evidence_id FROM evidence WHERE operation_key=?", operationKey);
    if (replay) return { ok: true, evidenceId: replay.evidence_id };
    const evidenceId = this.ids.next();
    const result = this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!goal || !run || run.runId !== runId) return { ok: false as const, error: "run-not-found" };
      if (goal.state !== "ACTIVE" || run.status !== "ACTIVE") return { ok: false as const, error: "invalid-state" };
      if (!goal.approvedRevisionHash || goal.approvedRevisionHash !== run.approvedRevisionHash) return { ok: false as const, error: "approved-revision-mismatch" };
      if (!this.getCriteria(goalId, run.revision).some((criterion) => criterion.id === criterionId)) return { ok: false as const, error: "criterion-not-found" };
      const now = this.clock.now().toISOString();
      const parsed = EvidenceSchema.parse({ ...value, criterionId, recordedAt: now });
      this.db.run("INSERT INTO evidence(evidence_id,goal_id,run_id,revision,contract_hash,criterion_id,source,method,expected_result,actual_reference,producer,operation_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", evidenceId, goalId, run.runId, run.revision, run.approvedRevisionHash, criterionId, parsed.source, parsed.method, parsed.expectedResult, parsed.actualReference, parsed.producer, operationKey, now);
      this.audit(goalId, "evidence_recorded", parsed.producer, { evidenceId, criterionId }, undefined, undefined, now);
      return { ok: true as const, evidenceId };
    });
    return result.immediate();
  }

  proposeCompletion(goalId: string, fencingToken: number, runId: string, finalSnapshotValue: WorkspaceSnapshot, executorDiff: readonly CanonicalDiffEntry[], operationKey: string): { ok: true; runId: string; attempt: number; dispatchId: string; messageId: string } | { ok: false; error: string; gaps?: readonly string[] } {
    const finalSnapshot = WorkspaceSnapshotSchema.safeParse(finalSnapshotValue); if (!finalSnapshot.success) return { ok: false, error: "invalid-final-workspace-snapshot" };
    const replay = this.db.queryOne<{ attempt: number; dispatch_id: string }>("SELECT attempt,dispatch_id FROM verification_results WHERE operation_key=?", operationKey);
    if (replay) {
      const dispatch = this.getDispatch(replay.dispatch_id);
      return { ok: true, runId, attempt: Number(replay.attempt), dispatchId: replay.dispatch_id, messageId: dispatch?.messageId ?? "" };
    }
    const result = this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const currentGoal = this.getGoal(goalId); const currentRun = this.getRun(goalId);
       if (!currentGoal || currentGoal.state !== "ACTIVE" || !currentRun || currentRun.runId !== runId || currentRun.status !== "FINALIZING" || !currentRun.baseline) return { ok: false as const, error: "stale-completion-proposal" };
      const contractHash = currentGoal.approvedRevisionHash;
      if (!contractHash || contractHash !== currentRun.approvedRevisionHash || !currentRun.workspacePath) return { ok: false as const, error: "run-identity-incomplete" };
      const criteria = this.getCriteria(goalId, currentRun.revision); const evidence = this.getEvidence(goalId, currentRun.runId);
      const coverage = checkCompletionCoverage(criteria, evidence); if (!coverage.complete) return { ok: false as const, error: "must-evidence-incomplete", gaps: coverage.gaps };
       const batchLimit = currentRun.verificationBatch * DEFAULT_MAX_VERIFICATION_ATTEMPTS;
       if (currentRun.verificationAttempts >= batchLimit) return { ok: false as const, error: "verification-budget-exhausted" };
       const comparison = assertExecutorOwnsSnapshot(currentRun.baseline, finalSnapshot.data, executorDiff);
      if (!comparison.ok) {
        const now = this.clock.now().toISOString();
         this.db.run("UPDATE runs SET final_snapshot_json=?,executor_diff_json=?,status='BLOCKED',row_version=row_version+1,updated_at=? WHERE run_id=?", JSON.stringify(finalSnapshot.data), JSON.stringify(executorDiff), now, currentRun.runId);
        this.db.run("UPDATE goals SET blocker_code=?,blocker=?,updated_at=? WHERE goal_id=?", comparison.code === "head-changed" ? "workspace-head-changed" : comparison.code === "attribution-incomplete" ? "workspace-comparison-invalid" : "workspace-concurrent-changes", comparison.detail, now, goalId);
        this.setState(goalId, "BLOCKED", now);
        this.audit(goalId, "workspace_conflict_detected", this.instanceId, { code: comparison.code, detail: comparison.detail }, "ACTIVE", "BLOCKED", now);
        return { ok: false as const, error: comparison.code === "head-changed" ? "workspace-head-changed" : comparison.code === "attribution-incomplete" ? "workspace-comparison-invalid" : "workspace-concurrent-changes" };
      }
      const attempt = currentRun.verificationAttempts + 1; const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next()); const resultId = this.ids.next(); const now = this.clock.now().toISOString();
      const payload = { kind: "verifier", attempt, instruction: "Independently verify every approved criterion against the Contract, workspace diff, and immutable evidence." };
       this.db.run("UPDATE runs SET verification_attempts=?,status='VERIFYING',final_snapshot_json=?,executor_diff_json=?,row_version=row_version+1,updated_at=? WHERE run_id=? AND status='FINALIZING'", attempt, JSON.stringify(finalSnapshot.data), JSON.stringify(executorDiff), now, currentRun.runId);
      if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) return { ok: false as const, error: "stale-completion-proposal" };
      const executorDispatch = this.db.queryOne<{ dispatch_id: string }>("SELECT dispatch_id FROM dispatches WHERE run_id=? AND role='executor' AND status IN ('STARTED','SENT') ORDER BY created_at DESC LIMIT 1", currentRun.runId);
      if (executorDispatch) this.db.run("UPDATE dispatches SET status='COMPLETED',updated_at=? WHERE dispatch_id=?", now, executorDispatch.dispatch_id);
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, currentRun.runId, currentRun.approvalAttemptId, currentRun.revision, contractHash, "verifier", "verifier", attempt, null, currentRun.workspacePath, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, now, now);
       this.db.run("INSERT INTO verification_results(result_id,goal_id,run_id,revision,contract_hash,attempt,verifier_session_id,verifier_session_key,model_provider_id,model_id,model_variant,findings_json,outcome,operation_key,dispatch_id,created_at,finalized_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", resultId, goalId, currentRun.runId, currentRun.revision, contractHash, attempt, null, null, currentRun.model?.providerID ?? null, currentRun.model?.id ?? null, currentRun.model?.variant ?? null, "[]", "PENDING", operationKey, dispatchId, now, null);
      this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "verifier" }, undefined, undefined, now);
      this.setState(goalId, "VERIFYING", now);
      this.audit(goalId, "verification_started", this.instanceId, { attempt }, "ACTIVE", "VERIFYING", now);
      return { ok: true as const, runId: currentRun.runId, attempt, dispatchId, messageId };
    });
    return result.immediate();
  }

  bindVerifierSession(goalId: string, fencingToken: number, dispatchId: string, verifierSessionId: string, sessionKey: string): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const current = this.getDispatch(dispatchId); const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!current || current.role !== "verifier" || current.status !== "PENDING" || current.targetSessionId || !current.runId || !goal || goal.state !== "VERIFYING" || !run || run.runId !== current.runId || run.status !== "VERIFYING") return { ok: false as const, error: "dispatch-not-bindable" };
      const pending = this.db.queryOne("SELECT result_id FROM verification_results WHERE run_id=? AND attempt=? AND outcome='PENDING' AND verifier_session_id IS NULL", current.runId, current.verificationAttempt ?? 0);
      if (!pending) return { ok: false as const, error: "verification-result-not-bindable" };
      const now = this.clock.now().toISOString();
      if (!this.bindSession(verifierSessionId, goalId, current.runId, "verifier", now)) return { ok: false as const, error: "verifier-session-revoked" };
      this.db.run("UPDATE dispatches SET target_session_id=?,updated_at=? WHERE dispatch_id=? AND status='PENDING' AND target_session_id IS NULL", verifierSessionId, now, dispatchId);
      this.db.run("UPDATE verification_results SET verifier_session_id=?,verifier_session_key=? WHERE run_id=? AND attempt=? AND outcome='PENDING' AND verifier_session_id IS NULL", verifierSessionId, sessionKey, current.runId, current.verificationAttempt ?? 0);
      this.audit(goalId, "verifier_session_bound", this.instanceId, { dispatchId, verifierSessionId }, undefined, undefined, now);
      return { ok: true as const };
    }).immediate();
  }

  replaceVerifierSession(goalId: string, fencingToken: number, dispatchId: string, previousSessionId: string, verifierSessionId: string, sessionKey: string): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const current = this.getDispatch(dispatchId); const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!current || current.role !== "verifier" || !["PENDING", "SENT", "STARTED"].includes(current.status) || current.targetSessionId !== previousSessionId || !current.runId || !goal || goal.state !== "VERIFYING" || !run || run.runId !== current.runId || run.status !== "VERIFYING") return { ok: false as const, error: "dispatch-not-replaceable" };
      const pending = this.db.queryOne("SELECT result_id FROM verification_results WHERE run_id=? AND attempt=? AND outcome='PENDING' AND verifier_session_id=?", current.runId, current.verificationAttempt ?? 0, previousSessionId);
      if (!pending) return { ok: false as const, error: "verification-result-not-replaceable" };
      const now = this.clock.now().toISOString();
      if (!this.bindSession(verifierSessionId, goalId, current.runId, "verifier", now)) return { ok: false as const, error: "verifier-session-revoked" };
      this.revokeSession(previousSessionId, now);
      this.db.run("UPDATE dispatches SET target_session_id=?,updated_at=? WHERE dispatch_id=? AND status IN ('PENDING','SENT','STARTED') AND target_session_id=?", verifierSessionId, now, dispatchId, previousSessionId);
      this.db.run("UPDATE verification_results SET verifier_session_id=?,verifier_session_key=? WHERE run_id=? AND attempt=? AND outcome='PENDING' AND verifier_session_id=?", verifierSessionId, sessionKey, current.runId, current.verificationAttempt ?? 0, previousSessionId);
      this.audit(goalId, "verifier_session_replaced", this.instanceId, { dispatchId, previousSessionId, verifierSessionId }, undefined, undefined, now);
      return { ok: true as const };
    }).immediate();
  }

  recordVerificationAndMaybeRemediate(goalId: string, fencingToken: number, runId: string, verifierSessionId: string, findings: readonly VerificationFinding[], observedSnapshot?: WorkspaceSnapshot): { ok: true; outcome: "COMPLETED" | "VERIFYING" | "ACTIVE" | "BLOCKED"; attempt: number; dispatchId?: string; messageId?: string } | { ok: false; error: string } {
    const result = this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!goal || !run || run.runId !== runId) return { ok: false as const, error: "run-not-found" };
      const verifier = this.db.queryOne<{ attempt: number; result_id: string; outcome: string }>("SELECT v.attempt,v.result_id,v.outcome FROM verification_results v WHERE v.run_id=? AND v.verifier_session_id=? ORDER BY v.attempt DESC LIMIT 1", run.runId, verifierSessionId);
      if (!verifier) return { ok: false as const, error: "verifier-session-mismatch" };
       if (verifier.outcome !== "PENDING") {
         const existingDispatch = this.db.queryOne<{ dispatch_id: string; message_id: string }>("SELECT dispatch_id,message_id FROM dispatches WHERE run_id=? AND kind='executor-remediation' ORDER BY created_at DESC LIMIT 1", run.runId);
         if (verifier.outcome === "FAIL" && existingDispatch) return { ok: true as const, outcome: "ACTIVE" as const, attempt: Number(verifier.attempt), dispatchId: existingDispatch.dispatch_id, messageId: existingDispatch.message_id };
         return { ok: true as const, outcome: verifier.outcome === "PASS" ? "COMPLETED" as const : "BLOCKED" as const, attempt: Number(verifier.attempt) };
      }
       if (goal.state !== "VERIFYING" || run.status !== "VERIFYING") return { ok: false as const, error: "invalid-state" };
       if (observedSnapshot && run.finalSnapshot) {
         const comparison = assertSnapshotUnchanged(run.finalSnapshot, observedSnapshot);
         if (!comparison.ok) return { ok: false as const, error: "workspace-changed-during-verification" };
       }
       const verifierDispatch = this.db.queryOne<{ dispatch_id: string; status: string }>("SELECT dispatch_id,status FROM dispatches WHERE run_id=? AND verification_attempt=? AND kind='verifier' AND target_session_id=? AND status IN ('PENDING','SENT','STARTED')", run.runId, verifier.attempt, verifierSessionId);
      if (!verifierDispatch) return { ok: false as const, error: "verifier-dispatch-not-active" };
      const criteria = this.getCriteria(goalId, run.revision);
      const derivation = deriveVerificationOutcome(
       criteria.map(({ id, priority, description, verification }) => ({ id, priority, description, verification })),
        this.getEvidence(goalId, run.runId).map((item) => ({ evidenceId: item.evidenceId, criterionId: item.criterionId })),
         findings,
         ((verifier.attempt - 1) % DEFAULT_MAX_VERIFICATION_ATTEMPTS) + 1,
      );
      if (!derivation.ok) return { ok: false as const, error: derivation.error };
       if (derivation.outcome === "ACTIVE" && (!goal.approvedRevisionHash || goal.approvedRevisionHash !== run.approvedRevisionHash || !run.workspacePath)) return { ok: false as const, error: "run-identity-incomplete" };
      const outcome = derivation.outcome; const now = this.clock.now().toISOString();
       this.db.run("UPDATE verification_results SET findings_json=?,outcome=?,finalized_at=? WHERE result_id=? AND outcome='PENDING' AND verifier_session_id=?", JSON.stringify(derivation.findings), outcome === "COMPLETED" ? "PASS" : outcome === "BLOCKED" ? "BLOCKED" : "FAIL", now, verifier.result_id, verifierSessionId);
      if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) return { ok: false as const, error: "verification-result-race" };
       this.db.run("UPDATE dispatches SET status='COMPLETED',updated_at=? WHERE dispatch_id=? AND status NOT IN ('FAILED','SUPERSEDED','COMPLETED')", now, verifierDispatch.dispatch_id);
      this.audit(goalId, "dispatch_completed", this.instanceId, { dispatchId: verifierDispatch.dispatch_id, completedBy: "verifier-report" }, undefined, undefined, now);
        const deferCompletion = outcome === "COMPLETED" && observedSnapshot !== undefined;
        const nextRunStatus = deferCompletion ? "VERIFYING" : outcome === "COMPLETED" ? "COMPLETED" : outcome === "BLOCKED" ? "BLOCKED" : "ACTIVE";
        const nextGoalState = deferCompletion ? "VERIFYING" : outcome === "COMPLETED" ? "COMPLETED" : outcome === "BLOCKED" ? "BLOCKED" : "ACTIVE";
        this.db.run("UPDATE runs SET status=?,row_version=row_version+1,updated_at=? WHERE run_id=?", nextRunStatus, now, run.runId);
        if (nextGoalState !== goal.state) this.setState(goalId, nextGoalState, now);
        this.audit(goalId, "verification_recorded", verifierSessionId, { attempt: verifier.attempt, outcome, deferredCompletion: deferCompletion }, "VERIFYING", nextGoalState, now);
        if (outcome === "COMPLETED" && !deferCompletion) {
         this.db.run("UPDATE goals SET blocker_code=NULL,blocker=NULL,updated_at=? WHERE goal_id=?", now, goalId);
         this.revokeGoalSessions(goalId, now);
         this.db.run("UPDATE leases SET holder_instance_id=NULL,expires_at=NULL WHERE goal_id=? AND fencing_token=? AND holder_instance_id=?", goalId, fencingToken, this.instanceId);
         return { ok: true as const, outcome: deferCompletion ? "VERIFYING" as const : outcome, attempt: verifier.attempt };
      }
       if (outcome === "ACTIVE") {
        const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next());
        const payload = { kind: "executor-remediation", attempt: verifier.attempt, findings: derivation.findings };
         this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, run.runId, run.approvalAttemptId, run.revision, run.approvedRevisionHash, "executor-remediation", "executor", null, run.executorSessionId, run.workspacePath, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, now, now);
        this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "executor-remediation" }, undefined, undefined, now);
        this.audit(goalId, "automatic_remediation_dispatched", this.instanceId, { attempt: verifier.attempt, dispatchId }, "ACTIVE", "ACTIVE", now);
        return { ok: true as const, outcome, attempt: verifier.attempt, dispatchId, messageId };
      }
       const blockerCode = verifier.attempt >= run.verificationBatch * DEFAULT_MAX_VERIFICATION_ATTEMPTS ? "verification-budget-exhausted" : "verification-failed";
      this.db.run("UPDATE goals SET blocker_code=?,blocker=?,updated_at=? WHERE goal_id=?", blockerCode, "Verification could not pass within the allowed attempts.", now, goalId);
       return { ok: true as const, outcome: outcome === "COMPLETED" && deferCompletion ? "VERIFYING" as const : outcome, attempt: verifier.attempt };
    });
    return result.immediate();
  }

  completeVerifiedRun(goalId: string, fencingToken: number, runId: string, observedSnapshot: WorkspaceSnapshot): Result {
    const parsed = WorkspaceSnapshotSchema.safeParse(observedSnapshot);
    if (!parsed.success) return { ok: false, error: "invalid-verification-workspace-snapshot" };
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId);
      const run = this.getRun(goalId);
      const latest = run ? this.getVerificationResults(run.runId).at(-1) : undefined;
      if (!goal || !run || run.runId !== runId || goal.state !== "VERIFYING" || run.status !== "VERIFYING" || !run.finalSnapshot || latest?.outcome !== "PASS") return { ok: false as const, error: "verification-finalization-not-ready" };
      const comparison = assertSnapshotUnchanged(run.finalSnapshot, parsed.data);
      const now = this.clock.now().toISOString();
      if (!comparison.ok) {
        this.db.run("UPDATE runs SET status='BLOCKED',row_version=row_version+1,updated_at=? WHERE run_id=?", now, runId);
        this.db.run("UPDATE goals SET blocker_code='workspace-changed-during-verification',blocker=?,updated_at=? WHERE goal_id=?", comparison.detail, now, goalId);
        this.setState(goalId, "BLOCKED", now);
        this.supersedeDispatches(goalId, runId, "workspace-changed-during-verification", now);
        this.revokeGoalSessions(goalId, now);
        this.audit(goalId, "workspace_conflict_detected", this.instanceId, { code: "workspace-changed-during-verification", detail: comparison.detail }, "VERIFYING", "BLOCKED", now);
        return { ok: false as const, error: "workspace-changed-during-verification" };
      }
      this.db.run("UPDATE runs SET status='COMPLETED',row_version=row_version+1,updated_at=? WHERE run_id=? AND status='VERIFYING'", now, runId);
      this.db.run("UPDATE goals SET blocker_code=NULL,blocker=NULL,updated_at=? WHERE goal_id=?", now, goalId);
       this.setState(goalId, "COMPLETED", now);
       this.revokeGoalSessions(goalId, now);
      this.db.run("UPDATE leases SET holder_instance_id=NULL,expires_at=NULL WHERE goal_id=? AND fencing_token=? AND holder_instance_id=?", goalId, fencingToken, this.instanceId);
      this.audit(goalId, "verification_finalized", this.instanceId, { runId }, "VERIFYING", "COMPLETED", now);
      return { ok: true as const };
    }).immediate();
  }

  pauseGoal(goalId: string, fencingToken: number, checkpoint?: WorkspaceSnapshot): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId);
      if (!goal || goal.state !== "ACTIVE") return { ok: false as const, error: "invalid-transition" };
      const now = this.clock.now().toISOString();
       if (!checkpoint) return { ok: false as const, error: "checkpoint-required" };
       {
         const parsed = WorkspaceSnapshotSchema.safeParse(checkpoint);
         if (!parsed.success) return { ok: false as const, error: "invalid-workspace-checkpoint" };
         this.db.run("UPDATE runs SET status='PAUSED',checkpoint_json=?,row_version=row_version+1,updated_at=? WHERE goal_id=? AND status='ACTIVE'", JSON.stringify(parsed.data), now, goalId);
       }
      this.supersedeDispatches(goalId, null, "goal-paused", now);
      this.setState(goalId, "PAUSED", now);
      this.audit(goalId, "goal_paused", this.instanceId, {}, "ACTIVE", "PAUSED", now);
      return { ok: true as const };
    }).immediate();
  }

  resumeAndDispatch(goalId: string, fencingToken: number, runId: string, observedSnapshot?: WorkspaceSnapshot, executorDiff?: readonly CanonicalDiffEntry[]): { ok: true; dispatchId: string; messageId: string } | { ok: false; error: string } {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
      if (!goal || !run || run.runId !== runId || !["PAUSED", "BLOCKED"].includes(goal.state)) return { ok: false as const, error: "invalid-transition" };
      if (goal.state === "BLOCKED" && goal.blockerCode === "approval-not-approved") return { ok: false as const, error: "approval-resume-required" };
       if (!run.workspacePath || !run.baseline || run.status === "PREPARING") return { ok: false as const, error: "run-workspace-missing" };
      const now = this.clock.now().toISOString();
      if (run.checkpoint) {
        if (!observedSnapshot || !executorDiff) return { ok: false as const, error: "resume-workspace-not-validated" };
        const parsedSnapshot = WorkspaceSnapshotSchema.safeParse(observedSnapshot);
        if (!parsedSnapshot.success) return { ok: false as const, error: "resume-workspace-not-validated" };
         const comparison = assertSnapshotUnchanged(run.checkpoint, parsedSnapshot.data);
        if (!comparison.ok) {
           this.db.run("UPDATE runs SET status='BLOCKED',row_version=row_version+1,updated_at=? WHERE run_id=?", now, run.runId);
          this.db.run("UPDATE goals SET blocker_code=?,blocker=?,updated_at=? WHERE goal_id=?", comparison.code === "head-changed" ? "workspace-head-changed" : comparison.code === "attribution-incomplete" ? "workspace-comparison-invalid" : "workspace-concurrent-changes", comparison.detail, now, goalId);
          this.setState(goalId, "BLOCKED", now);
          this.audit(goalId, "workspace_conflict_detected", this.instanceId, { code: comparison.code, detail: comparison.detail }, goal.state, "BLOCKED", now);
          return { ok: false as const, error: comparison.code === "head-changed" ? "workspace-head-changed" : comparison.code === "attribution-incomplete" ? "workspace-comparison-invalid" : "workspace-concurrent-changes" };
        }
      }
      if (!goal.approvedRevisionHash || goal.approvedRevisionHash !== run.approvedRevisionHash) return { ok: false as const, error: "approved-revision-mismatch" };
       const dispatchId = this.ids.next(); const messageId = openCodeMessageId(this.ids.next());
       const nextBatch = run.verificationAttempts >= run.verificationBatch * DEFAULT_MAX_VERIFICATION_ATTEMPTS ? run.verificationBatch + 1 : run.verificationBatch;
       const payload = { kind: "executor-resume", attempt: run.verificationAttempts, batch: nextBatch, round: nextBatch > run.verificationBatch ? 1 : (run.verificationAttempts % DEFAULT_MAX_VERIFICATION_ATTEMPTS) + 1 };
        this.db.run("UPDATE runs SET status='ACTIVE',verification_batch=?,row_version=row_version+1,updated_at=? WHERE run_id=?", nextBatch, now, run.runId);
      this.db.run("UPDATE goals SET blocker_code=NULL,blocker=NULL,updated_at=? WHERE goal_id=?", now, goalId);
      this.setState(goalId, "ACTIVE", now);
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", dispatchId, goalId, run.runId, run.approvalAttemptId, run.revision, run.approvedRevisionHash, "executor-resume", "executor", null, run.executorSessionId, run.workspacePath, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, now, now);
      this.audit(goalId, "dispatch_pending", this.instanceId, { dispatchId, kind: "executor-resume" }, undefined, undefined, now);
      this.audit(goalId, "goal_resumed", this.instanceId, { dispatchId }, goal.state, "ACTIVE", now);
      return { ok: true as const, dispatchId, messageId };
    }).immediate();
  }

  requestPreparationRetry(goalId: string, fencingToken: number, runId: string): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); const run = this.getRun(goalId);
       if (!goal || goal.state !== "BLOCKED" || !run || run.runId !== runId || run.status !== "BLOCKED") return { ok: false as const, error: "run-workspace-missing" };
      this.db.run("UPDATE runs SET preparation_retry_requested=1,row_version=row_version+1,updated_at=? WHERE run_id=?", this.clock.now().toISOString(), run.runId);
      this.audit(goalId, "run_preparation_retry_requested", this.instanceId, { runId }, "BLOCKED", "BLOCKED", this.clock.now().toISOString());
      return { ok: true as const };
    }).immediate();
  }

  reviseGoal(goalId: string, fencingToken: number, change: string): Result {
    return this.control(goalId, fencingToken, "FORMING", "revision_requested", { change }, (now) => {
      this.revokeGoalSessions(goalId, now);
      this.db.run("UPDATE goals SET formation_request=?,blocker_code=NULL,blocker=NULL,approved_revision_hash=NULL,current_run_id=NULL,updated_at=? WHERE goal_id=?", change, now, goalId);
       this.db.run("UPDATE approval_attempts SET status='INVALIDATED',resolved_at=? WHERE goal_id=? AND status='PENDING'", now, goalId);
      this.supersedeDispatches(goalId, null, "revision-requested", now);
        this.db.run("UPDATE runs SET status='CANCELLED',row_version=row_version+1,updated_at=? WHERE goal_id=? AND status IN ('PREPARING','ACTIVE','FINALIZING','VERIFYING','PAUSED','BLOCKED')", now, goalId);
    });
  }

  cancelGoal(goalId: string, fencingToken: number): Result {
     return this.control(goalId, fencingToken, "CANCELLED", "goal_cancelled", {}, (now) => {
       this.revokeGoalSessions(goalId, now);
       this.db.run("UPDATE approval_attempts SET status='INVALIDATED',resolved_at=? WHERE goal_id=? AND status='PENDING'", now, goalId);
      this.supersedeDispatches(goalId, null, "goal-cancelled", now);
        this.db.run("UPDATE runs SET status='CANCELLED',row_version=row_version+1,updated_at=? WHERE goal_id=? AND status IN ('PREPARING','ACTIVE','FINALIZING','VERIFYING','PAUSED','BLOCKED')", now, goalId);
    });
  }

  blockGoal(goalId: string, fencingToken: number, code: BlockerCode, reason: string, expected: { state: GoalState; runId?: string }): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId);
      if (!goal || goal.state !== expected.state) return { ok: false as const, error: "stale-block" };
      const run = expected.runId ? this.getRunById(expected.runId) : undefined;
      if (expected.runId && (!run || run.goalId !== goalId)) return { ok: false as const, error: "stale-block" };
      const now = this.clock.now().toISOString();
      const safeReason = diagnosticReason(reason);
      this.db.run("UPDATE goals SET blocker_code=?,blocker=?,updated_at=? WHERE goal_id=?", code, safeReason, now, goalId);
      if (run) {
         this.db.run("UPDATE runs SET status='BLOCKED',row_version=row_version+1,updated_at=? WHERE run_id=?", now, run.runId);
         if (expected.state === "VERIFYING") {
           // A blocked verification must not leave a result permanently
           // pending. Resume starts a fresh attempt after the user acts.
           this.db.run("UPDATE verification_results SET outcome='BLOCKED',findings_json='[]',finalized_at=? WHERE run_id=? AND outcome='PENDING'", now, run.runId);
           this.revokeGoalSessions(goalId, now);
         }
        this.supersedeDispatches(goalId, run.runId, "goal-blocked", now);
      } else {
        this.supersedeDispatches(goalId, null, "goal-blocked", now);
      }
      this.setState(goalId, "BLOCKED", now);
      this.audit(goalId, "goal_blocked", this.instanceId, { code, reason, runId: run?.runId ?? null }, expected.state, "BLOCKED", now);
      return { ok: true as const };
    }).immediate();
  }

  failVerifierDelivery(goalId: string, fencingToken: number, dispatchId: string, reason: string): Result & { dispatchId?: string; messageId?: string } {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const dispatch = this.getDispatch(dispatchId);
      const goal = this.getGoal(goalId);
      const run = dispatch?.runId ? this.getRunById(dispatch.runId) : undefined;
      if (!dispatch || dispatch.role !== "verifier" || !run || !goal || goal.state !== "VERIFYING" || run.status !== "VERIFYING") return { ok: false as const, error: "stale-verifier-delivery" };
      const result = this.db.queryOne<{ result_id: string; attempt: number }>("SELECT result_id,attempt FROM verification_results WHERE dispatch_id=? AND outcome='PENDING'", dispatchId);
      if (!result) return { ok: true as const };
      const now = this.clock.now().toISOString();
      const safeReason = diagnosticReason(reason);
      this.db.run("UPDATE verification_results SET outcome='ERROR',findings_json='[]',finalized_at=? WHERE result_id=? AND outcome='PENDING'", now, result.result_id);
      this.db.run("UPDATE dispatches SET status='FAILED',failure_reason=?,updated_at=? WHERE dispatch_id=? AND status IN ('PENDING','SENT','STARTED')", safeReason, now, dispatchId);
       if (result.attempt >= run.verificationBatch * DEFAULT_MAX_VERIFICATION_ATTEMPTS) {
         this.db.run("UPDATE runs SET status='BLOCKED',row_version=row_version+1,updated_at=? WHERE run_id=?", now, run.runId);
         this.db.run("UPDATE goals SET blocker_code='verification-budget-exhausted',blocker=?,updated_at=? WHERE goal_id=?", "Verification delivery failed on the final round of the batch.", now, goalId);
         this.setState(goalId, "BLOCKED", now);
         this.revokeGoalSessions(goalId, now);
         this.audit(goalId, "verifier_delivery_failed", this.instanceId, { dispatchId, reason: safeReason }, "VERIFYING", "BLOCKED", now);
         return { ok: true as const };
       }
       const remediationDispatchId = this.ids.next();
       const messageId = openCodeMessageId(this.ids.next());
       const payload = { kind: "executor-remediation", attempt: result.attempt, reason: safeReason, findings: [] };
       this.db.run("UPDATE runs SET status='ACTIVE',row_version=row_version+1,updated_at=? WHERE run_id=?", now, run.runId);
       this.db.run("UPDATE goals SET blocker_code=NULL,blocker=NULL,updated_at=? WHERE goal_id=?", now, goalId);
       this.setState(goalId, "ACTIVE", now);
       this.db.run("INSERT INTO dispatches(dispatch_id,goal_id,run_id,approval_attempt_id,revision,contract_hash,kind,role,verification_attempt,target_session_id,directory,message_id,payload_json,prompt_hash,status,failure_reason,row_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", remediationDispatchId, goalId, run.runId, run.approvalAttemptId, run.revision, run.approvedRevisionHash, "executor-remediation", "executor", null, run.executorSessionId, run.workspacePath, messageId, JSON.stringify(payload), canonicalHash(payload), "PENDING", null, 0, now, now);
       if (dispatch.targetSessionId) this.revokeSession(dispatch.targetSessionId, now);
      this.audit(goalId, "verifier_delivery_failed", this.instanceId, { dispatchId, reason: safeReason, remediationDispatchId }, "VERIFYING", "ACTIVE", now);
      return { ok: true as const, dispatchId: remediationDispatchId, messageId };
    }).immediate();
  }

  validateDispatchForDelivery(dispatchId: string, fencingToken: number): { ok: true; dispatch: DispatchView } | { ok: false; error: string } {
    const dispatch = this.getDispatch(dispatchId); if (!dispatch) return { ok: false, error: "dispatch-not-found" };
    return this.db.transaction(() => {
      if (!this.checkFence(dispatch.goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const current = this.getDispatch(dispatchId); const goal = this.getGoal(dispatch.goalId);
       if (!current || !goal || !["PENDING", "SENT"].includes(current.status) || !current.targetSessionId || !current.directory) return { ok: false as const, error: "dispatch-not-deliverable" };
      if (canonicalHash(current.payload) !== current.promptHash) return { ok: false as const, error: "dispatch-payload-tampered" };
      if (current.role === "formulator") {
        const attempt = this.getLiveApproval(current.goalId);
        return goal.state === "AWAITING_APPROVAL" && current.runId === null && current.kind === "approval-reissue" && attempt?.attemptId === current.approvalAttemptId && attempt.revision === current.revision && attempt.contractHash === current.contractHash && attempt.rootSessionId === current.targetSessionId && goal.projectDirectory === current.directory
          ? { ok: true as const, dispatch: current }
          : { ok: false as const, error: "dispatch-not-deliverable" };
      }
      const run = this.getRun(current.goalId);
      if (current.role === "verifier") {
        const result = this.db.queryOne("SELECT outcome FROM verification_results WHERE run_id=? AND attempt=? AND verifier_session_id=?", current.runId ?? "", current.verificationAttempt ?? 0, current.targetSessionId);
         return goal.state === "VERIFYING" && !!current.runId && !!run && run.runId === current.runId && run.status === "VERIFYING" && run.revision === current.revision && run.approvedRevisionHash === current.contractHash && run.workspacePath === current.directory && current.targetSessionId !== null && !!result
          ? { ok: true as const, dispatch: current }
          : { ok: false as const, error: "dispatch-not-deliverable" };
      }
      if (current.role === "executor") {
         return goal.state === "ACTIVE" && !!current.runId && !!run && run.runId === current.runId && run.status === "ACTIVE" && run.revision === current.revision && run.approvedRevisionHash === current.contractHash && run.workspacePath === current.directory && run.executorSessionId === current.targetSessionId
          ? { ok: true as const, dispatch: current }
          : { ok: false as const, error: "dispatch-not-deliverable" };
      }
      return { ok: false as const, error: "dispatch-not-deliverable" };
    }).immediate();
  }

  markDispatchSent(dispatchId: string, fencingToken: number, expectedTargetSessionId?: string): Result { return this.dispatchStatus(dispatchId, "SENT", undefined, fencingToken, expectedTargetSessionId); }
  markDispatchFailed(dispatchId: string, fencingToken: number, reason: string): Result { return this.dispatchStatus(dispatchId, "FAILED", reason, fencingToken); }
  markDispatchStarted(dispatchId: string, fencingToken: number): Result { return this.dispatchStatus(dispatchId, "STARTED", undefined, fencingToken); }
  markDispatchCompleted(dispatchId: string, fencingToken: number): Result { return this.dispatchStatus(dispatchId, "COMPLETED", undefined, fencingToken); }

  renewOwnedLeases(): void {
    const rows = this.db.query<{ goal_id: string; fencing_token: number }>("SELECT goal_id,fencing_token FROM leases WHERE holder_instance_id=?", this.instanceId);
    for (const row of rows) this.renewLease(row.goal_id, row.fencing_token);
  }

  releaseOwnedLeases(): void {
    const rows = this.db.query<{ goal_id: string; fencing_token: number }>("SELECT goal_id,fencing_token FROM leases WHERE holder_instance_id=?", this.instanceId);
    for (const row of rows) this.releaseLease(row.goal_id, row.fencing_token);
  }

  private control(goalId: string, fencingToken: number, next: GoalState, kind: string, payload: Record<string, unknown> = {}, mutate?: (now: string) => void): Result {
    return this.db.transaction(() => {
      if (!this.checkFence(goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const goal = this.getGoal(goalId); if (!goal) return { ok: false as const, error: "goal-not-found" };
      if (!((next === "FORMING" && ["AWAITING_APPROVAL", "ACTIVE", "VERIFYING", "PAUSED", "BLOCKED"].includes(goal.state)) || (next === "CANCELLED" && !isTerminal(goal.state)))) return { ok: false as const, error: "invalid-transition" };
      const now = this.clock.now().toISOString();
      this.setState(goalId, next, now); mutate?.(now); this.audit(goalId, kind, this.instanceId, payload, goal.state, next, now);
      if (isTerminal(next)) this.db.run("UPDATE leases SET holder_instance_id=NULL,expires_at=NULL WHERE goal_id=? AND fencing_token=? AND holder_instance_id=?", goalId, fencingToken, this.instanceId);
      return { ok: true as const };
    }).immediate();
  }

  private bindSession(sessionId: string, goalId: string, runId: string, role: "executor" | "verifier", now: string): boolean {
    const existing = this.db.queryOne<{ goal_id: string; run_id: string; role: string; status: string }>("SELECT goal_id,run_id,role,status FROM session_bindings WHERE session_id=?", sessionId);
    if (existing) {
      return existing.goal_id === goalId && existing.run_id === runId && existing.role === role && existing.status === "ACTIVE";
    }
    this.db.run("INSERT INTO session_bindings(session_id,goal_id,run_id,role,status,created_at,revoked_at) VALUES(?,?,?,?,?,?,?)", sessionId, goalId, runId, role, "ACTIVE", now, null);
    return true;
  }

  private revokeSession(sessionId: string, now: string): void {
    this.db.run("UPDATE session_bindings SET status='REVOKED',revoked_at=? WHERE session_id=? AND status='ACTIVE'", now, sessionId);
  }

  private revokeGoalSessions(goalId: string, now: string): void {
    this.db.run("UPDATE session_bindings SET status='REVOKED',revoked_at=? WHERE goal_id=? AND status='ACTIVE'", now, goalId);
  }

  private dispatchStatus(dispatchId: string, status: "SENT" | "STARTED" | "COMPLETED" | "FAILED", failureReason: string | undefined, fencingToken: number, expectedTargetSessionId?: string): Result {
    const dispatch = this.getDispatch(dispatchId); if (!dispatch) return { ok: false, error: "dispatch-not-found" };
    const now = this.clock.now().toISOString();
    const result = this.db.transaction(() => {
      if (!this.checkFence(dispatch.goalId, fencingToken)) return { ok: false as const, error: "stale-lease" };
      const current = this.getDispatch(dispatchId); if (!current) return { ok: false as const, error: "dispatch-not-found" };
      if (expectedTargetSessionId !== undefined && current.targetSessionId !== expectedTargetSessionId) return { ok: false as const, error: "dispatch-target-changed" };
      if (current.status === status) return { ok: true as const };
       if (status === "SENT" && (current.status === "STARTED" || current.status === "COMPLETED")) return { ok: true as const };
       const legal = (current.status === "PENDING" && (status === "SENT" || status === "STARTED" || status === "COMPLETED" || status === "FAILED")) || (current.status === "SENT" && (status === "STARTED" || status === "COMPLETED" || status === "FAILED")) || (current.status === "STARTED" && (status === "COMPLETED" || status === "FAILED"));
      if (!legal) return { ok: false as const, error: "invalid-dispatch-transition" };
       if (status === "FAILED" && !failureReason?.trim()) return { ok: false as const, error: "dispatch-failure-reason-required" };
       this.db.run("UPDATE dispatches SET status=?,failure_reason=?,row_version=row_version+1,updated_at=? WHERE dispatch_id=? AND status=?", status, status === "FAILED" ? diagnosticReason(failureReason ?? "dispatch-failed") : null, now, dispatchId, current.status);
      if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) return { ok: false as const, error: "dispatch-race" };
      this.audit(dispatch.goalId, `dispatch_${status}`, this.instanceId, { dispatchId, reason: failureReason ?? null }, undefined, undefined, now);
      return { ok: true as const };
    });
    return result.immediate();
  }

  private supersedeDispatches(goalId: string, runId: string | null, reason: string, now: string): void {
    if (runId) this.db.run("UPDATE dispatches SET status='SUPERSEDED',failure_reason=?,row_version=row_version+1,updated_at=? WHERE run_id=? AND status IN ('PENDING','SENT','STARTED')", reason, now, runId);
    else this.db.run("UPDATE dispatches SET status='SUPERSEDED',failure_reason=?,row_version=row_version+1,updated_at=? WHERE goal_id=? AND status IN ('PENDING','SENT','STARTED')", reason, now, goalId);
  }

  private reissueQuestion(canonical: unknown, generation: number): NativeApprovalQuestion {
    const value = canonical as { value?: unknown } | unknown;
    const parsed = NativeApprovalQuestionSchema.safeParse(typeof value === "object" && value !== null && "value" in (value as Record<string, unknown>) ? (value as { value: unknown }).value : value);
    const currentQuestion = parsed.success ? parsed.data : NativeApprovalQuestionSchema.parse(canonical);
    const summary = currentQuestion.questions[0].question
      .replace(/\n\nApprove this exact Goal Contract and start execution\?\n\nApproval request generation \d+\.?$/, "")
      .replace(/\n\nApproval request generation \d+\.?$/, "")
      .trim();
    return createApprovalQuestion(summary, generation);
  }

  private requireLease(goalId: string): { ok: true; fencingToken: number } | { ok: false; error: string } {
    const row = this.db.queryOne<Lease>("SELECT fencing_token,holder_instance_id,expires_at FROM leases WHERE goal_id=?", goalId);
    if (!row || row.holder_instance_id !== this.instanceId || !row.expires_at || Date.parse(row.expires_at) <= this.clock.now().getTime()) return { ok: false, error: "stale-lease" };
    return { ok: true, fencingToken: row.fencing_token };
  }

  private checkFence(goalId: string, token: number): boolean {
    const row = this.db.queryOne<Lease>("SELECT fencing_token,holder_instance_id,expires_at FROM leases WHERE goal_id=?", goalId);
    return !!row && row.fencing_token === token && row.holder_instance_id === this.instanceId && !!row.expires_at && Date.parse(row.expires_at) > this.clock.now().getTime();
  }

  private setState(goalId: string, next: GoalState, now: string): void {
    const current = this.getGoal(goalId); if (!current) throw new Error("goal-not-found");
    assertTransition(current.state, next);
    this.db.run("UPDATE goals SET state=?,state_version=state_version+1,updated_at=? WHERE goal_id=? AND state=?", next, now, goalId, current.state);
    if ((this.db.queryOne<{ count: number }>("SELECT changes() AS count")?.count ?? 0) !== 1) throw new Error("goal-state-race");
  }

  private audit(goalId: string, kind: string, actor: string, payload: unknown, previousState: string | undefined, nextState: string | undefined, now: string, sourceEventId?: string | null, fencingToken?: number): void {
    const sequence = (this.db.queryOne<{ seq: number }>("SELECT COALESCE(MAX(goal_sequence),0)+1 AS seq FROM audit_events WHERE goal_id=?", goalId)?.seq ?? 1);
    this.db.run("INSERT INTO audit_events(event_id,goal_id,goal_sequence,kind,actor,payload_json,previous_state,next_state,source_event_id,fencing_token,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", this.ids.next(), goalId, sequence, kind, actor, JSON.stringify(redact(payload)), previousState ?? null, nextState ?? null, sourceEventId ?? null, fencingToken ?? null, now);
  }

  private readRevision(row: Record<string, unknown>): RevisionView {
    const body = ContractBodySchema.parse(JSON.parse(String(row.body_json)));
     const criteria = this.getCriteria(String(row.goal_id), Number(row.revision)).map(({ id, priority, description, verification }) => ({ id, priority, description, verification }));
    const hash = String(row.hash);
    if (computeRevisionHash(body, criteria) !== hash) throw new Error("contract-revision-integrity-failed");
    return { goalId: String(row.goal_id), revision: Number(row.revision), body, criteria: z.array(AcceptanceCriterionSchema).parse(criteria), hash, createdAt: String(row.created_at) };
  }

  private workspaceForRevision(goalId: string, revision: number): "current" | "worktree" {
    const row = this.db.queryOne<{ body_json: string }>("SELECT body_json FROM contract_revisions WHERE goal_id=? AND revision=?", goalId, revision);
    if (!row) throw new Error("revision-not-found");
    return ContractBodySchema.parse(JSON.parse(String(row.body_json))).workspace;
  }
}

function toGoal(row: Record<string, unknown>): GoalView {
  const providerID = row.model_provider_id === null ? undefined : String(row.model_provider_id);
  const modelID = row.model_id === null ? undefined : String(row.model_id);
  return {
    goalId: String(row.goal_id),
    projectId: String(row.project_id),
    rootSessionId: String(row.root_session_id),
    rootWorkspaceId: row.root_workspace_id === null ? null : String(row.root_workspace_id),
    projectDirectory: String(row.project_directory),
    worktreeOrigin: String(row.worktree_origin),
    sourceRequest: String(row.source_request),
    formationRequest: row.formation_request === null ? null : String(row.formation_request),
    model: providerID && modelID ? { providerID, id: modelID, ...(row.model_variant === null ? {} : { variant: String(row.model_variant) }) } : null,
    state: row.state as GoalState,
    currentRevision: row.current_revision === null ? null : Number(row.current_revision),
    approvedRevisionHash: row.approved_revision_hash === null ? null : String(row.approved_revision_hash),
    currentRunId: row.current_run_id === null ? null : String(row.current_run_id),
    blockerCode: row.blocker_code === null ? null : row.blocker_code as BlockerCode,
    blocker: row.blocker === null ? null : String(row.blocker),
    stateVersion: Number(row.state_version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function toRun(row: Record<string, unknown>): RunView {
  const providerID = row.model_provider_id === null ? undefined : String(row.model_provider_id);
  const modelID = row.model_id === null ? undefined : String(row.model_id);
  return {
    runId: String(row.run_id),
    goalId: String(row.goal_id),
    approvalAttemptId: String(row.approval_attempt_id),
    revision: Number(row.revision),
    approvedRevisionHash: String(row.approved_revision_hash),
    workspaceStrategy: row.workspace_strategy as "current" | "worktree",
    worktreeName: row.worktree_name === null ? null : String(row.worktree_name),
    workspacePath: row.workspace_path === null ? null : String(row.workspace_path),
    baseline: row.baseline_json === null ? null : WorkspaceSnapshotSchema.parse(JSON.parse(String(row.baseline_json))),
    checkpoint: row.checkpoint_json === null ? null : WorkspaceSnapshotSchema.parse(JSON.parse(String(row.checkpoint_json))),
    finalSnapshot: row.final_snapshot_json === null ? null : WorkspaceSnapshotSchema.parse(JSON.parse(String(row.final_snapshot_json))),
    executorDiff: row.executor_diff_json === null ? null : z.array(CanonicalDiffEntrySchema).parse(JSON.parse(String(row.executor_diff_json))),
    executorSessionId: row.executor_session_id === null ? null : String(row.executor_session_id),
    executorSessionKey: String(row.executor_session_key),
    executorProjectId: row.executor_project_id === null ? null : String(row.executor_project_id),
    executorWorkspaceId: row.executor_workspace_id === null ? null : String(row.executor_workspace_id),
    model: providerID && modelID ? { providerID, id: modelID, ...(row.model_variant === null ? {} : { variant: String(row.model_variant) }) } : null,
    status: row.status as RunStatus,
    verificationAttempts: Number(row.verification_attempts),
     verificationBatch: Number(row.verification_batch ?? 1),
    preparationRetryRequested: Number(row.preparation_retry_requested ?? 0) === 1,
    rowVersion: Number(row.row_version),
  };
}

function toDispatch(row: Record<string, unknown>): DispatchView {
  return {
    dispatchId: String(row.dispatch_id),
    goalId: String(row.goal_id),
    runId: row.run_id === null ? null : String(row.run_id),
    approvalAttemptId: String(row.approval_attempt_id),
    revision: Number(row.revision),
    contractHash: String(row.contract_hash),
    kind: row.kind as DispatchView["kind"],
    role: row.role as DispatchView["role"],
    verificationAttempt: row.verification_attempt === null ? null : Number(row.verification_attempt),
    targetSessionId: row.target_session_id === null ? null : String(row.target_session_id),
    directory: row.directory === null ? null : String(row.directory),
    messageId: String(row.message_id),
    payload: JSON.parse(String(row.payload_json)),
    promptHash: String(row.prompt_hash),
    status: row.status as DispatchView["status"],
    rowVersion: Number(row.row_version),
  };
}

function toVerificationResult(row: Record<string, unknown>): VerificationResultView {
  return {
    attempt: Number(row.attempt),
    verifierSessionId: row.verifier_session_id === null ? null : String(row.verifier_session_id),
    verifierSessionKey: row.verifier_session_key === null ? null : String(row.verifier_session_key),
    findings: z.array(VerificationFindingSchema).parse(JSON.parse(String(row.findings_json))),
     outcome: row.outcome as VerificationResultView["outcome"],
    createdAt: String(row.created_at),
    finalizedAt: row.finalized_at === null ? null : String(row.finalized_at),
  };
}

function toApprovalAttempt(row: Record<string, unknown>, now: Date): ApprovalAttemptView {
  return {
    attemptId: String(row.attempt_id),
    goalId: String(row.goal_id),
    generation: Number(row.generation),
    predecessorAttemptId: row.predecessor_attempt_id === null ? null : String(row.predecessor_attempt_id),
    revision: Number(row.revision),
    contractHash: String(row.contract_hash),
    rootSessionId: String(row.root_session_id),
    nativeRequestId: row.native_request_id === null ? null : String(row.native_request_id),
    callId: row.call_id === null ? null : String(row.call_id),
    nativeQuestionJson: String(row.native_question_json),
    status: row.status as ApprovalAttemptView["status"],
    expiresAt: String(row.expires_at),
    expired: Date.parse(String(row.expires_at)) <= now.getTime(),
    createdAt: String(row.created_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
    preflight: row.preflight_snapshot_json === null ? null : JSON.parse(String(row.preflight_snapshot_json)) as { head: string; clean: boolean },
  };
}

export function persistedPath(path: string): string {
  const value = normalize(resolve(path));
  const root = parse(value).root;
  const trimmed = value === root ? value : value.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? trimmed.toLowerCase() : trimmed;
}

function diagnosticReason(reason: string): string {
  return reason.trim().slice(0, 20_000) || "unknown-reason";
}
