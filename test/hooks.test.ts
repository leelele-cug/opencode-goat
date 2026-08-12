import { expect, test } from "bun:test";
import type { QuestionPort, SessionIdentity, SessionPort, WorkspacePort } from "../src/core/ports.js";
import { Orchestrator } from "../src/runtime/orchestrator.js";
import { createHooks } from "../src/opencode/hooks.js";
import { openDatabase } from "../src/store/database.js";
import { initializeSchema } from "../src/store/schema.js";
import { Store } from "../src/store/store.js";
import { buildSnapshot } from "../src/core/workspace.js";

const platform = process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
const projectDirectory = platform === "win32" ? "C:\\Project" : "/tmp/goat-project";
const worktreeDirectory = platform === "win32" ? "C:\\Project\\wt" : "/tmp/goat-project/wt";
const origin = { projectId: "project-1", rootWorkspaceId: null, projectDirectory, worktreeOrigin: projectDirectory };
const model = { providerID: "test-provider", id: "test-model" };

function identity(overrides: Partial<SessionIdentity> = {}): SessionIdentity {
  return { id: "root-session", title: "root", projectID: "project-1", workspaceID: null, parentID: null, directory: projectDirectory, agent: "goat-formulator", model, metadata: null, ...overrides };
}

function createRuntime() {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  let sequence = 0;
  const store = new Store(db, { now: () => new Date() }, { next: () => `id-${++sequence}` }, "instance-1");
  const session: SessionPort = {
    get: async (id, directory) => identity({ id, directory, parentID: id === "root-session" ? null : "root-session" }),
    create: async (input) => identity({ id: "child", parentID: input.parentID ?? null, directory: input.directory, agent: input.agent ?? null, model: input.model ?? null, metadata: input.metadata ?? null, title: input.title ?? null }),
    children: async () => [],
    promptAsync: async () => undefined,
    diff: async () => [],
    message: async () => undefined,
    interrupt: async () => undefined,
    status: async () => "idle",
  };
  const workspace: WorkspacePort = {
    probeGit: async () => ({ isGit: true, isClean: true }),
    listWorktrees: async () => [],
    createWorktree: async () => ({ path: worktreeDirectory, waitUntilReady: async () => undefined }),
    captureSnapshot: async () => ({ ok: true, snapshot: buildSnapshotStub() }),
  };
  const question: QuestionPort = { list: async () => [], reject: async () => undefined };
  const scope = origin;
  const orchestrator = new Orchestrator(store, session, workspace, question, scope.projectId, undefined, platform);
  const registry = { ids: async () => ["goat_state", "goat_contract_propose", "goat_evidence_record", "goat_completion_propose", "goat_block", "goat_verifier_report"] };
  let configRegistered = 0;
  const hooks = createHooks(orchestrator, session, registry, origin, () => { configRegistered += 1; });
  return { db, store, orchestrator, hooks, configRegistered: () => configRegistered };
}

function buildSnapshotStub() {
  return buildSnapshot({ head: "a".repeat(40), status: [], diff: [], untracked: [], rawDiff: "", platform });
}

test("config registers Goat agents once and the /goat command", async () => {
  const runtime = createRuntime();
  try {
    await runtime.hooks.config?.({} as never);
    expect(runtime.configRegistered()).toBe(1);
    await runtime.hooks.config?.({} as never);
    expect(runtime.configRegistered()).toBe(2);
  } finally { runtime.db.close(); }
});

test("the command hook rejects child Sessions and creates Goals from the root Session", async () => {
  const runtime = createRuntime();
  try {
    await runtime.hooks.config?.({} as never);
    const denied = { parts: [] as { type: string; text: string }[] };
    await runtime.hooks["command.execute.before"]?.({ command: "goat", sessionID: "child-session", arguments: "build auth" }, denied as never);
    expect(denied.parts[0]?.text).toContain("root Session");
    const accepted = { parts: [] as { type: string; text: string }[] };
    await runtime.hooks["command.execute.before"]?.({ command: "goat", sessionID: "root-session", arguments: "build auth" }, accepted as never);
    expect(accepted.parts[0]?.text).toContain("Goal created");
    expect(runtime.store.getSessionBinding("root-session")).toMatchObject({ role: "root" });
  } finally { runtime.db.close(); }
});

test("the before-hook binds the exact approval Question and denies mismatches", async () => {
  const runtime = createRuntime();
  try {
    await runtime.hooks.config?.({} as never);
    const created = await runtime.orchestrator.createGoal({ sourceRequest: "hooks test", rootSessionId: "root-session", origin, model });
    if (!created.ok) throw new Error(created.error);
    const goalId = created.goalId;
    await runtime.orchestrator.proposeContract(
      { toolId: "goat_contract_propose", sessionID: "root-session", messageID: "m1", agent: "goat-formulator", directory: projectDirectory, worktree: projectDirectory },
      { outcome: "works", included: ["x"], excluded: [], constraints: [], assumptions: [], workspace: "current", criteria: [{ id: "c", priority: "must", description: "works", verification: [{ kind: "inspection", description: "inspect" }] }], outcomeObservable: true, constraintsReviewed: true, assumptionsReviewed: true, outcomeChangingQuestionsResolved: true, workspaceAvailable: true, infeasibleCriterionIds: [] },
      "proposal-op-hooks",
    );
    const live = runtime.store.getLiveApproval(goalId)!;
    const args = JSON.parse(live.nativeQuestionJson).value;
    await runtime.hooks["tool.execute.before"]?.({ tool: "question", sessionID: "root-session", callID: "call-1" }, { args } as never);
    expect(runtime.store.getLiveApproval(goalId)?.callId).toBe("call-1");
    await expect(runtime.hooks["tool.execute.before"]?.({ tool: "question", sessionID: "root-session", callID: "call-2" }, { args: { questions: [{ question: "different" }] } } as never)).rejects.toThrow();
  } finally { runtime.db.close(); }
});

test("the after-hook resolves approval and activates the Goal", async () => {
  const runtime = createRuntime();
  try {
    await runtime.hooks.config?.({} as never);
    const created = await runtime.orchestrator.createGoal({ sourceRequest: "hooks test", rootSessionId: "root-session", origin, model });
    if (!created.ok) throw new Error(created.error);
    const goalId = created.goalId;
    await runtime.orchestrator.proposeContract(
      { toolId: "goat_contract_propose", sessionID: "root-session", messageID: "m1", agent: "goat-formulator", directory: projectDirectory, worktree: projectDirectory },
      { outcome: "works", included: ["x"], excluded: [], constraints: [], assumptions: [], workspace: "current", criteria: [{ id: "c", priority: "must", description: "works", verification: [{ kind: "inspection", description: "inspect" }] }], outcomeObservable: true, constraintsReviewed: true, assumptionsReviewed: true, outcomeChangingQuestionsResolved: true, workspaceAvailable: true, infeasibleCriterionIds: [] },
      "proposal-op-hooks-2",
    );
    const live = runtime.store.getLiveApproval(goalId)!;
    await runtime.hooks["tool.execute.before"]?.({ tool: "question", sessionID: "root-session", callID: "call-1" }, { args: JSON.parse(live.nativeQuestionJson).value } as never);
    await runtime.hooks["tool.execute.after"]?.({ tool: "question", sessionID: "root-session", callID: "call-1", args: undefined }, { output: "", metadata: { answers: [["Approve and start"]] } } as never);
    expect(runtime.store.getGoal(goalId)?.state).toBe("ACTIVE");
  } finally { runtime.db.close(); }
});

test("unbound reserved agents cannot use generic tools", async () => {
  const runtime = createRuntime();
  try {
    await expect(runtime.hooks["tool.execute.before"]?.({ tool: "bash", sessionID: "unrelated-session", callID: "call-1" }, { args: {} } as never)).rejects.toThrow("unbound-goat-agent");
    await expect(runtime.hooks["tool.execute.before"]?.({ tool: "edit", sessionID: "unrelated-session", callID: "call-2" }, { args: {} } as never)).rejects.toThrow("unbound-goat-agent");
    await expect(runtime.hooks["tool.execute.before"]?.({ tool: "goat_state", sessionID: "unrelated-session", callID: "call-3" }, { args: {} } as never)).rejects.toThrow("goat-session-not-bound");
  } finally { runtime.db.close(); }
});

test("compaction context preserves minimal durable state and disables auto-continue", async () => {
  const runtime = createRuntime();
  try {
    await runtime.hooks.config?.({} as never);
    const created = await runtime.orchestrator.createGoal({ sourceRequest: "compaction", rootSessionId: "root-session", origin, model });
    if (!created.ok) throw new Error(created.error);
    const output = { context: [] as string[], prompt: undefined };
    await runtime.hooks["experimental.session.compacting"]?.({ sessionID: "root-session" }, output as never);
    expect(output.context[0]).toContain("Goat durable state");
    const auto = { enabled: true };
    await runtime.hooks["experimental.compaction.autocontinue"]?.({ sessionID: "root-session", agent: "goat-formulator", model: {} as never, provider: {} as never, message: {} as never, overflow: false }, auto as never);
    expect(auto.enabled).toBe(false);
  } finally { runtime.db.close(); }
});

test("event routing forwards prompted and rejected events to the Orchestrator", async () => {
  const runtime = createRuntime();
  try {
    await runtime.hooks.config?.({} as never);
    const created = await runtime.orchestrator.createGoal({ sourceRequest: "events", rootSessionId: "root-session", origin, model });
    if (!created.ok) throw new Error(created.error);
    const goalId = created.goalId;
    await runtime.hooks.event?.({ event: { type: "session.next.prompted", properties: { sessionID: "x", messageID: "y" } } as never });
    await runtime.hooks.event?.({ event: { type: "worktree.failed", properties: { message: "boom" } } as never });
    expect(runtime.store.getGoal(goalId)?.state).toBe("FORMING");
    await runtime.hooks.event?.({ event: { type: "server.connected", properties: {} } as never });
  } finally { runtime.db.close(); }
});
