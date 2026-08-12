import { expect, test } from "bun:test";
import { openDatabase } from "../src/store/database.js";
import { initializeSchema } from "../src/store/schema.js";
import { Store } from "../src/store/store.js";
import { ProcessContext, type GoalOrigin } from "../src/runtime/process-context.js";
import { Orchestrator } from "../src/runtime/orchestrator.js";
import type { QuestionPort, SessionPort, WorkspacePort } from "../src/core/ports.js";

const scope: GoalOrigin = { projectId: "project-1", rootWorkspaceId: null, projectDirectory: "C:\\Project", worktreeOrigin: "C:\\Project" };
const home = "C:\\data\\goat";

const sessionStub: SessionPort = {
  get: async (id, directory) => ({ id, title: null, projectID: "project-1", workspaceID: null, parentID: null, directory, agent: null, model: null, metadata: null }),
  create: async (input) => ({ id: "child", title: input.title ?? null, projectID: "project-1", workspaceID: null, parentID: input.parentID ?? null, directory: input.directory, agent: input.agent ?? null, model: input.model ?? null, metadata: input.metadata ?? null }),
  children: async () => [],
  promptAsync: async () => undefined,
  diff: async () => [],
  message: async () => undefined,
  interrupt: async () => undefined,
  status: async () => "idle",
};

const workspaceStub: WorkspacePort = {
  probeGit: async () => ({ isGit: true, isClean: true }),
  listWorktrees: async () => [],
  createWorktree: async () => ({ path: "C:\\Project\\wt", waitUntilReady: async () => undefined }),
  captureSnapshot: async () => ({ ok: false, error: "not-needed" }),
};

const questionStub: QuestionPort = { list: async () => [], reject: async () => undefined };

function createContext() {
  const db = openDatabase(":memory:");
  initializeSchema(db);
  let sequence = 0;
  const store = new Store(db, { now: () => new Date() }, { next: () => `id-${++sequence}` }, "instance-test");
  const orchestrator = new Orchestrator(store, sessionStub, workspaceStub, questionStub, scope.projectId, undefined, "linux");
  const context = ProcessContext.create({ projectId: scope.projectId, instanceId: "instance-test", db, store, orchestrator, releaseOwnedLeases: () => store.releaseOwnedLeases() });
  ProcessContext.register(context, home);
  return { db, store, context };
}

test("process contexts are shared per project and disposed on the last release", async () => {
  const first = createContext();
  try {
    const second = ProcessContext.getExisting(home, "project-1");
    expect(second).toBe(first.context);
    expect(ProcessContext.getExisting(home, "other-project")).toBeUndefined();
    expect(ProcessContext.getExisting("C:\\other", "project-1")).toBeUndefined();
    expect(ProcessContext.getExisting(home, "project-1")).toBe(first.context);

    first.context.retain();
    first.context.retain();
    await first.context.release(home);
    expect(ProcessContext.getExisting(home, "project-1")).toBe(first.context);
    await first.context.release(home);
    expect(ProcessContext.getExisting(home, "project-1")).toBeUndefined();
    expect(() => first.db.query("SELECT 1 AS one")).toThrow();
  } finally {
    first.db.close();
  }
});

test("a disposed context cannot be retained or released again", async () => {
  const { db, context } = createContext();
  try {
    context.retain();
    await context.release(home);
    expect(() => context.retain()).toThrow(/disposed/);
    await context.release(home);
    expect(ProcessContext.getExisting(home, "project-1")).toBeUndefined();
  } finally {
    db.close();
  }
});

test("context keys isolate projects and data homes", () => {
  expect(ProcessContext.contextKey("C:\\a", "p1")).not.toBe(ProcessContext.contextKey("C:\\b", "p1"));
  expect(ProcessContext.contextKey("C:\\a", "p1")).not.toBe(ProcessContext.contextKey("C:\\a", "p2"));
  expect(ProcessContext.contextKey("C:\\a", "p1")).toBe(ProcessContext.contextKey("C:\\a", "p1"));
});
