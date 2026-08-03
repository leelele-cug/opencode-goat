import { expect, test } from "bun:test";
import type { QuestionPort, SessionIdentity, SessionPort, ToastPort, WorkspacePort } from "../src/core/ports.js";
import { Orchestrator } from "../src/runtime/orchestrator.js";
import { openDatabase } from "../src/store/database.js";
import { initializeSchema } from "../src/store/schema.js";
import { Store } from "../src/store/store.js";
import { buildSnapshot, type WorkspaceSnapshot } from "../src/core/workspace.js";

const origin = { projectId: "project-1", rootWorkspaceId: null, projectDirectory: "C:\\Project", worktreeOrigin: "C:\\Project" };
const model = { providerID: "test-provider", id: "test-model" };

function snapshot(commit = "a".repeat(40)): WorkspaceSnapshot {
  return buildSnapshot({ head: commit, status: [], diff: [], untracked: [], rawDiff: "", platform: "linux" });
}

type Fakes = {
  session: SessionPort;
  workspace: WorkspacePort;
  question: QuestionPort;
  toasts: { title?: string; message: string; variant: string }[];
};

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return {
    id: "root-session",
    title: "root",
    projectID: "project-1",
    workspaceID: null,
    parentID: null,
    directory: "c:\\project",
    agent: "goat-formulator",
    model,
    metadata: null,
    ...overrides,
  };
}

function createFakes(overrides: Partial<Fakes> = {}): Fakes {
  const toasts: Fakes["toasts"] = [];
  const question: QuestionPort = { list: async () => [], reject: async () => undefined, ...(overrides.question ?? {}) };
  const workspace: WorkspacePort = {
    probeGit: async () => ({ isGit: true, isClean: true }),
    listWorktrees: async () => [],
    createWorktree: async () => ({ path: "C:\\Project\\worktree", waitUntilReady: async () => undefined }),
    removeWorktree: async () => undefined,
    captureSnapshot: async () => ({ ok: true, snapshot: snapshot() }),
    ...(overrides.workspace ?? {}),
  };
  const session: SessionPort = {
    get: async (id, directory) => identity({ id, directory }),
    create: async (input) => identity({ id: "child-session", parentID: input.parentID ?? null, directory: input.directory, agent: input.agent ?? null, model: input.model ?? null, metadata: input.metadata ?? null, title: input.title ?? null }),
    children: async () => [],
    promptAsync: async () => undefined,
    diff: async () => [],
    message: async () => undefined,
    interrupt: async () => undefined,
    status: async () => "idle",
    ...(overrides.session ?? {}),
  };
  return { session, workspace, question, toasts };
}

function createRuntime(overrides: Partial<Fakes> = {}) {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  let sequence = 0;
  const store = new Store(db, { now: () => new Date() }, { next: () => `id-${++sequence}` }, "instance-1");
  const fakes = createFakes(overrides);
  const orchestrator = new Orchestrator(store, fakes.session, fakes.workspace, fakes.question, origin, { show: async (toast) => { fakes.toasts.push(toast); } } satisfies ToastPort);
  return { db, store, orchestrator, ...fakes };
}

const proposeArgs = {
  outcome: "works",
  included: ["x"],
  excluded: [],
  constraints: [],
  assumptions: [],
  criteria: [{ id: "c", priority: "must" as const, description: "works", verificationMethod: "inspect" }],
  outcomeObservable: true,
  constraintsReviewed: true,
  assumptionsReviewed: true,
  outcomeChangingQuestionsResolved: true,
  workspaceAvailable: true,
  infeasibleCriterionIds: [],
};

async function createGoalWithApproval(runtime: ReturnType<typeof createRuntime>, workspace: "current" | "worktree" = "current"): Promise<string> {
  const created = await runtime.orchestrator.createGoal({ sourceRequest: "runtime test", rootSessionId: "root-session", model });
  if (!created.ok) throw new Error(created.error);
  const goalId = created.goalId;
  await runtime.orchestrator.proposeContract(
    { toolId: "goat_contract_propose", sessionID: "root-session", messageID: "m1", agent: "goat-formulator", directory: "C:\\Project", worktree: "C:\\Project" },
    { ...proposeArgs, workspace },
    "proposal-op",
  );
  await bindQuestion(runtime, goalId, "call-1");
  return goalId;
}

async function bindQuestion(runtime: ReturnType<typeof createRuntime>, goalId: string, callId: string): Promise<void> {
  const live = runtime.store.getLiveApproval(goalId)!;
  const args = JSON.parse(live.nativeQuestionJson).value;
  const decision = await runtime.orchestrator.guardGenericToolCall("root-session", "question", callId, args);
  expect(decision).toEqual({ allowed: true });
}

test("question rejection blocks the Goal and notifies exactly once", async () => {
  const runtime = createRuntime();
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.reconcileApproval(goalId);
    expect(runtime.store.getLiveApproval(goalId)?.nativeRequestId).toBeNull();
    await runtime.orchestrator.handleQuestionRejected("root-session", "request-1");
    expect(runtime.store.getGoal(goalId)?.state).toBe("AWAITING_APPROVAL");
  } finally { runtime.db.close(); }
});

test("a rejected contract Question blocks the Goal and notifies exactly once", async () => {
  const runtime = createRuntime({
    question: {
      list: async () => [{ id: "request-1", sessionId: "root-session", questions: JSON.parse(runtime0(runtime)).value.questions, callId: "call-1" }],
      reject: async () => undefined,
    },
  });
  function runtime0(r: ReturnType<typeof createRuntime>): string {
    return r.store.getLiveApproval(r.store.getSessionBinding("root-session")!.goal.goalId)!.nativeQuestionJson;
  }
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.reconcileApproval(goalId);
    expect(runtime.store.getLiveApproval(goalId)?.nativeRequestId).toBe("request-1");
    await runtime.orchestrator.handleQuestionRejected("root-session", "request-1");
    expect(runtime.store.getGoal(goalId)?.state).toBe("BLOCKED");
    expect(runtime.store.getGoal(goalId)?.blockerCode).toBe("approval-not-approved");
    expect(runtime.toasts.length).toBe(1);
    await runtime.orchestrator.handleQuestionRejected("root-session", "request-1");
    expect(runtime.toasts.length).toBe(1);
  } finally { runtime.db.close(); }
});

test("resume after rejection creates the next approval generation on the same revision", async () => {
  const runtime = createRuntime();
  try {
    const goalId = await createGoalWithApproval(runtime);
    const revisionBefore = runtime.store.getLatestRevision(goalId)?.revision;
    const token = runtime.store.getOwnedFencingToken(goalId)!;
    runtime.store.markApprovalRejected(goalId, token, "event-1");
    const resumed = await runtime.orchestrator.resume(goalId);
    expect(resumed.ok).toBe(true);
    expect(runtime.store.getGoal(goalId)?.state).toBe("AWAITING_APPROVAL");
    expect(runtime.store.getLatestRevision(goalId)?.revision).toBe(revisionBefore);
    expect(runtime.store.getLiveApproval(goalId)?.generation).toBe(2);
    expect(runtime.store.getLiveApproval(goalId)?.predecessorAttemptId).toBeDefined();
  } finally { runtime.db.close(); }
});

test("approval resolution activates the workspace and dispatches the Executor", async () => {
  const prompts: { messageID?: string; agent?: string; directory?: string }[] = [];
  const runtime = createRuntime({
    session: {
      ...createFakes().session,
      promptAsync: async (_id, body) => { prompts.push({ ...(body.messageID !== undefined ? { messageID: body.messageID } : {}), ...(body.agent !== undefined ? { agent: body.agent } : {}), directory: body.directory }); },
      create: async (input) => identity({ id: "executor-child", parentID: "root-session", directory: input.directory, agent: "goat-executor", model, metadata: input.metadata ?? null, title: "Goat Executor" }),
    },
  });
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    expect(runtime.store.getGoal(goalId)?.state).toBe("ACTIVE");
    expect(runtime.store.getRun(goalId)?.executorSessionId).toBe("executor-child");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ agent: "goat-executor" });
  } finally { runtime.db.close(); }
});

test("guardGenericToolCall enforces the fixed role matrix for bound sessions", async () => {
  const runtime = createRuntime();
  try {
    const goalId = await createGoalWithApproval(runtime);
    void goalId;
    expect(await runtime.orchestrator.guardGenericToolCall("root-session", "read", "call-x")).toEqual({ allowed: true });
    expect(await runtime.orchestrator.guardGenericToolCall("root-session", "edit", "call-y")).toMatchObject({ allowed: false });
    expect(await runtime.orchestrator.guardGenericToolCall("root-session", "task", "call-z")).toMatchObject({ allowed: false });
    expect(await runtime.orchestrator.guardGenericToolCall("unrelated-session", "bash", "call-w")).toEqual({ allowed: true });
    expect(await runtime.orchestrator.guardGenericToolCall("root-session", "goat_state", "call-v")).toEqual({ allowed: true });
  } finally { runtime.db.close(); }
});

test("worktree activation creates and dispatches only after readiness", async () => {
  const order: string[] = [];
  const runtime = createRuntime({
    workspace: {
      ...createFakes().workspace,
      captureSnapshot: async () => { order.push("baseline"); return { ok: true, snapshot: snapshot() }; },
      createWorktree: async () => ({ path: "C:\\Project\\goat-worktree", waitUntilReady: async () => { order.push("ready"); } }),
      listWorktrees: async () => [],
    },
    session: {
      ...createFakes().session,
      promptAsync: async () => { order.push("prompt"); },
      create: async (input) => identity({ id: "executor-child", parentID: "root-session", directory: input.directory, agent: "goat-executor", model, metadata: input.metadata ?? null, title: "Goat Executor" }),
    },
  });
  try {
    const goalId = await createGoalWithApproval(runtime, "worktree");
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    expect(order).toEqual(["baseline", "ready", "baseline", "prompt"]);
    expect(runtime.store.getGoal(goalId)?.state).toBe("ACTIVE");
    expect(runtime.store.getRun(goalId)?.workspacePath?.toLowerCase()).toBe("c:\\project\\goat-worktree");
  } finally { runtime.db.close(); }
});

test("recovery reconciles an unbound executor session and redelivers a missing message", async () => {
  const runtime = createRuntime({
    session: {
      ...createFakes().session,
      get: async (id, directory) => {
        if (id === "root-session") return identity({ id, directory });
        throw Object.assign(new Error("session-not-found"), { status: 404 });
      },
      create: async (input) => identity({ id: "executor-child", parentID: "root-session", directory: input.directory, agent: "goat-executor", model, metadata: input.metadata ?? null, title: "Goat Executor" }),
      message: async () => undefined,
    },
  });
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    expect(runtime.store.getGoal(goalId)?.state).toBe("ACTIVE");
    await runtime.orchestrator.recoverProject();
    expect(runtime.store.getRun(goalId)?.executorSessionId).toBe("executor-child");
  } finally { runtime.db.close(); }
});

test("recovery completes a PREPARING Run that has no workspace path", async () => {
  const runtime = createRuntime();
  try {
    const goalId = await createGoalWithApproval(runtime);
    const token = runtime.store.getOwnedFencingToken(goalId)!;
    const approval = runtime.store.resolveApproval(goalId, token, "call-1", [["Approve and start"]]);
    expect(approval.ok && approval.action).toBe("approved");
    expect(runtime.store.getRun(goalId)?.status).toBe("PREPARING");
    await runtime.orchestrator.recoverProject();
    expect(runtime.store.getGoal(goalId)?.state).toBe("ACTIVE");
    expect(runtime.store.getRun(goalId)?.workspacePath).toBe("c:\\project");
  } finally { runtime.db.close(); }
});

test("recovery binds a missing Verifier Session before delivery", async () => {
  const prompts: string[] = [];
  const sessions = new Map<string, SessionIdentity>();
  const runtime = createRuntime({
    session: {
      ...createFakes().session,
      get: async (id, directory) => sessions.get(id) ?? identity({ id, directory }),
      promptAsync: async (id) => { prompts.push(id); },
      create: async (input) => {
        const created = identity({ id: input.agent === "goat-verifier" ? "verifier-child" : "executor-child", parentID: "root-session", directory: input.directory, agent: input.agent ?? null, model: input.model ?? null, metadata: input.metadata ?? null, title: input.title ?? null });
        sessions.set(created.id, created);
        return created;
      },
    },
  });
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    const run = runtime.store.getRun(goalId)!;
    const evidence = runtime.store.recordEvidence(goalId, runtime.store.getOwnedFencingToken(goalId)!, run.runId, "c", { source: "test", method: "inspect", expectedResult: "works", actualReference: "test://x", producer: run.executorSessionId! }, "recovery-verifier-evidence");
    expect(evidence.ok).toBe(true);
    const proposed = await runtime.orchestrator.proposeCompletion({ toolId: "goat_completion_propose", sessionID: run.executorSessionId!, messageID: "m", agent: "goat-executor", directory: "C:\\Project", worktree: "C:\\Project" }, "recovery-verifier-completion");
    expect(proposed).toContain("verification-started");
    expect(runtime.store.getRun(goalId)?.status).toBe("VERIFYING");
    await runtime.orchestrator.recoverProject();
    expect(runtime.store.getSessionBinding("verifier-child")).toMatchObject({ role: "verifier" });
    expect(prompts).toContain("verifier-child");
  } finally { runtime.db.close(); }
});

test("a stale executor Session cannot control the Goal after revision", async () => {
  const runtime = createRuntime();
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    expect(runtime.store.getGoal(goalId)?.state).toBe("ACTIVE");
    await runtime.orchestrator.revise(goalId, "change it");
    expect(runtime.store.getSessionBinding("child-session")).toMatchObject({ role: "revoked", revokedRole: "executor" });
    expect(await runtime.orchestrator.guardGenericToolCall("child-session", "edit", "stale-call", { filePath: "src/file.ts" })).toEqual({ allowed: false, error: "stale-goat-session" });
    expect(runtime.store.getGoal(goalId)?.state).toBe("FORMING");
  } finally { runtime.db.close(); }
});

test("cancellation removes a clean abandoned worktree after the terminal transition", async () => {
  let created = false;
  let removed = false;
  let worktreeName = "";
  const runtime = createRuntime({
    workspace: {
      ...createFakes().workspace,
      createWorktree: async (_directory, name) => { created = true; worktreeName = name; return { path: "C:\\Project\\goat-worktree", waitUntilReady: async () => undefined }; },
      listWorktrees: async () => created ? [{ name: worktreeName, path: "C:\\Project\\goat-worktree" }] : [],
      removeWorktree: async () => { removed = true; },
    },
    session: {
      ...createFakes().session,
      create: async (input) => identity({ id: "executor-child", parentID: "root-session", directory: input.directory, agent: "goat-executor", model, metadata: input.metadata ?? null, title: "Goat Executor" }),
    },
  });
  try {
    const goalId = await createGoalWithApproval(runtime, "worktree");
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    expect(await runtime.orchestrator.cancel(goalId)).toEqual({ ok: true });
    expect(removed).toBe(true);
  } finally { runtime.db.close(); }
});

test("prompted events advance matching dispatches", async () => {
  const runtime = createRuntime({
    session: {
      ...createFakes().session,
      create: async (input) => identity({ id: "executor-child", parentID: "root-session", directory: input.directory, agent: "goat-executor", model, metadata: input.metadata ?? null, title: "Goat Executor" }),
    },
  });
  try {
    const goalId = await createGoalWithApproval(runtime);
    await runtime.orchestrator.handleQuestionAfter("root-session", "call-1", { answers: [["Approve and start"]] }, "");
    const dispatch = runtime.store.listPendingDispatches(goalId).find((item) => item.role === "executor")!;
    await runtime.orchestrator.handlePrompted("executor-child", dispatch.messageId);
    expect(runtime.store.getDispatch(dispatch.dispatchId)?.status).toBe("STARTED");
  } finally { runtime.db.close(); }
});
