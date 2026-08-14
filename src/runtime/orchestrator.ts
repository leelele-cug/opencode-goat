import type { QuestionPort, SessionIdentity, SessionModel, SessionPort, ToastPort, ToolCallContext, WorkspacePort } from "../core/ports.js";
import { classifyExternalError } from "../core/ports.js";
import { canonicalJson } from "../core/canonical.js";
import { NativeApprovalQuestionSchema } from "../core/question.js";
import { isApprovedVerificationCommand } from "../core/contract.js";
import { DEFAULT_MAX_VERIFICATION_ATTEMPTS, type GoalState } from "../core/state.js";
import { ROLE_CAPABILITIES, type GoatRole, guardGenericTool, isRegisteredGoatTool, roleForAgent, sessionDenyRules, validateGoatToolAccess } from "../core/role-capabilities.js";
import { addedPatchContentHash, assertExecutorOwnsSnapshot, assertSnapshotUnchanged, canonicalizeExecutorDiff, isWorkspaceClean, normalizeWorkspacePath, validateWorkspaceToolArguments, type CanonicalDiffEntry, type WorkspaceSnapshot } from "../core/workspace.js";
import type { BlockerCode } from "../core/errors.js";
import type { Store, GoalView, RunView, DispatchView, ApprovalAttemptView, SessionBinding } from "../store/store.js";
import { persistedPath } from "../store/store.js";
import type { GoalOrigin } from "./process-context.js";

type Platform = "win32" | "darwin" | "linux";
type Result = { ok: true } | { ok: false; error: string };
type PromptDelivery = { ok: true } | { ok: false; error: string };

export type StatusReadModel = {
  goal: GoalView;
  revision: ReturnType<Store["getRevision"]>;
  run: RunView | null;
  evidence: ReturnType<Store["getEvidence"]>;
  results: ReturnType<Store["getVerificationResults"]>;
  audit: ReturnType<Store["getRecentAudit"]>;
  attempt: ApprovalAttemptView | null;
};

export class Orchestrator {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: Store,
    private readonly session: SessionPort,
    private readonly workspace: WorkspacePort,
    private readonly question: QuestionPort,
    private readonly projectId: string,
    private readonly toast: ToastPort | undefined,
    private readonly platform: Platform = process.platform === "win32" || process.platform === "darwin" || process.platform === "linux" ? process.platform : "linux",
  ) {}

  // ---------------------------------------------------------------- queueing

  private enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    return current.finally(() => {
      if (this.queues.get(key) === current) this.queues.delete(key);
    });
  }

  private forGoal<T>(goalId: string, operation: () => Promise<T>): Promise<T> {
    return this.enqueue(goalId, operation);
  }

  private async withToken(goalId: string): Promise<{ ok: true; token: number } | { ok: false; error: string }> {
    const goal = this.store.getGoal(goalId);
    if (!goal || goal.projectId !== this.projectId) return { ok: false, error: "project-context-mismatch" };
    const token = this.store.getOwnedFencingToken(goalId);
    if (token === undefined) {
      const acquired = this.store.acquireLease(goalId);
      if (!acquired.ok) return { ok: false, error: "stale-lease" };
      return { ok: true, token: acquired.fencingToken };
    }
    return { ok: true, token };
  }

  // ---------------------------------------------------------------- commands

  createGoal(input: { sourceRequest: string; rootSessionId: string; origin: GoalOrigin; model?: SessionModel }): Promise<{ ok: true; goalId: string } | { ok: false; error: string }> {
    return this.enqueue(`create:${this.projectId}:${input.rootSessionId}`, async () => {
      if (input.origin.projectId !== this.projectId) return { ok: false, error: "project-context-mismatch" };
      let model = input.model;
      if (!model) {
        try {
          const root = await this.session.get(input.rootSessionId, input.origin.projectDirectory);
          if (root.parentID || root.projectID !== this.projectId || !samePath(root.directory, input.origin.projectDirectory) || !root.model) return { ok: false, error: "root-session-model-missing-or-identity-invalid" };
          model = root.model;
        } catch {
          return { ok: false, error: "root-session-unavailable" };
        }
      }
      const created = this.store.createGoal(input.sourceRequest, input.rootSessionId, {
        projectId: this.projectId,
        rootWorkspaceId: input.origin.rootWorkspaceId,
        projectDirectory: input.origin.projectDirectory,
        worktreeOrigin: input.origin.worktreeOrigin,
      }, model);
      return created.ok ? created : { ok: false, error: created.error };
    });
  }

  getStatusReadModel(sessionId: string): StatusReadModel | null {
    const binding = this.getBindingForSession(sessionId);
    const goal = binding?.goal ?? this.store.getLatestGoalForRootSession(sessionId, this.projectId);
    return goal ? this.readModel(goal.goalId) : null;
  }

  getBindingForSession(sessionId: string): SessionBinding | null {
    return this.store.getSessionBindingForProject(sessionId, this.projectId) ?? null;
  }

  async getDoctorStatus(sessionId: string, origin: GoalOrigin): Promise<{ readonly schemaVersion: 8; readonly projectDirectory: string; readonly worktreeOrigin: string; readonly git: { readonly isGit: boolean; readonly isClean: boolean }; readonly binding: SessionBinding | null }> {
    if (origin.projectId !== this.projectId) throw new Error("project-context-mismatch");
    return {
      schemaVersion: 8,
      projectDirectory: origin.projectDirectory,
      worktreeOrigin: origin.worktreeOrigin,
      git: await this.workspace.probeGit(origin.projectDirectory),
      binding: this.getBindingForSession(sessionId),
    };
  }

  getEvidenceForCompaction(goalId: string, runId: string): ReturnType<Store["getEvidence"]> {
    return this.store.getEvidence(goalId, runId);
  }

  getRevisionForCompaction(goalId: string, revision: number): ReturnType<Store["getRevision"]> {
    return this.store.getRevision(goalId, revision);
  }

  private readModel(goalId: string): StatusReadModel {
    const goal = this.store.getGoal(goalId)!;
    const run = this.store.getCurrentRun(goalId);
    const revision = goal.currentRevision === null ? undefined : this.store.getRevision(goalId, goal.currentRevision);
    return {
      goal,
      revision,
      run: run ?? null,
      evidence: run ? this.store.getEvidence(goalId, run.runId) : [],
      results: run ? this.store.getVerificationResults(run.runId) : [],
      audit: this.store.getRecentAudit(goalId),
      attempt: this.store.getLiveApproval(goalId) ?? null,
    };
  }

  pause(goalId: string): Promise<Result> {
    return this.forGoal(goalId, async () => {
      const tokenResult = await this.withToken(goalId);
      if (!tokenResult.ok) return tokenResult;
      const goal = this.store.getGoal(goalId);
      const run = this.store.getRun(goalId);
       if (!goal || goal.state !== "ACTIVE" || !run || run.status !== "ACTIVE" || !run.workspacePath) return this.store.pauseGoal(goalId, tokenResult.token);
      if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
       const snapshot = await this.captureSnapshot(run.workspacePath);
       if (!snapshot.ok) return this.store.blockGoal(goalId, tokenResult.token, "workspace-comparison-invalid", snapshot.error, { state: "ACTIVE", runId: run.runId });
       const paused = this.store.pauseGoal(goalId, tokenResult.token, snapshot.snapshot);
       if (paused.ok) await this.interruptSession(run.executorSessionId, run.workspacePath);
       return paused;
    });
  }

  resume(goalId: string): Promise<Result & { delivery?: "sent" | "failed" | "uncertain" }> {
    return this.forGoal(goalId, async () => {
      const goal = this.store.getGoal(goalId);
      if (!goal) return { ok: false, error: "goal-not-found" };
      if (goal.state === "AWAITING_APPROVAL") {
         await this.reconcileApprovalNow(goalId, true);
        const reissue = this.store.listPendingDispatches(goalId).find((dispatch) => dispatch.kind === "approval-reissue" && dispatch.status === "PENDING");
        if (reissue) await this.deliverDispatch(reissue.dispatchId);
        const delivered = reissue && ["SENT", "STARTED"].includes(this.store.getDispatch(reissue.dispatchId)?.status ?? "") ? "sent" : "uncertain";
        return { ok: true, delivery: delivered };
      }
      if (goal.blockerCode === "approval-not-approved") {
        const tokenResult = await this.withToken(goalId);
        if (!tokenResult.ok) return tokenResult;
        const resumed = this.store.resumeBlockedApproval(goalId, tokenResult.token);
        if (!resumed.ok) return resumed;
        const delivery = await this.deliverDispatch(resumed.dispatchId);
        return { ok: true, delivery: delivery.ok ? "sent" : "uncertain" };
      }
      const run = this.store.getRun(goalId);
      if (!run) return { ok: false, error: "run-not-found" };
       const preparationBlockers = new Set(["workspace-preparation-failed", "workspace-head-changed", "workspace-dirty-at-activation", "workspace-comparison-invalid"]);
       if (goal.state === "BLOCKED" && run.status === "BLOCKED" && preparationBlockers.has(goal.blockerCode ?? "")) {
         const tokenResult = await this.withToken(goalId);
         if (!tokenResult.ok) return tokenResult;
         const requested = this.store.requestPreparationRetry(goalId, tokenResult.token, run.runId);
         if (!requested.ok) return requested;
         const activated = await this.activateApprovedNow(goalId);
         return { ok: true, delivery: activated.ok ? "sent" : activated.error.includes("uncertain") ? "uncertain" : "failed" };
       }
       if (!run.workspacePath || run.status === "BLOCKED" && !run.workspacePath) {
         if (goal.state === "BLOCKED" && run.status === "BLOCKED" && !run.workspacePath) {
          const tokenResult = await this.withToken(goalId);
          if (!tokenResult.ok) return tokenResult;
          const requested = this.store.requestPreparationRetry(goalId, tokenResult.token, run.runId);
          if (!requested.ok) return requested;
           const activated = await this.activateApprovedNow(goalId);
          return { ok: true, delivery: activated.ok ? "sent" : activated.error.includes("uncertain") ? "uncertain" : "failed" };
        }
        return { ok: false, error: "run-workspace-missing" };
      }
       if (run.status === "PREPARING") return { ok: false, error: "run-not-prepared" };
      const tokenResult = await this.withToken(goalId);
      if (!tokenResult.ok) return tokenResult;
      if (run.workspaceStrategy === "worktree") {
        const matches = (await this.workspace.listWorktrees(goal.projectDirectory)).filter((worktree) => worktree.name === run.worktreeName && samePath(worktree.path, run.workspacePath!));
        if (matches.length !== 1) return { ok: false, error: "resume-worktree-missing-or-changed" };
      }
      if (!(await this.workspace.probeGit(run.workspacePath)).isGit) return { ok: false, error: "resume-workspace-not-ready" };
      if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
       const snapshot = await this.captureSnapshot(run.workspacePath);
       if (!snapshot.ok) return { ok: false, error: "resume-workspace-not-validated" };
       if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
       const executorDiff = await this.captureExecutorDiff(run, snapshot.snapshot);
      const resumed = this.store.resumeAndDispatch(goalId, tokenResult.token, run.runId, snapshot.snapshot, executorDiff);
      if (!resumed.ok) return resumed;
      await this.ensureExecutorSession(goalId, run.runId);
      const delivered = await this.deliverDispatch(resumed.dispatchId);
      return { ok: true, delivery: delivered.ok ? "sent" : delivered.error === "executor-prompt-rejected" ? "failed" : "uncertain" };
    });
  }

  revise(goalId: string, change: string): Promise<Result> {
    return this.forGoal(goalId, async () => {
      const tokenResult = await this.withToken(goalId);
      if (!tokenResult.ok) return tokenResult;
      const run = this.store.getCurrentRun(goalId);
      const result = this.store.reviseGoal(goalId, tokenResult.token, change);
      if (result.ok) {
        await this.interruptRunSessions(run);
      }
      return result;
    });
  }

  cancel(goalId: string): Promise<Result> {
    return this.forGoal(goalId, async () => {
      const tokenResult = await this.withToken(goalId);
      if (!tokenResult.ok) return tokenResult;
      const run = this.store.getCurrentRun(goalId);
      const result = this.store.cancelGoal(goalId, tokenResult.token);
      if (result.ok) await this.interruptRunSessions(run);
      return result;
    });
  }

  // ---------------------------------------------------------------- tools

  readGoatState(context: ToolCallContext): Promise<string> {
    const binding = this.getBindingForSession(context.sessionID);
    if (!binding) return Promise.resolve(JSON.stringify({ status: "error", error: "goat-session-not-bound" }));
    if (binding.role === "revoked") return Promise.resolve(JSON.stringify({ status: "error", error: "stale-goat-session" }));
    const role = roleForAgent(context.agent);
    if (!role || bindingRole(binding) !== role) return Promise.resolve(JSON.stringify({ status: "error", error: "configured-goat-agent-required" }));
    const allowed = this.authorizeTool(binding, role, context);
    if (!allowed.ok) return Promise.resolve(JSON.stringify({ status: "error", error: allowed.error }));
    const projection = role === "verifier" ? this.store.getVerifierState(binding.goal.goalId) : role === "executor" ? this.store.getExecutorState(binding.goal.goalId) : this.store.getFormulatorState(binding.goal.goalId);
    return Promise.resolve(JSON.stringify(projection));
  }

  proposeContract(context: ToolCallContext, args: { outcome: string; included: string[]; excluded: string[]; constraints: string[]; assumptions: string[]; workspace: "current" | "worktree"; criteria: { id: string; priority: "must" | "should"; description: string; verification: ({ kind: "inspection"; description: string } | { kind: "command"; command: string })[] }[]; outcomeObservable: boolean; constraintsReviewed: boolean; assumptionsReviewed: boolean; outcomeChangingQuestionsResolved: boolean; workspaceAvailable: boolean; infeasibleCriterionIds: string[] }, operationKey: string): Promise<string> {
    return this.forGoal(this.goalIdFor(context), async () => {
      const binding = this.getBindingForSession(context.sessionID);
      const goalId = binding?.goal.goalId ?? "";
      if (!binding || binding.role !== "root" || roleForAgent(context.agent) !== "formulator") return JSON.stringify({ status: "error", error: "configured-goat-agent-required" });
      const access = this.authorizeTool(binding, "formulator", context);
      if (!access.ok) return JSON.stringify({ status: "error", error: access.error });
      const tokenResult = await this.withToken(goalId);
      if (!tokenResult.ok) return JSON.stringify(tokenResult);
      const preflight = await this.capturePreflight(context.directory);
      if (!preflight.ok) return JSON.stringify({ status: "error", error: preflight.error });
      if (!this.store.renewLease(goalId, tokenResult.token).ok) return JSON.stringify({ status: "error", error: "stale-lease" });
      const result = this.store.proposeContract(goalId, tokenResult.token, {
        outcome: args.outcome,
        scope: { included: args.included, excluded: args.excluded },
        constraints: args.constraints,
        assumptions: args.assumptions,
        workspace: args.workspace,
      }, args.criteria, {
        outcomeObservable: args.outcomeObservable,
        constraintsReviewed: args.constraintsReviewed,
        assumptionsReviewed: args.assumptionsReviewed,
        outcomeChangingQuestionsResolved: args.outcomeChangingQuestionsResolved,
        workspaceAvailable: args.workspaceAvailable,
        infeasibleCriterionIds: args.infeasibleCriterionIds,
      }, operationKey, preflight.preflight);
      if (!result.ok) return JSON.stringify({ status: "error", error: result.error });
      if (!result.ready) return JSON.stringify({ status: "ready-gate-blocked", dimensions: result.dimensions });
      const revision = this.store.getRevision(goalId, result.revision);
      return JSON.stringify({
        status: "awaiting-approval",
        summary: revision ? revision.body.outcome : undefined,
        question: result.nativeQuestion,
      });
    });
  }

  recordEvidence(context: ToolCallContext, args: { criterionId: string; source: string; method: string; expectedResult: string; actualReference: string }, operationKey: string): Promise<string> {
    return this.forGoal(this.goalIdFor(context), async () => {
      const authorized = this.authorizeExecution(context);
      if (!authorized.ok) return JSON.stringify({ status: "error", error: authorized.error });
      const tokenResult = await this.withToken(authorized.goal.goalId);
      if (!tokenResult.ok) return JSON.stringify({ status: "error", error: tokenResult.error });
      const result = this.store.recordEvidence(authorized.goal.goalId, tokenResult.token, authorized.run.runId, args.criterionId, { source: args.source, method: args.method, expectedResult: args.expectedResult, actualReference: args.actualReference, producer: context.sessionID }, operationKey);
      return JSON.stringify(result.ok ? { status: "recorded", evidenceId: result.evidenceId, criterionId: args.criterionId } : result);
    });
  }

  proposeCompletion(context: ToolCallContext, operationKey: string): Promise<string> {
    return this.forGoal(this.goalIdFor(context), async () => {
      const authorized = this.authorizeExecution(context);
      if (!authorized.ok) return JSON.stringify({ status: "error", error: authorized.error });
      const goalId = authorized.goal.goalId;
      const run = authorized.run;
      if (!run.workspacePath) {
        const tokenResult = await this.withToken(goalId);
        if (tokenResult.ok) this.store.blockGoal(goalId, tokenResult.token, "run-workspace-missing", "run-workspace-missing", { state: "ACTIVE", runId: run.runId });
        return JSON.stringify({ status: "error", error: "run-workspace-missing" });
      }
       const tokenResult = await this.withToken(goalId);
       if (!tokenResult.ok) return JSON.stringify({ status: "error", error: tokenResult.error });
       const finalizing = this.store.beginFinalization(goalId, tokenResult.token, run.runId);
       if (!finalizing.ok) return JSON.stringify({ status: "error", error: finalizing.error });
       let finalSnapshot;
       try {
        finalSnapshot = await this.captureSnapshot(run.workspacePath);
        if (!finalSnapshot.ok) throw new Error(finalSnapshot.error);
        if (!this.store.renewLease(goalId, tokenResult.token).ok) return JSON.stringify({ status: "error", error: "stale-lease" });
      } catch (error) {
        const reason = error instanceof Error ? `verification-context-capture-failed:${error.message}` : "verification-context-capture-failed";
        this.store.blockGoal(goalId, tokenResult.token, "workspace-comparison-invalid", reason, { state: "ACTIVE", runId: run.runId });
        return JSON.stringify({ status: "error", error: reason });
      }
        let executorDiff: readonly CanonicalDiffEntry[];
        try {
          executorDiff = await this.captureExecutorDiff(run, finalSnapshot.snapshot);
        } catch (error) {
          const reason = error instanceof Error ? `verification-context-capture-failed:${error.message}` : "verification-context-capture-failed";
          this.store.blockGoal(goalId, tokenResult.token, "workspace-comparison-invalid", reason, { state: "ACTIVE", runId: run.runId });
          return JSON.stringify({ status: "error", error: reason });
        }
       if (!this.store.renewLease(goalId, tokenResult.token).ok) return JSON.stringify({ status: "error", error: "stale-lease" });
      const proposal = this.store.proposeCompletion(goalId, tokenResult.token, run.runId, finalSnapshot.snapshot, executorDiff, operationKey);
      if (!proposal.ok) return JSON.stringify({ status: "error", error: proposal.error, gaps: proposal.gaps });
       await this.interruptSession(run.executorSessionId, run.workspacePath);
       await this.ensureVerifierSession(goalId, run.runId, proposal.dispatchId, proposal.attempt);
      await this.deliverDispatch(proposal.dispatchId);
      const dispatch = this.store.getDispatch(proposal.dispatchId);
       if (dispatch && ["SENT", "STARTED"].includes(dispatch.status)) return JSON.stringify({ status: "verification-started", attempt: proposal.attempt });
       return JSON.stringify({ status: "error", error: dispatch?.status === "FAILED" ? "verifier-prompt-rejected" : "verifier-prompt-delivery-uncertain" });
    });
  }

  block(context: ToolCallContext, reason: string): Promise<string> {
    return this.forGoal(this.goalIdFor(context), async () => {
      const authorized = this.authorizeExecution(context);
      if (!authorized.ok) return JSON.stringify({ status: "error", error: authorized.error });
      const tokenResult = await this.withToken(authorized.goal.goalId);
      if (!tokenResult.ok) return JSON.stringify({ status: "error", error: tokenResult.error });
       const result = this.store.blockGoal(authorized.goal.goalId, tokenResult.token, "executor-blocked", reason, { state: "ACTIVE", runId: authorized.run.runId });
       if (result.ok) await this.interruptRunSessions(authorized.run);
       return JSON.stringify(result);
    });
  }

  recordVerifierReport(context: ToolCallContext, findings: { criterionId: string; result: "pass" | "fail" | "blocked"; evidenceIds: string[]; note?: string | undefined }[]): Promise<string> {
    return this.forGoal(this.goalIdFor(context), async () => {
        const binding = this.getBindingForSession(context.sessionID);
        if (!binding || binding.role !== "verifier" || roleForAgent(context.agent) !== "verifier") return JSON.stringify({ status: "error", error: "configured-goat-agent-required" });
        const access = this.authorizeTool(binding, "verifier", context);
        if (!access.ok) return JSON.stringify({ status: "error", error: access.error });
       if (binding.goal.state !== "VERIFYING" || binding.run.status !== "VERIFYING" || binding.result.outcome !== "PENDING") return JSON.stringify({ status: "error", error: "stale-goat-session" });
       const tokenResult = await this.withToken(binding.goal.goalId);
       if (!tokenResult.ok) return JSON.stringify({ status: "error", error: tokenResult.error });
       if (!binding.run.finalSnapshot || !binding.run.workspacePath) return JSON.stringify({ status: "error", error: "verification-workspace-baseline-missing" });
       const observed = await this.captureSnapshot(binding.run.workspacePath);
       if (!observed.ok) {
         this.store.blockGoal(binding.goal.goalId, tokenResult.token, "workspace-changed-during-verification", observed.error, { state: "VERIFYING", runId: binding.run.runId });
         return JSON.stringify({ status: "error", error: "workspace-changed-during-verification" });
       }
       const unchanged = assertSnapshotUnchanged(binding.run.finalSnapshot, observed.snapshot);
       if (!unchanged.ok) {
         this.store.blockGoal(binding.goal.goalId, tokenResult.token, "workspace-changed-during-verification", unchanged.detail, { state: "VERIFYING", runId: binding.run.runId });
         return JSON.stringify({ status: "error", error: "workspace-changed-during-verification" });
       }
       if (!this.store.renewLease(binding.goal.goalId, tokenResult.token).ok) return JSON.stringify({ status: "error", error: "stale-lease" });
       const result = this.store.recordVerificationAndMaybeRemediate(binding.goal.goalId, tokenResult.token, binding.run.runId, context.sessionID, findings, observed.snapshot);
        if (!result.ok) {
          if (result.error === "workspace-changed-during-verification") this.store.blockGoal(binding.goal.goalId, tokenResult.token, "workspace-changed-during-verification", result.error, { state: "VERIFYING", runId: binding.run.runId });
          return JSON.stringify({ status: "error", error: result.error });
        }
        await this.interruptSession(context.sessionID, binding.run.workspacePath);
        if (result.outcome === "VERIFYING") {
         const finalCheck = await this.captureSnapshot(binding.run.workspacePath);
         if (!finalCheck.ok) {
           this.store.blockGoal(binding.goal.goalId, tokenResult.token, "workspace-changed-during-verification", finalCheck.error, { state: "VERIFYING", runId: binding.run.runId });
           return JSON.stringify({ status: "error", error: "workspace-changed-during-verification" });
         }
         const finalized = this.store.completeVerifiedRun(binding.goal.goalId, tokenResult.token, binding.run.runId, finalCheck.snapshot);
         if (!finalized.ok) return JSON.stringify({ status: "error", error: finalized.error });
         this.notify({ title: "Goat completed", message: "Independent verification passed every MUST criterion.", variant: "success" });
         return JSON.stringify({ status: "recorded", outcome: "COMPLETED", attempt: result.attempt });
       }
       if (result.outcome === "COMPLETED") {
        this.notify({ title: "Goat completed", message: "Independent verification passed every MUST criterion.", variant: "success" });
        return JSON.stringify({ status: "recorded", outcome: result.outcome, attempt: result.attempt });
      }
       if (result.outcome === "BLOCKED") {
        this.notify({ title: "Goat blocked", message: "Verification could not pass within the allowed attempts.", variant: "error" });
        return JSON.stringify({ status: "recorded", outcome: result.outcome, attempt: result.attempt });
      }
      if (!result.dispatchId || !result.messageId) return JSON.stringify({ status: "error", error: "remediation-dispatch-missing" });
      const delivered = await this.deliverDispatch(result.dispatchId);
       const batch = Math.floor((result.attempt - 1) / DEFAULT_MAX_VERIFICATION_ATTEMPTS) + 1;
       const round = ((result.attempt - 1) % DEFAULT_MAX_VERIFICATION_ATTEMPTS) + 1;
       this.notify({ title: `Verification batch ${batch}, round ${round}/${DEFAULT_MAX_VERIFICATION_ATTEMPTS} failed`, message: "Findings returned to the Executor. No changes were discarded.", variant: "warning" });
       return JSON.stringify({ status: "recorded", outcome: result.outcome, attempt: result.attempt, delivery: delivered.ok ? "sent" : delivered.error === "executor-prompt-rejected" ? "failed" : "uncertain" });
    });
  }

  // ---------------------------------------------------------------- hooks

  guardGenericToolCall(sessionID: string, toolId: string, callId: string, questionArgs?: unknown, directory?: string): Promise<{ allowed: true } | { allowed: false; error: string }> {
    const binding = this.getBindingForSession(sessionID);
    if (binding?.role === "revoked") return Promise.resolve({ allowed: false, error: "stale-goat-session" });
    if (isRegisteredGoatTool(toolId)) {
      if (!binding) return Promise.resolve({ allowed: false, error: "goat-session-not-bound" });
      if (binding.role !== "root" && !["ACTIVE", "VERIFYING", "PAUSED"].includes(binding.run.status)) return Promise.resolve({ allowed: false, error: "stale-goat-session" });
      const role = bindingRole(binding);
      const decision = validateGoatToolAccess({
        toolId,
        state: binding.goal.state,
        role,
        sessionBindingMatchesRole: true,
        leaseOwned: this.store.ownsLease(binding.goal.goalId),
        workspaceMatches: true,
      });
      return Promise.resolve(decision.allowed ? { allowed: true } : { allowed: false, error: decision.reason });
    }
    if (!binding) {
      if (isRegisteredGoatTool(toolId)) return Promise.resolve({ allowed: false, error: "unbound-goat-tool" });
      return (async () => {
        try {
          const identity = await this.session.get(sessionID, directory ?? "");
          if (identity.agent && roleForAgent(identity.agent)) return { allowed: false, error: "unbound-goat-agent" };
        } catch {
          // Unrelated Sessions are not owned by Goat. Let OpenCode handle
          // their lifecycle if identity inspection is unavailable.
        }
        return { allowed: true };
      })();
    }
    if (binding.role !== "root" && !["ACTIVE", "VERIFYING", "PAUSED"].includes(binding.run.status)) {
      return Promise.resolve({ allowed: false, error: "stale-goat-session" });
    }
    return (async () => {
      const expectedDirectory = expectedDirectoryFor(binding);
      let identity: SessionIdentity;
      try {
        identity = await this.session.get(sessionID, expectedDirectory);
      } catch {
        return { allowed: false, error: "goat-session-identity-unavailable" };
      }
      const verified = this.verifySessionIdentity(binding, identity, expectedDirectory);
      if (!verified.ok) return { allowed: false, error: verified.error };
      if (binding.role === "verifier" && toolId === "bash") {
        const command = extractBashCommand(questionArgs);
        const revision = binding.goal.currentRevision === null ? undefined : this.store.getRevision(binding.goal.goalId, binding.goal.currentRevision);
        if (!command || !revision || !isApprovedVerificationCommand(revision.criteria, command)) return { allowed: false, error: "verifier-command-not-approved" };
      }
      if (binding.role === "executor" && ["write", "edit", "apply_patch", "bash"].includes(toolId)) {
        const target = validateWorkspaceToolArguments(toolId, questionArgs, expectedDirectory, this.platform);
        if (!target.ok) return { allowed: false, error: target.error };
      }
      const guarded = guardGenericTool(binding.goal.state, bindingRole(binding), toolId);
      if (!guarded.allowed) return { allowed: false, error: guarded.reason };
      if (toolId === "question") {
        if (bindingRole(binding) !== "formulator") return { allowed: false, error: "Formulator Sessions only can ask native Questions." };
        if (binding.goal.state !== "AWAITING_APPROVAL") return { allowed: true };
        const tokenResult = await this.withToken(binding.goal.goalId);
        if (!tokenResult.ok) return { allowed: false, error: "stale-lease" };
        const bound = this.store.bindApprovalQuestion(binding.goal.goalId, tokenResult.token, callId, questionArgs);
        return bound.ok ? { allowed: true } : { allowed: false, error: "Question does not match the exact pending Contract approval." };
      }
      return { allowed: true };
    })();
  }

  handleQuestionAfter(sessionID: string, callId: string, metadata: unknown, outputText: string): Promise<void> {
    const binding = this.getBindingForSession(sessionID);
    if (!binding || binding.role !== "root") return Promise.resolve();
    const answers = extractAnswers(metadata) ?? extractAnswersFromText(outputText);
       if (!answers) return this.forGoal(binding.goal.goalId, () => this.reconcileApprovalNow(binding.goal.goalId));
    return this.forGoal(binding.goal.goalId, async () => {
      const goal = this.store.getGoal(binding.goal.goalId);
      if (!goal) return;
      const tokenResult = await this.withToken(goal.goalId);
      if (!tokenResult.ok) return;
      const resolved = this.store.resolveApproval(goal.goalId, tokenResult.token, callId, answers);
      if (!resolved.ok || resolved.action !== "approved") return;
      await this.activateApprovedNow(goal.goalId);
    });
  }

  handleQuestionRejected(sessionID: string, requestId: string): Promise<void> {
    const binding = this.getBindingForSession(sessionID);
    if (!binding || binding.role !== "root" || binding.goal.state !== "AWAITING_APPROVAL") return Promise.resolve();
    return this.forGoal(binding.goal.goalId, async () => {
      const goal = this.store.getGoal(binding.goal.goalId);
      if (!goal || goal.state !== "AWAITING_APPROVAL") return;
      const attempt = this.store.getLiveApproval(goal.goalId);
      if (!attempt || attempt.nativeRequestId !== requestId) return;
      const tokenResult = await this.withToken(goal.goalId);
      if (!tokenResult.ok) return;
      const rejected = this.store.markApprovalRejected(goal.goalId, tokenResult.token, `question.rejected:${requestId}`);
      if (rejected.ok && rejected.attemptId) {
        this.notify({ title: "Goat blocked", message: "Contract was not approved. Run /goat resume, revise, or cancel.", variant: "warning" });
      }
    });
  }

  handlePrompted(sessionID: string, messageId: string): Promise<void> {
    const dispatch = this.store.getDispatchByMessageId(messageId);
    if (!dispatch || dispatch.targetSessionId !== sessionID) return Promise.resolve();
    return this.forGoal(dispatch.goalId, async () => {
      const token = this.store.getOwnedFencingToken(dispatch.goalId);
      if (token === undefined) return;
      this.store.markDispatchStarted(dispatch.dispatchId, token);
    });
  }

  handleMessageUpdated(sessionID: string, message: unknown): Promise<void> {
    if (!message || typeof message !== "object") return Promise.resolve();
    const value = message as { id?: unknown; role?: unknown };
    if (value.role !== "user" || typeof value.id !== "string") return Promise.resolve();
    return this.handlePrompted(sessionID, value.id);
  }

  handleSessionIdle(sessionID: string): Promise<void> {
    return this.handleSessionTerminal(sessionID, "executor-session-ended", "executor-session-idle-before-completion", "verifier-session-ended");
  }

  handleSessionError(sessionID: string): Promise<void> {
    return this.handleSessionTerminal(sessionID, "session-error", "opencode-session-error", "session-error");
  }

  private handleSessionTerminal(sessionID: string, executorCode: BlockerCode, reason: string, verifierCode: BlockerCode): Promise<void> {
    const binding = this.getBindingForSession(sessionID);
    if (!binding || binding.role === "root" || binding.role === "revoked") return Promise.resolve();
    return this.forGoal(binding.goal.goalId, async () => {
      const current = this.getBindingForSession(sessionID);
      if (!current || current.role === "root" || current.role === "revoked") return;
      const activeExecutor = current.role === "executor" && current.run.status === "ACTIVE" && current.goal.state === "ACTIVE";
      const activeVerifier = current.role === "verifier" && current.run.status === "VERIFYING" && current.goal.state === "VERIFYING";
      if (!activeExecutor && !activeVerifier) return;
      const tokenResult = await this.withToken(current.goal.goalId);
      if (!tokenResult.ok) return;
      const dispatch = this.store.getDispatchForSession(sessionID);
      if (dispatch) this.store.markDispatchFailed(dispatch.dispatchId, tokenResult.token, reason);
      const code = activeExecutor ? executorCode : verifierCode;
      const expectedState = activeExecutor ? "ACTIVE" : "VERIFYING";
      this.store.blockGoal(current.goal.goalId, tokenResult.token, code, reason, { state: expectedState, runId: current.run.runId });
      this.notify({ title: "Goat blocked", message: reason, variant: "error" }, current.goal.projectDirectory);
    });
  }

  handleWorktreeReady(name: string): Promise<void> {
    const matches = this.store.listRecoverableGoalsForProject(this.projectId).filter((goal) => {
      const run = this.store.getRun(goal.goalId);
      return run?.worktreeName === name && run.status === "PREPARING" && !!run.workspacePath && !run.baseline;
    });
    const result = Promise.all(matches.map((goal) => this.forGoal(goal.goalId, () => this.continueWorktreeActivation(goal.goalId))));
    return result.then(() => undefined);
  }

  handleWorktreeFailed(): Promise<void> {
    // The native event carries no worktree name; exact failures are surfaced by
    // the create call result, stable-name reconciliation, and recovery probes.
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- activation

  activateApproved(goalId: string): Promise<Result> {
    return this.forGoal(goalId, () => this.activateApprovedNow(goalId));
  }

  private async activateApprovedNow(goalId: string): Promise<Result> {
    const tokenResult = await this.withToken(goalId);
    if (!tokenResult.ok) return tokenResult;
    const run = this.store.getRun(goalId);
    const goal = this.store.getGoal(goalId);
    if (!run || !goal || !["PREPARING", "BLOCKED"].includes(run.status)) return { ok: false, error: "run-not-prepared" };
    const attempt = this.store.getApprovalAttempt(run.approvalAttemptId);
    if (!attempt || attempt.status !== "APPROVED") return { ok: false, error: "approval-not-approved" };
    let directory = goal.projectDirectory;
    let pendingReady: (() => Promise<void>) | undefined;
    try {
      if (run.workspaceStrategy === "worktree") {
        if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
        if (!run.worktreeName) return { ok: false, error: "stable-worktree-name-missing" };
        const matches = (await this.workspace.listWorktrees(goal.projectDirectory)).filter((worktree) => worktree.name === run.worktreeName);
        if (matches.length > 1) return this.failPreparation(goalId, tokenResult.token, run.runId, "multiple-stable-worktrees", "multiple-stable-worktrees");
        if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
        if (matches[0]) {
          directory = matches[0].path;
          if (run.workspacePath && !samePath(run.workspacePath, directory)) return { ok: false, error: "stable-worktree-path-changed" };
          } else {
            const created = await this.workspace.createWorktree(goal.projectDirectory, run.worktreeName);
            directory = created.path;
             pendingReady = created.waitUntilReady;
        }
      }
      const prepared = this.store.recordWorkspacePrepared(goalId, tokenResult.token, run.runId, directory);
      if (!prepared.ok) return prepared;
      if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
      if (pendingReady) await pendingReady();
      else await this.waitForWorkspace(directory);
      if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
      const captured = await this.captureSnapshot(directory);
      if (!captured.ok) return this.failPreparation(goalId, tokenResult.token, run.runId, "workspace-comparison-invalid", captured.error);
      if (!attempt.preflight) return this.failPreparation(goalId, tokenResult.token, run.runId, "workspace-preparation-failed", "approval-preflight-missing");
      if (captured.snapshot.head !== attempt.preflight.head) return this.failPreparation(goalId, tokenResult.token, run.runId, "workspace-head-changed", "workspace-head-changed");
      if (!isWorkspaceClean(captured.snapshot)) return this.failPreparation(goalId, tokenResult.token, run.runId, "workspace-dirty-at-activation", "workspace-dirty-at-activation");
      if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
      const activated = this.store.activateRun(goalId, tokenResult.token, run.runId, captured.snapshot);
      if (!activated.ok) return activated;
      await this.ensureExecutorSession(goalId, run.runId);
      return this.deliverDispatch(activated.dispatchId);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "workspace-preparation-failed";
       const currentRun = this.store.getRun(goalId);
      if (currentRun?.status === "ACTIVE") {
        const token = this.store.getOwnedFencingToken(goalId);
        if (token !== undefined) this.store.blockGoal(goalId, token, "workspace-preparation-failed", reason, { state: "ACTIVE", runId: run.runId });
      } else {
        this.failPreparation(goalId, tokenResult.token, run.runId, "workspace-preparation-failed", reason);
      }
      this.notify({ title: "Goat blocked", message: reason, variant: "error" });
      return { ok: false, error: reason };
    }
  }

  private async continueWorktreeActivation(goalId: string): Promise<void> {
    const tokenResult = await this.withToken(goalId);
    if (!tokenResult.ok) return;
    const run = this.store.getRun(goalId);
    const goal = this.store.getGoal(goalId);
    if (!run || !goal || run.status !== "PREPARING" || !run.workspacePath || run.baseline || run.workspaceStrategy !== "worktree") return;
    await this.activateApprovedNow(goalId);
  }

  private async failPreparation(goalId: string, token: number, runId: string, code: BlockerCode, reason: string): Promise<Result> {
    const failed = this.store.failRunPreparation(goalId, token, runId, code, reason);
    if (failed.ok) this.notify({ title: "Goat blocked", message: reason, variant: "error" });
    return failed.ok ? { ok: false, error: reason } : failed;
  }

  private async waitForWorkspace(directory: string): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await this.workspace.probeGit(directory)).isGit) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("native-worktree-readiness-timeout");
  }

  // ---------------------------------------------------------------- sessions

  private async ensureExecutorSession(goalId: string, runId: string): Promise<string> {
    const goal = this.store.getGoal(goalId);
    const run = this.store.getRun(goalId);
    if (!goal || !run || run.runId !== runId || !run.workspacePath) throw new Error("executor-run-not-ready");
    const model = run.model ?? goal.model;
    if (!model) throw new Error("executor-model-pin-missing");
    if (run.executorSessionId) {
      try {
        const identity = await this.session.get(run.executorSessionId, run.workspacePath);
        const expected: SessionIdentity = {
          id: run.executorSessionId,
          title: null,
          projectID: run.executorProjectId ?? goal.projectId,
          workspaceID: run.executorWorkspaceId,
          parentID: goal.rootSessionId,
          directory: run.workspacePath,
          agent: "goat-executor",
          model,
           metadata: goatMetadata(run, "executor", goal.projectId, model),
        };
        if (!sameSessionIdentity(identity, expected)) {
          const token = this.store.getOwnedFencingToken(goalId);
          if (token !== undefined) this.store.blockGoal(goalId, token, "executor-session-mismatch", "executor session identity mismatch", { state: goal.state as GoalState, runId });
          throw new Error("executor-session-identity-mismatch");
        }
        return run.executorSessionId;
      } catch (error) {
        if (!isDefinitiveNotFound(error)) throw error;
      }
    }
    const root = await this.session.get(goal.rootSessionId, goal.projectDirectory);
    if (root.parentID) throw new Error("executor-root-session-invalid");
    const children = await this.session.children(goal.rootSessionId, run.workspacePath);
     const expectedMetadata = goatMetadata(run, "executor", goal.projectId, model);
     const matching = children.filter((child) => child.agent === "goat-executor" && child.parentID === goal.rootSessionId && goatMetadataMatches(child.metadata, expectedMetadata));
    if (matching.length > 1) {
      const token = this.store.getOwnedFencingToken(goalId);
      if (token !== undefined) this.store.blockGoal(goalId, token, "multiple-matching-executor-sessions", "multiple-matching-executor-sessions", { state: goal.state as GoalState, runId });
      throw new Error("multiple-executor-sessions");
    }
    const child = matching[0] ?? await this.session.create({
      parentID: goal.rootSessionId,
      title: "Goat Executor",
      directory: run.workspacePath,
      model,
       metadata: expectedMetadata,
      agent: "goat-executor",
      permission: sessionDenyRules("executor"),
    });
     const expectedIdentity: SessionIdentity = { id: child.id, title: child.title, projectID: goal.projectId, workspaceID: run.executorWorkspaceId, parentID: goal.rootSessionId, directory: run.workspacePath, agent: "goat-executor", model, metadata: expectedMetadata };
     if (!sameSessionIdentity(child, expectedIdentity)) throw new Error("executor-session-identity-mismatch");
    const token = this.store.getOwnedFencingToken(goalId);
    if (token === undefined) throw new Error("stale-lease");
    const identity = { projectId: goal.projectId, workspaceId: run.executorWorkspaceId };
    if (run.executorSessionId && run.executorSessionId !== child.id) {
      const replaced = this.store.replaceExecutorSession(goalId, token, runId, run.executorSessionId, child.id, identity);
      if (!replaced.ok) throw new Error(replaced.error);
    } else {
      const bound = this.store.bindExecutorSession(goalId, token, runId, child.id, identity, model);
      if (!bound.ok) throw new Error(bound.error);
    }
    return child.id;
  }

  private async ensureVerifierSession(goalId: string, runId: string, dispatchId: string, attempt: number): Promise<void> {
    const goal = this.store.getGoal(goalId);
    const run = this.store.getRun(goalId);
    const dispatch = this.store.getDispatch(dispatchId);
    if (!goal || !run || run.runId !== runId || !run.workspacePath || !dispatch || dispatch.role !== "verifier") throw new Error("verifier-dispatch-not-ready");
    const model = run.model ?? goal.model;
    if (!model) throw new Error("verifier-model-pin-missing");
    const sessionKey = `${run.executorSessionKey}:verifier:${attempt}`;
    const title = `Goat Verifier attempt ${attempt}`;
    const children = await this.session.children(goal.rootSessionId, run.workspacePath);
     const expectedMetadata = {
       goat: {
         role: "verifier",
         projectId: goal.projectId,
         goalId,
         runId,
         attempt,
         sessionKey,
         providerId: model.providerID,
         modelId: model.id,
         variant: model.variant ?? null,
       },
     };
      const previousSessionId = dispatch.targetSessionId;
      if (previousSessionId) {
        try {
          const identity = await this.session.get(previousSessionId, run.workspacePath);
          const expected: SessionIdentity = { id: previousSessionId, title: identity.title, projectID: goal.projectId, workspaceID: run.executorWorkspaceId, parentID: goal.rootSessionId, directory: run.workspacePath, agent: "goat-verifier", model, metadata: expectedMetadata };
          if (!sameSessionIdentity(identity, expected)) throw new Error("verifier-session-identity-mismatch");
          return;
        } catch (error) {
          if (!isDefinitiveNotFound(error)) throw error;
        }
      }
     const existing = children.filter((child) => child.agent === "goat-verifier" && child.parentID === goal.rootSessionId && JSON.stringify(child.metadata) === JSON.stringify(expectedMetadata));
    if (existing.length > 1) {
      const token = this.store.getOwnedFencingToken(goalId);
      if (token !== undefined) this.store.blockGoal(goalId, token, "multiple-matching-verifier-sessions", "multiple-matching-verifier-sessions", { state: "VERIFYING", runId });
      throw new Error("multiple-verifier-sessions");
    }
    const verifier = existing[0] ?? await this.session.create({
      parentID: goal.rootSessionId,
      title,
      directory: run.workspacePath,
      model,
       metadata: expectedMetadata,
      agent: "goat-verifier",
      permission: sessionDenyRules("verifier"),
    });
     const verifierIdentity: SessionIdentity = { id: verifier.id, title: verifier.title, projectID: goal.projectId, workspaceID: run.executorWorkspaceId, parentID: goal.rootSessionId, directory: run.workspacePath, agent: "goat-verifier", model, metadata: expectedMetadata };
     if (!sameSessionIdentity(verifier, verifierIdentity)) throw new Error("verifier-session-identity-mismatch");
    const token = this.store.getOwnedFencingToken(goalId);
    if (token === undefined) throw new Error("stale-lease");
     const bound = previousSessionId
       ? this.store.replaceVerifierSession(goalId, token, dispatchId, previousSessionId, verifier.id, sessionKey)
       : this.store.bindVerifierSession(goalId, token, dispatchId, verifier.id, sessionKey);
    if (!bound.ok) throw new Error(bound.error);
  }

  private verifySessionIdentity(binding: SessionBinding, identity: SessionIdentity, expectedDirectory: string): Result {
    if (identity.id !== binding.goal.rootSessionId && binding.role === "root") return { ok: false, error: "session-identity-mismatch" };
    if (identity.projectID !== binding.goal.projectId) return { ok: false, error: "session-project-mismatch" };
    if (identity.workspaceID !== binding.goal.rootWorkspaceId && binding.role === "root") return { ok: false, error: "session-workspace-mismatch" };
    if (!samePath(identity.directory, expectedDirectory)) return { ok: false, error: "session-directory-mismatch" };
    const expectedAgent = ROLE_CAPABILITIES[bindingRole(binding)].agentId;
    if (binding.role !== "root" && identity.agent !== expectedAgent) return { ok: false, error: "session-agent-mismatch" };
    if (binding.role !== "root" && identity.parentID !== binding.goal.rootSessionId) return { ok: false, error: "session-parent-mismatch" };
    const expectedModel = binding.goal.model;
    if (!expectedModel || !sameModelIdentity(identity.model, expectedModel)) return { ok: false, error: "session-model-mismatch" };
    if (binding.role === "executor") {
      if (JSON.stringify(identity.metadata) !== JSON.stringify(goatMetadata(binding.run, "executor", binding.goal.projectId, expectedModel))) return { ok: false, error: "session-metadata-mismatch" };
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------- dispatch

  private async deliverDispatch(dispatchId: string): Promise<PromptDelivery> {
    const dispatch = this.store.getDispatch(dispatchId);
    if (!dispatch) return { ok: false, error: "dispatch-not-found" };
    const goalId = dispatch.goalId;
    const tokenResult = await this.withToken(goalId);
    if (!tokenResult.ok) return tokenResult;
    if (!this.store.renewLease(goalId, tokenResult.token).ok) return { ok: false, error: "stale-lease" };
    const delivery = this.store.validateDispatchForDelivery(dispatchId, tokenResult.token);
    if (!delivery.ok) return delivery;
    const current = delivery.dispatch;
    const run = current.runId ? this.store.getRun(current.goalId) : undefined;
    const model = current.role === "formulator" ? undefined : run?.model;
    if (current.role !== "formulator" && !model) return { ok: false, error: "dispatch-model-pin-missing" };
    try {
      await this.session.promptAsync(current.targetSessionId!, {
        messageID: current.messageId,
        agent: ROLE_CAPABILITIES[current.role].agentId,
        ...(model ? { model: { providerID: model.providerID, modelID: model.id }, ...(model.variant ? { variant: model.variant } : {}) } : {}),
        directory: current.directory!,
        parts: [{ type: "text", text: buildDispatchPrompt(current) }],
      });
      const sent = this.store.markDispatchSent(current.dispatchId, tokenResult.token, current.targetSessionId ?? undefined);
      return sent.ok ? { ok: true } : sent;
    } catch (error) {
      if (classifyExternalError(error) === "rejected") {
        const reason = error instanceof Error ? error.message : "prompt-rejected";
        if (current.kind === "approval-reissue") {
          this.store.markApprovalRejected(goalId, tokenResult.token, `dispatch:${dispatchId}`);
          return { ok: false, error: "prompt-rejected" };
        }
        if (current.role === "verifier") {
          const recovered = this.store.failVerifierDelivery(goalId, tokenResult.token, dispatchId, reason);
          if (recovered.ok && recovered.dispatchId) await this.deliverDispatch(recovered.dispatchId);
          return { ok: false, error: "prompt-rejected" };
        }
        this.store.markDispatchFailed(dispatchId, tokenResult.token, reason);
         this.store.blockGoal(goalId, tokenResult.token, "executor-prompt-rejected", reason, { state: "ACTIVE", ...(current.runId ? { runId: current.runId } : {}) });
        return { ok: false, error: "prompt-rejected" };
      }
      return { ok: false, error: "prompt-delivery-uncertain" };
    }
  }

  private async reconcileMessage(dispatch: DispatchView): Promise<"exists" | "missing" | "unknown"> {
    if (!dispatch.targetSessionId || !dispatch.directory) return "missing";
    try {
      const observation = await this.session.message(dispatch.targetSessionId, dispatch.messageId, dispatch.directory);
      const verified = this.verifyPromptObservation(observation, dispatch);
      return verified ? "exists" : "unknown";
    } catch (error) {
      const kind = classifyExternalError(error);
      return kind === "not-found" ? "missing" : "unknown";
    }
  }

  private verifyPromptObservation(observation: unknown, dispatch: DispatchView): boolean {
    if (!observation || typeof observation !== "object") return false;
    const value = observation as { info?: { role?: unknown; agent?: unknown; model?: { providerID?: unknown; modelID?: unknown } }; parts?: { type?: unknown; text?: unknown }[] };
    if (value.info?.role !== "user") return false;
    const expectedAgent = ROLE_CAPABILITIES[dispatch.role].agentId;
    if (value.info.agent !== undefined && value.info.agent !== null && value.info.agent !== expectedAgent) return false;
    const expectedPrompt = buildDispatchPrompt(dispatch);
    const parts = Array.isArray(value.parts) ? value.parts : [];
    return parts.some((part) => part?.type === "text" && typeof part.text === "string" && part.text === expectedPrompt);
  }

  // ---------------------------------------------------------------- approval reconciliation

  async reconcileApproval(goalId: string): Promise<void> {
    return this.forGoal(goalId, () => this.reconcileApprovalNow(goalId));
  }

  private async reconcileApprovalNow(goalId: string, reissueBoundQuestion = false): Promise<void> {
    const attempt = this.store.getLiveApproval(goalId);
    const goal = this.store.getGoal(goalId);
    if (!attempt || !goal || goal.state !== "AWAITING_APPROVAL") return;
    const tokenResult = await this.withToken(goalId);
    if (!tokenResult.ok) return;
    let requests;
    try { requests = await this.question.list(goal.projectDirectory); } catch { return; }
    const matches = requests.filter((request) => {
      const parsed = NativeApprovalQuestionSchema.safeParse({ questions: request.questions });
      return parsed.success && request.sessionId === attempt.rootSessionId && (!attempt.callId || request.callId === attempt.callId) && canonicalJson(parsed.data) === attempt.nativeQuestionJson;
    });
    if (matches.length > 1) {
      this.store.blockGoal(goalId, tokenResult.token, "multiple-matching-approval-questions", "multiple-matching-approval-questions", { state: "AWAITING_APPROVAL" });
      return;
    }
    const live = matches[0];
    if (live?.callId) {
      const bound = this.store.bindApprovalNativeRequest(goalId, tokenResult.token, attempt.attemptId, live.id, live.callId);
         if (bound.ok && attempt.expired) {
        try { await this.question.reject(live.id, goal.projectDirectory); } catch { return; }
         const reissued = this.store.reissueApproval(goalId, tokenResult.token, "expired-native-question");
        if (!reissued.ok) return;
         await this.deliverDispatch(reissued.dispatchId);
      }
      return;
    }
     if (attempt.status === "PENDING" && attempt.expired) {
       const reissued = this.store.reissueApproval(goalId, tokenResult.token, "expired-native-question");
      if (!reissued.ok) return;
       await this.deliverDispatch(reissued.dispatchId);
      return;
    }
      if (attempt.status === "PENDING" && !attempt.expired && (!attempt.callId || reissueBoundQuestion)) {
        const reissued = this.store.reissueApproval(goalId, tokenResult.token, "missing-native-question");
      if (!reissued.ok) return;
       await this.deliverDispatch(reissued.dispatchId);
    }
  }

  // ---------------------------------------------------------------- recovery

  async recoverProject(): Promise<void> {
    for (const goal of this.store.listRecoverableGoalsForProject(this.projectId)) {
      await this.recoverGoal(goal.goalId);
    }
  }

  private recoverGoal(goalId: string): Promise<void> {
    return this.forGoal(goalId, async () => {
      const acquired = this.store.acquireLease(goalId);
      if (!acquired.ok) return;
      const goal = this.store.getGoal(goalId);
      if (!goal) return;
      try {
        if (goal.state === "AWAITING_APPROVAL") await this.reconcileApprovalNow(goalId, true);
        const run = this.store.getRun(goalId);
        if (!run) return;
        if (goal.state === "FORMING" && run.status === "CANCELLED") {
          this.store.releaseLease(goalId, acquired.fencingToken);
          return;
        }
        if (run.status === "PREPARING" && !run.baseline) {
          await this.activateApprovedNow(goalId);
          return;
        }
        if (goal.state === "BLOCKED" && run.status === "BLOCKED" && run.preparationRetryRequested) {
          await this.activateApprovedNow(goalId);
          return;
        }
        if (goal.state === "ACTIVE" && run.status === "FINALIZING") {
          if (!run.workspacePath || !run.baseline) {
            this.store.blockGoal(goalId, acquired.fencingToken, "recovery-workspace-invalid", "finalization workspace is unavailable", { state: "ACTIVE", runId: run.runId });
            return;
          }
          try {
            const captured = await this.captureSnapshot(run.workspacePath);
            if (!captured.ok) throw new Error(captured.error);
            const executorDiff = await this.captureExecutorDiff(run, captured.snapshot);
            const comparison = assertExecutorOwnsSnapshot(run.baseline, captured.snapshot, executorDiff);
            if (!comparison.ok) throw new Error(comparison.detail);
            const finalized = this.store.proposeCompletion(goalId, acquired.fencingToken, run.runId, captured.snapshot, executorDiff, `recovery-finalization:${run.runId}`);
            if (!finalized.ok) throw new Error(finalized.error);
            await this.ensureVerifierSession(goalId, run.runId, finalized.dispatchId, finalized.attempt);
            await this.deliverDispatch(finalized.dispatchId);
          } catch (error) {
            this.store.blockGoal(goalId, acquired.fencingToken, "recovery-workspace-invalid", error instanceof Error ? error.message : "finalization-recovery-failed", { state: "ACTIVE", runId: run.runId });
          }
          return;
        }
        if (["ACTIVE", "VERIFYING", "PAUSED"].includes(run.status)) {
          await this.ensureExecutorSession(goalId, run.runId);
          const refreshed = this.store.getRun(goalId) ?? run;
          const valid = await this.validateRecoveredWorkspace(goal, refreshed);
          if (!valid) return;
          if (refreshed.status === "VERIFYING" && this.store.getVerificationResults(refreshed.runId).at(-1)?.outcome === "PASS") {
            const finalCheck = await this.captureSnapshot(refreshed.workspacePath!);
            if (!finalCheck.ok) {
              this.store.blockGoal(goalId, acquired.fencingToken, "workspace-changed-during-verification", finalCheck.error, { state: "VERIFYING", runId: refreshed.runId });
              return;
            }
            this.store.completeVerifiedRun(goalId, acquired.fencingToken, refreshed.runId, finalCheck.snapshot);
            return;
          }
        }
        for (const dispatch of this.store.listPendingDispatches(goalId)) {
          if (dispatch.kind === "approval-reissue") {
            const attempt = this.store.getLiveApproval(goalId);
             if (attempt && attempt.attemptId === dispatch.approvalAttemptId && attempt.status === "PENDING") await this.deliverDispatch(dispatch.dispatchId);
            continue;
          }
           if (dispatch.role === "executor" && run.status === "PREPARING") continue;
           if (dispatch.role === "executor" && run.status === "ACTIVE") await this.ensureExecutorSession(goalId, run.runId);
           if (dispatch.role === "verifier" && run.status === "VERIFYING") await this.ensureVerifierSession(goalId, run.runId, dispatch.dispatchId, dispatch.verificationAttempt ?? 0);
          const reconciliation = await this.reconcileMessage(dispatch);
          if (reconciliation === "exists") {
            this.store.markDispatchSent(dispatch.dispatchId, acquired.fencingToken);
            continue;
          }
          if (reconciliation === "unknown") continue;
          await this.deliverDispatch(dispatch.dispatchId);
        }
      } catch (error) {
        console.error("[Goat] recovery failed for goal", goalId, ":", error instanceof Error ? error.message : String(error));
      } finally {
        const current = this.store.getGoal(goalId);
        if (current && (current.state === "COMPLETED" || current.state === "CANCELLED")) this.store.releaseLease(goalId, acquired.fencingToken);
      }
    });
  }

  private async validateRecoveredWorkspace(goal: GoalView, run: RunView): Promise<boolean> {
    if (!run.workspacePath || !run.baseline) {
      const token = this.store.getOwnedFencingToken(goal.goalId);
      if (token !== undefined) this.store.blockGoal(goal.goalId, token, "recovery-workspace-invalid", "recovery-workspace-missing", { state: goal.state as GoalState, runId: run.runId });
      return false;
    }
    try {
      if (run.workspaceStrategy === "worktree") {
        const matches = (await this.workspace.listWorktrees(goal.projectDirectory)).filter((worktree) => worktree.name === run.worktreeName && samePath(worktree.path, run.workspacePath!));
        if (matches.length !== 1) throw new Error("recovery-worktree-missing-or-changed");
      }
      if (!(await this.workspace.probeGit(run.workspacePath)).isGit) throw new Error("recovery-workspace-not-ready");
      const captured = await this.captureSnapshot(run.workspacePath);
      if (!captured.ok) throw new Error(captured.error);
       if (run.status === "PAUSED" && run.checkpoint) {
         const comparison = assertSnapshotUnchanged(run.checkpoint, captured.snapshot);
         if (!comparison.ok) throw new Error(comparison.detail);
         return true;
       }
       if (run.status === "VERIFYING" && run.finalSnapshot) {
         const comparison = assertSnapshotUnchanged(run.finalSnapshot, captured.snapshot);
         if (!comparison.ok) throw new Error(comparison.detail);
         return true;
       }
        const executorDiff = await this.captureExecutorDiff(run, captured.snapshot);
       const comparison = assertExecutorOwnsSnapshot(run.baseline, captured.snapshot, executorDiff);
      if (!comparison.ok) throw new Error(comparison.detail);
      return true;
    } catch (error) {
      const token = this.store.getOwnedFencingToken(goal.goalId);
      if (token !== undefined) this.store.blockGoal(goal.goalId, token, "recovery-workspace-invalid", error instanceof Error ? error.message : "recovery-workspace-invalid", { state: goal.state as GoalState, runId: run.runId });
      return false;
    }
  }

  // ---------------------------------------------------------------- helpers

  private goalIdFor(context: ToolCallContext): string {
    return this.getBindingForSession(context.sessionID)?.goal.goalId ?? "";
  }

  private authorizeExecution(context: ToolCallContext): { ok: true; goal: GoalView; run: RunView } | { ok: false; error: string } {
    const binding = this.getBindingForSession(context.sessionID);
     if (!binding || binding.role === "revoked") return { ok: false, error: "stale-goat-session" };
    const role = roleForAgent(context.agent);
    if (!role || bindingRole(binding) !== role) return { ok: false, error: "configured-goat-agent-required" };
    const run = binding.role === "root" ? this.store.getRun(binding.goal.goalId) : binding.run;
    if (!run) return { ok: false, error: "run-not-found" };
    if (binding.role !== "root" && !["ACTIVE", "VERIFYING", "PAUSED"].includes(run.status)) return { ok: false, error: "stale-goat-session" };
    const expectedDirectory = binding.role === "root" ? binding.goal.projectDirectory : run.workspacePath ?? binding.goal.projectDirectory;
    const expectedWorktree = binding.role === "root" ? binding.goal.worktreeOrigin : run.workspacePath ?? binding.goal.worktreeOrigin;
    const decision = validateGoatToolAccess({
      toolId: context.toolId as never,
      state: binding.goal.state,
      role,
      sessionBindingMatchesRole: true,
      leaseOwned: this.store.ownsLease(binding.goal.goalId),
      workspaceMatches: samePath(context.directory, expectedDirectory) && samePath(context.worktree, expectedWorktree),
    });
       if (!decision.allowed) return { ok: false, error: decision.reason };
       if (binding.role === "executor" && run && run.status !== "ACTIVE") return { ok: false, error: "stale-goat-session" };
       return { ok: true, goal: binding.goal, run };
  }

  private authorizeTool(binding: SessionBinding, role: GoatRole, context: ToolCallContext): Result {
    if (binding.role === "revoked") return { ok: false, error: "stale-goat-session" };
    const run = binding.role === "root" ? undefined : binding.run;
    const expectedDirectory = binding.role === "root" ? binding.goal.projectDirectory : run?.workspacePath ?? binding.goal.projectDirectory;
    const expectedWorktree = binding.role === "root" ? binding.goal.worktreeOrigin : run?.workspacePath ?? binding.goal.worktreeOrigin;
    const decision = validateGoatToolAccess({
      toolId: context.toolId as never,
      state: binding.goal.state,
      role,
      sessionBindingMatchesRole: bindingRole(binding) === role,
      leaseOwned: this.store.ownsLease(binding.goal.goalId),
      workspaceMatches: samePath(context.directory, expectedDirectory) && samePath(context.worktree, expectedWorktree),
    });
    return decision.allowed ? { ok: true } : { ok: false, error: decision.reason };
  }

  private async capturePreflight(directory: string): Promise<{ ok: true; preflight: { head: string; clean: boolean } } | { ok: false; error: string }> {
    try {
      const captured = await this.captureSnapshot(directory);
      if (!captured.ok) return { ok: false, error: captured.error };
       return { ok: true, preflight: { head: captured.snapshot.head, clean: isWorkspaceClean(captured.snapshot) } };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "workspace-preflight-failed" };
    }
  }

  private async captureSnapshot(directory: string): Promise<{ ok: true; snapshot: WorkspaceSnapshot } | { ok: false; error: string }> {
    return this.workspace.captureSnapshot(directory);
  }

  private async captureExecutorDiff(run: RunView, current?: WorkspaceSnapshot): Promise<readonly CanonicalDiffEntry[]> {
    if (!run.executorSessionId || !run.workspacePath) throw new Error("executor-session-missing");
    const raw = await this.session.diff(run.executorSessionId, run.workspacePath);
    const canonical = canonicalizeExecutorDiff(raw, this.platform);
    if (!canonical.ok) throw new Error(`executor-diff-${canonical.code}`);
    if (!current) {
      const captured = await this.captureSnapshot(run.workspacePath);
      if (!captured.ok) throw new Error(captured.error);
      current = captured.snapshot;
    }
     if (!this.session.history) return canonical.entries;
     const history = await this.session.history(run.executorSessionId, run.workspacePath);
     return attributeExecutorUntrackedChanges(canonical.entries, current, history, run.workspacePath, this.platform);
  }

  private async interruptRunSessions(run: RunView | undefined): Promise<void> {
    if (!run) return;
    const directory = run.workspacePath;
    const sessionIds = [run.executorSessionId, ...this.store.getVerificationResults(run.runId).map((result) => result.verifierSessionId)].filter((value): value is string => !!value);
    await Promise.all(sessionIds.map((sessionId) => this.interruptSession(sessionId, directory)));
  }

  private async interruptSession(sessionId: string | null, directory: string | null): Promise<void> {
    if (!sessionId || !directory) return;
    try { await this.session.interrupt(sessionId, directory); } catch { /* stale associations remain fail-closed */ }
  }

  private notify(input: { title: string; message: string; variant: "info" | "success" | "warning" | "error" }, directory?: string): void {
    void this.toast?.show({ ...input, ...(directory ? { directory } : {}) }).catch(() => undefined);
  }
}

function expectedDirectoryFor(binding: SessionBinding): string {
  if (binding.role === "root") return binding.goal.projectDirectory;
  if (binding.role === "revoked") return binding.run.workspacePath ?? binding.goal.projectDirectory;
  return binding.run.workspacePath ?? binding.goal.projectDirectory;
}

function goatMetadata(run: RunView, role: "executor", projectId: string, model: SessionModel): Record<string, unknown> {
  return {
    goat: {
      role,
      projectId,
      goalId: run.goalId,
      runId: run.runId,
      sessionKey: run.executorSessionKey,
      providerId: model.providerID,
      modelId: model.id,
      variant: model.variant ?? null,
    },
  };
}

function goatMetadataMatches(metadata: Record<string, unknown> | null, expected: Record<string, unknown>): boolean {
  return JSON.stringify(metadata) === JSON.stringify(expected);
}

function samePath(left: string, right: string): boolean {
  return persistedPath(left) === persistedPath(right);
}

function bindingRole(binding: SessionBinding): GoatRole {
  if (binding.role === "root") return "formulator";
  if (binding.role === "revoked") return binding.revokedRole;
  return binding.role;
}

function sameSessionIdentity(identity: SessionIdentity, expected: SessionIdentity): boolean {
  if (identity.id !== expected.id) return false;
  if (identity.projectID !== expected.projectID) return false;
  if (identity.workspaceID !== expected.workspaceID) return false;
  if (identity.parentID !== expected.parentID) return false;
  if (!samePath(identity.directory, expected.directory)) return false;
  if (identity.agent !== expected.agent) return false;
  if (!sameModelIdentity(identity.model, expected.model)) return false;
  return JSON.stringify(identity.metadata) === JSON.stringify(expected.metadata);
}

function sameModelIdentity(left: SessionModel | null, right: SessionModel | null): boolean {
  if (!left || !right) return left === right;
  return left.providerID === right.providerID && left.id === right.id && (left.variant ?? "default") === (right.variant ?? "default");
}

function attributeExecutorUntrackedChanges(
  entries: readonly CanonicalDiffEntry[],
  current: WorkspaceSnapshot,
  history: readonly unknown[],
  directory: string,
  platform: Platform,
): readonly CanonicalDiffEntry[] {
  const attributed = new Map(entries.map((entry) => [entry.path, entry]));
  const currentDiff = new Map(current.diff.map((entry) => [entry.path, entry]));
  const untracked = new Set([
    ...current.untracked.map((entry) => entry.path),
    ...current.status.filter((entry) => entry.status === "added").map((entry) => entry.path),
  ]);
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) visit(item); return; }
    if (!node || typeof node !== "object") return;
    const value = node as { type?: unknown; tool?: unknown; state?: unknown; input?: unknown; files?: unknown };
    if (value.type === "patch" && Array.isArray(value.files)) {
      for (const rawPath of value.files) {
        if (typeof rawPath !== "string") continue;
        try {
          const path = normalizeWorkspacePath(relativeExecutorPath(rawPath, directory), platform);
          const diff = currentDiff.get(path);
          if (untracked.has(path) && diff?.status === "added" && !attributed.has(path)) attributed.set(path, diff);
        } catch { /* invalid or out-of-workspace patch targets remain unattributed */ }
      }
    }
    if (value.type === "tool" && value.tool === "write" && value.state && typeof value.state === "object") {
      const state = value.state as { status?: unknown; input?: unknown };
      if ((state.status === undefined || state.status === "completed") && state.input && typeof state.input === "object") {
        const record = state.input as Record<string, unknown>;
        if (typeof record.content === "string") {
          const rawPath = typeof record.filePath === "string" ? record.filePath : typeof record.path === "string" ? record.path : undefined;
          if (rawPath) {
            try {
              const path = normalizeWorkspacePath(relativeExecutorPath(rawPath, directory), platform);
              const currentHash = current.untracked.find((entry) => entry.path === path)?.contentHash;
              if (untracked.has(path) && (!attributed.has(path) || addedPatchContentHash(attributed.get(path)?.patch) !== currentHash)) {
                const lines = record.content.split(/\r?\n/);
                const contentLines = record.content.endsWith("\n") ? lines.slice(0, -1) : lines;
                const patchBody = contentLines.map((line) => `+${line}`).join("\n");
                const patch = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${contentLines.length} @@\n${patchBody}${record.content.endsWith("\n") ? "\n" : "\n\\ No newline at end of file\n"}`;
                attributed.set(path, { path, status: "added", additions: contentLines.length, deletions: 0, patch });
              }
            } catch { /* invalid or out-of-workspace tool targets remain unattributed */ }
          }
        }
      }
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(history);
  return [...attributed.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function relativeExecutorPath(value: string, directory: string): string {
  const normalizedValue = value.replace(/\\/g, "/");
  const normalizedDirectory = directory.replace(/\\/g, "/").replace(/\/+$/, "");
  const left = normalizedValue.toLowerCase();
  const root = normalizedDirectory.toLowerCase();
  if (left === root) throw new TypeError("executor-file-target-is-directory");
  if (left.startsWith(`${root}/`)) return normalizedValue.slice(normalizedDirectory.length + 1);
  return normalizedValue;
}

function extractAnswers(metadata: unknown): string[][] | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const raw = (metadata as { answers?: unknown }).answers;
  if (!Array.isArray(raw)) return undefined;
  const values: string[][] = [];
  for (const answer of raw) {
    if (!Array.isArray(answer) || answer.some((item) => typeof item !== "string")) return undefined;
    values.push(answer as string[]);
  }
  return values.length ? values : undefined;
}

function extractAnswersFromText(output: string): string[][] | undefined {
  try { return extractAnswers(JSON.parse(output)); } catch { return undefined; }
}

function extractBashCommand(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = args as Record<string, unknown>;
  return typeof value.command === "string" ? value.command : typeof value.cmd === "string" ? value.cmd : undefined;
}

function buildDispatchPrompt(dispatch: DispatchView): string {
  const payload = dispatch.payload;
  if (!payload || typeof payload !== "object") return "Continue the exact approved Contract from goat_state.";
  const value = payload as { kind?: unknown; instruction?: unknown; findings?: unknown; attempt?: unknown; nativeQuestion?: unknown };
  if (value.kind === "approval-reissue") return `Ask the exact pending Goat Contract approval again with the native Question tool. Use this payload without modification: ${JSON.stringify(value.nativeQuestion)}`;
  if (value.kind === "verifier") return `${typeof value.instruction === "string" ? value.instruction : "Independently verify every approved criterion and report through goat_verifier_report."}`;
  if (value.kind === "executor-remediation") {
    const attempt = Number(value.attempt);
    const batch = Math.floor((attempt - 1) / DEFAULT_MAX_VERIFICATION_ATTEMPTS) + 1;
    const round = ((attempt - 1) % DEFAULT_MAX_VERIFICATION_ATTEMPTS) + 1;
    if (Array.isArray(value.findings) && value.findings.length === 0 && typeof (value as { reason?: unknown }).reason === "string") {
      return `Verification batch ${batch}, round ${round}/${DEFAULT_MAX_VERIFICATION_ATTEMPTS} could not be delivered to the Verifier. Check the approved workspace and call goat_completion_propose again. Technical detail: ${(value as { reason: string }).reason}`;
    }
    return `Verification batch ${batch}, round ${round}/${DEFAULT_MAX_VERIFICATION_ATTEMPTS} failed. Repair only these persisted findings, preserve prior work, append evidence, and call goat_completion_propose again: ${JSON.stringify(value.findings)}`;
  }
  if (value.kind === "executor-resume") return "Resume the exact approved Contract from goat_state. Preserve prior work and do not infer new scope.";
  return `${typeof value.instruction === "string" ? value.instruction : "Execute the exact approved Contract from goat_state."} Record evidence for every MUST criterion; once all MUST evidence is recorded, immediately call goat_completion_propose and do not continue exploring.`;
}

function isDefinitiveNotFound(error: unknown): boolean {
  return classifyExternalError(error) === "not-found";
}
