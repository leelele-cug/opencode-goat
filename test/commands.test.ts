import { expect, test } from "bun:test";
import { executeGoatCommand, parseGoatCommand } from "../src/opencode/commands.js";
import type { Config } from "@opencode-ai/plugin";
import { assertGoatToolRegistration, registerGoatConfig } from "../src/opencode/config.js";
import { REGISTERED_GOAT_TOOL_IDS, ROLE_CAPABILITIES } from "../src/core/role-capabilities.js";
import type { GoalState } from "../src/core/state.js";
import type { BlockerCode } from "../src/core/errors.js";
import { renderBlocked, renderCompleted, renderConcise, renderDetailed, renderDoctor, renderHelp } from "../src/presentation.js";
import type { Orchestrator, StatusReadModel } from "../src/runtime/orchestrator.js";
import type { GoalOrigin } from "../src/runtime/process-context.js";
import type { SessionBinding } from "../src/store/store.js";
import { buildSnapshot } from "../src/core/workspace.js";
import { classifyExternalError } from "../src/core/ports.js";
import { isNonTerminal } from "../src/core/state.js";
import { redact } from "../src/core/redaction.js";
import { agentIdForRole } from "../src/core/role-capabilities.js";

test("Goat distinguishes concise and detailed status commands", () => {
  expect(parseGoatCommand(" ")).toEqual({ type: "status", detailed: false });
  expect(parseGoatCommand("status")).toEqual({ type: "status", detailed: true });
  expect(parseGoatCommand("doctor")).toEqual({ type: "doctor" });
  expect(parseGoatCommand("revise")).toEqual({ type: "unknown", raw: "revise" });
  expect(parseGoatCommand("revise make it faster")).toEqual({ type: "revise", change: "make it faster" });
});

test("Goat registers fixed agents without any allow or ask permission rules", () => {
  const config = {} as Config;
  registerGoatConfig(config);
  expect(config.agent?.["goat-formulator"]?.mode).toBe("primary");
  expect(config.agent?.["goat-verifier"]?.mode).toBe("subagent");
  expect(config.agent?.["goat-formulator"]?.permission).toBeUndefined();
  expect(config.agent?.["goat-executor"]?.permission).toBeUndefined();
  expect(config.agent?.["goat-verifier"]?.permission).toBeUndefined();
  const executorTools = config.agent?.["goat-executor"]?.tools as Record<string, boolean> | undefined;
  expect(executorTools?.edit).toBe(true);
  expect(executorTools?.question).toBeUndefined();
  const formulatorTools = config.agent?.["goat-formulator"]?.tools as Record<string, boolean> | undefined;
  expect(formulatorTools?.bash).toBeUndefined();
  expect(formulatorTools?.read).toBe(true);
  expect(formulatorTools?.goat_state).toBe(true);
});

test("Goat refuses to override reserved agent IDs and the /goat command", () => {
  expect(() => registerGoatConfig({ command: { goat: { template: "existing" } } } as Config)).toThrow(/will not override/);
  expect(() => registerGoatConfig({ agent: { "goat-executor": { description: "user" } } } as Config)).toThrow(/reserved by Goat/);
  expect(() => registerGoatConfig({ agent: { "goat-formulator": { prompt: "user" } } } as Config)).toThrow(/reserved by Goat/);
});

test("Goat tool registration collisions are rejected", () => {
  expect(() => assertGoatToolRegistration(REGISTERED_GOAT_TOOL_IDS)).not.toThrow();
  expect(() => assertGoatToolRegistration([...REGISTERED_GOAT_TOOL_IDS, "goat_state"])).toThrow(/goat_state \(2\)/);
  expect(() => assertGoatToolRegistration(REGISTERED_GOAT_TOOL_IDS.filter((id) => id !== "goat_block"))).toThrow(/goat_block \(0\)/);
});

test("role capabilities expose no overrideable permission surface", () => {
  expect(ROLE_CAPABILITIES.formulator.writeTools.size).toBe(0);
  expect(ROLE_CAPABILITIES.verifier.writeTools.size).toBe(0);
  expect(ROLE_CAPABILITIES.executor.deniedTools.has("question")).toBe(true);
  expect(ROLE_CAPABILITIES.formulator.deniedTools.has("bash")).toBe(true);
  expect(ROLE_CAPABILITIES.executor.genericTools.has("bash")).toBe(true);
});

const commandOrigin: GoalOrigin = { projectId: "project-1", rootWorkspaceId: null, projectDirectory: "/tmp/project", worktreeOrigin: "/tmp/project" };

function statusModel(state: GoalState = "ACTIVE", blockerCode: BlockerCode | null = null): StatusReadModel {
  return {
    goal: {
      goalId: "goal-1", projectId: "project-1", rootSessionId: "root-1", rootWorkspaceId: null,
      projectDirectory: "/tmp/project", worktreeOrigin: "/tmp/project", sourceRequest: "ship it", formationRequest: "clarify scope",
      model: null, state, currentRevision: 1, approvedRevisionHash: "hash", currentRunId: "run-1", blockerCode, blocker: blockerCode ? "Needs attention" : null,
      stateVersion: 1, createdAt: "now", updatedAt: "now",
    },
    revision: {
      goalId: "goal-1", revision: 1, hash: "hash", createdAt: "now",
      body: { sourceRequest: "ship it", outcome: "it ships", scope: { included: ["feature"], excluded: [] }, constraints: ["safe"], assumptions: [], workspace: "current" },
      criteria: [
        { id: "must", priority: "must", description: "feature works", verification: [{ kind: "command", command: "bun test" }] },
        { id: "should", priority: "should", description: "docs exist", verification: [{ kind: "inspection", description: "read docs" }] },
      ],
    },
    run: {
      runId: "run-1", goalId: "goal-1", approvalAttemptId: "attempt-1", revision: 1, approvedRevisionHash: "hash", workspaceStrategy: "current", worktreeName: null,
      workspacePath: "/tmp/project", baseline: null, checkpoint: buildSnapshot({ head: "a".repeat(40), status: [], diff: [], untracked: [], rawDiff: "", platform: "linux" }), finalSnapshot: null, executorDiff: null,
      executorSessionId: null, executorSessionKey: "session-key", executorProjectId: null, executorWorkspaceId: null, model: null, status: "ACTIVE", verificationAttempts: 3, verificationBatch: 2,
      preparationRetryRequested: false, rowVersion: 1,
    },
    evidence: [{ evidenceId: "evidence-1", goalId: "goal-1", runId: "run-1", revision: 1, criterionId: "must", source: "test", method: "command", expectedResult: "pass", actualReference: "output", producer: "verifier", recordedAt: "now" }],
    results: [{ attempt: 1, verifierSessionId: null, verifierSessionKey: null, outcome: "PASS", findings: [{ criterionId: "must", result: "pass", evidenceIds: ["evidence-1"], note: "verified" }], createdAt: "now", finalizedAt: "now" }],
    audit: [{ kind: "activated", actor: "root", previousState: "AWAITING_APPROVAL", nextState: "ACTIVE", goalSequence: 1, sourceEventId: null, createdAt: "now" }],
    attempt: null,
  };
}

test("presentation renders every public status view", () => {
  const model = statusModel();
  for (const state of ["FORMING", "AWAITING_APPROVAL", "ACTIVE", "VERIFYING", "PAUSED", "BLOCKED", "COMPLETED", "CANCELLED"] satisfies GoalState[]) {
    expect(renderConcise(statusModel(state))).toContain(`Goat: ${state.charAt(0) + state.slice(1).toLowerCase()}`);
  }
  expect(renderConcise(model)).toContain("Formation request: clarify scope");
  expect(renderDetailed(model)).toContain("Attempt 1: PASS");
  expect(renderDetailed({ ...model, revision: undefined })).toContain("Goat: Active");
  expect(renderBlocked(statusModel("BLOCKED", "approval-not-approved"))).toContain("Run /goat resume to ask for approval again");
  expect(renderBlocked(statusModel("BLOCKED", "workspace-preparation-failed"))).toContain("Resolve the blocker");
  expect(renderCompleted(statusModel("COMPLETED"))).toContain("verified");
  expect(renderHelp()).toContain("/goat revise <change>");
  expect(renderDoctor({ schemaVersion: 8, projectDirectory: "/tmp/project", worktreeOrigin: "/tmp/project", git: { isGit: true, isClean: true }, binding: null })).toContain("ready and clean");
  expect(renderDoctor({ schemaVersion: 8, projectDirectory: "/tmp/project", worktreeOrigin: "/tmp/project", git: { isGit: false, isClean: false }, binding: {} })).toContain("not a Git workspace");
});

test("executeGoatCommand covers status, intent, and control outcomes", async () => {
  let model: StatusReadModel | null = null;
  let binding: SessionBinding | null = null;
  let resume: { ok: true; delivery?: "sent" | "failed" | "uncertain" } | { ok: false; error: string } = { ok: true, delivery: "sent" };
  let operation: { ok: true } | { ok: false; error: string } = { ok: true };
  const orchestrator = {
    getDoctorStatus: async () => ({ schemaVersion: 8, projectDirectory: "/tmp/project", worktreeOrigin: "/tmp/project", git: { isGit: true, isClean: true }, binding }),
    getStatusReadModel: () => model,
    getBindingForSession: () => binding,
    createGoal: async () => ({ ok: true as const, goalId: "goal-1" }),
    resume: async () => resume,
    revise: async () => operation,
    pause: async () => operation,
    cancel: async () => operation,
  } as unknown as Orchestrator;

  expect(await executeGoatCommand(orchestrator, "root-1", "help", commandOrigin)).toContain("Usage:");
  expect(await executeGoatCommand(orchestrator, "root-1", "doctor", commandOrigin)).toContain("Goat doctor");
  expect(await executeGoatCommand(orchestrator, "root-1", "status", commandOrigin)).toBe("[Goat] No Goal for this Session.");
  model = statusModel("ACTIVE");
  expect(await executeGoatCommand(orchestrator, "root-1", "", commandOrigin)).toContain("Goat: Active");
  model = statusModel("BLOCKED", "approval-not-approved");
  expect(await executeGoatCommand(orchestrator, "root-1", "status", commandOrigin)).toContain("What failed:");
  model = statusModel("COMPLETED");
  expect(await executeGoatCommand(orchestrator, "root-1", "status", commandOrigin)).toContain("Independent verification:");
  expect(await executeGoatCommand(orchestrator, "root-1", "revise", commandOrigin)).toBe("[Goat] Unknown command: revise");

  binding = { role: "root", goal: model.goal };
  expect(await executeGoatCommand(orchestrator, "root-1", "intent", commandOrigin)).toContain("already has an active Goal");
  binding = null;
  expect(await executeGoatCommand(orchestrator, "root-1", "new goal", commandOrigin)).toContain("Goal created");
  expect(await executeGoatCommand(orchestrator, "root-1", "pause", commandOrigin)).toContain("No active Goal");
  binding = { role: "executor", goal: model.goal, run: {} } as SessionBinding;
  expect(await executeGoatCommand(orchestrator, "root-1", "cancel", commandOrigin)).toContain("Child Goat Sessions");
  binding = { role: "root", goal: model.goal };
  resume = { ok: false, error: "stale-lease" };
  expect(await executeGoatCommand(orchestrator, "root-1", "resume", commandOrigin)).toContain("Another Goat process");
  for (const delivery of ["sent", "uncertain"] as const) {
    resume = { ok: true, delivery };
    expect(await executeGoatCommand(orchestrator, "root-1", "resume", commandOrigin)).toContain("Goal is now");
  }
  for (const error of ["active-goal-exists", "goal-not-found", "stale-lease", "run-workspace-missing", "resume-worktree-missing-or-changed", "verification-budget-exhausted", "unexpected-error"]) {
    operation = { ok: false, error };
    expect(await executeGoatCommand(orchestrator, "root-1", "revise change", commandOrigin)).toContain("Check /goat status");
  }
  operation = { ok: true };
  expect(await executeGoatCommand(orchestrator, "root-1", "revise change", commandOrigin)).toContain("Goal is now");
  expect(await executeGoatCommand(orchestrator, "root-1", "pause", commandOrigin)).toContain("Goal is now");
  expect(await executeGoatCommand(orchestrator, "root-1", "cancel", commandOrigin)).toContain("Goal is now");
});

test("small core helpers cover external response shapes and bounded diagnostics", () => {
  expect(classifyExternalError({ status: 404 })).toBe("not-found");
  expect(classifyExternalError({ response: new Response(null, { status: 403 }) })).toBe("rejected");
  expect(classifyExternalError({ data: { statusCode: 422 } })).toBe("rejected");
  expect(classifyExternalError({ data: { statusCode: 500 } })).toBe("unknown");
  expect(classifyExternalError(null)).toBe("unknown");
  expect(isNonTerminal("ACTIVE")).toBe(true);
  expect(isNonTerminal("COMPLETED")).toBe(false);
  expect(agentIdForRole("formulator")).toBe("goat-formulator");
  expect(redact({ values: ["safe", "token=secret"], long: "x".repeat(5_000) })).toMatchObject({ values: ["safe", "[REDACTED]"] });
});
