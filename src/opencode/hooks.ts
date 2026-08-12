import type { Config, Hooks } from "@opencode-ai/plugin";
import { GoatError } from "../core/errors.js";
import { isRegisteredGoatTool } from "../core/role-capabilities.js";
import type { SessionPort, ToolRegistryPort } from "../core/ports.js";
import { persistedPath } from "../store/store.js";
import { assertGoatToolRegistration, registerGoatConfig } from "./config.js";
import { executeGoatCommand } from "./commands.js";
import type { Orchestrator } from "../runtime/orchestrator.js";
import type { GoalOrigin } from "../runtime/process-context.js";

export function createHooks(
  orchestrator: Orchestrator,
  session: SessionPort,
  registry: ToolRegistryPort,
  origin: GoalOrigin,
  onConfigRegistered?: () => void,
): Hooks {
  let goatConfigRegistered = false;
  let toolRegistrationCheck: Promise<void> | undefined;
  const checkToolRegistration = (): Promise<void> => toolRegistrationCheck ??= registry.ids(origin.projectDirectory).then(assertGoatToolRegistration);
  return {
    config: async (config: Config) => { registerGoatConfig(config); goatConfigRegistered = true; onConfigRegistered?.(); },
    "command.execute.before": async (input, output) => {
      if (input.command !== "goat" || !goatConfigRegistered) return;
      await checkToolRegistration();
      const parsed = parseCommandForObservation(input.arguments);
      if (!(await isRootSession(session, input.sessionID, origin)) && !parsed) {
        output.parts.push({ type: "text", text: "[Goat] Mutating commands require the originating root Session." } as never);
        return;
      }
       const text = await executeGoatCommand(orchestrator, input.sessionID, input.arguments, origin);
      output.parts.push({ type: "text", text } as never);
    },
    "tool.execute.before": async (input, output) => {
      if (isRegisteredGoatTool(input.tool) && goatConfigRegistered) await checkToolRegistration();
       const decision = await orchestrator.guardGenericToolCall(input.sessionID, input.tool, input.callID, output.args, origin.projectDirectory);
      if (!decision.allowed) throw denial(input.tool, input.sessionID, input.callID, decision.error);
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "question") return;
      await orchestrator.handleQuestionAfter(input.sessionID, input.callID, output.metadata, output.output);
    },
    event: async ({ event }) => {
      const value = event as { type?: string; properties?: Record<string, unknown> };
      const properties = value.properties ?? {};
      const sessionId = typeof properties.sessionID === "string" ? properties.sessionID : undefined;
      const requestId = typeof properties.requestID === "string" ? properties.requestID : undefined;
      const messageId = typeof properties.messageID === "string" ? properties.messageID : undefined;
      switch (value.type) {
        case "question.asked":
        case "question.replied": {
          if (sessionId) {
            const binding = orchestrator.getBindingForSession(sessionId);
            const answers = Array.isArray(properties.answers) ? properties.answers : undefined;
            if (answers && requestId) await orchestrator.handleQuestionAfter(sessionId, requestId, { answers }, "");
            else if (binding) await orchestrator.reconcileApproval(binding.goal.goalId);
          }
          return;
        }
        case "question.rejected": {
          if (sessionId && requestId) await orchestrator.handleQuestionRejected(sessionId, requestId);
          return;
        }
        case "session.next.prompted": {
          if (sessionId && messageId) await orchestrator.handlePrompted(sessionId, messageId);
          return;
        }
        case "message.updated": {
          if (sessionId) await orchestrator.handleMessageUpdated(sessionId, properties.info);
          return;
        }
        case "session.idle": {
          if (sessionId) await orchestrator.handleSessionIdle(sessionId);
          return;
        }
        case "session.error": {
          if (sessionId) await orchestrator.handleSessionError(sessionId);
          return;
        }
        case "worktree.ready": {
          const name = typeof properties.name === "string" ? properties.name : undefined;
          if (name) await orchestrator.handleWorktreeReady(name);
          return;
        }
        case "worktree.failed": {
          await orchestrator.handleWorktreeFailed();
          return;
        }
        default:
          return;
      }
    },
    "experimental.session.compacting": async (input, output) => {
      const binding = orchestrator.getBindingForSession(input.sessionID);
      if (!binding) return;
      const goal = binding.goal;
      const run = binding.role === "root" ? undefined : binding.run;
      const evidence = run ? orchestrator.getEvidenceForCompaction(goal.goalId, run.runId) : [];
      const revision = goal.currentRevision === null ? undefined : orchestrator.getRevisionForCompaction(goal.goalId, goal.currentRevision);
      const must = revision?.criteria.filter((criterion) => criterion.priority === "must") ?? [];
      const covered = new Set(evidence.map((item) => item.criterionId));
      output.context.push(`Goat durable state: Goal ${goal.goalId}; state ${goal.state}; approved revision ${goal.approvedRevisionHash ?? "none"}; outcome ${revision?.body.outcome ?? goal.sourceRequest}; constraints ${revision?.body.constraints.join("; ") || "none"}; workspace ${run?.workspacePath ?? "not active"}; MUST evidence ${must.filter((criterion) => covered.has(criterion.id)).length}/${must.length}; verification attempt ${run?.verificationAttempts ?? 0}; blocker ${goal.blocker ?? "none"}.`);
    },
    "experimental.compaction.autocontinue": async (input, output) => { if (orchestrator.getBindingForSession(input.sessionID)) output.enabled = false; },
  };
}

function parseCommandForObservation(arguments_: string): boolean {
  const value = arguments_.trim().toLowerCase();
  return value === "" || value === "status" || value === "help" || value === "doctor";
}

async function isRootSession(session: SessionPort, sessionID: string, origin: { readonly projectDirectory: string }): Promise<boolean> {
  try {
    const metadata = await session.get(sessionID, origin.projectDirectory);
    return !metadata.parentID && persistedPath(metadata.directory) === persistedPath(origin.projectDirectory);
  } catch {
    return false;
  }
}

function denial(tool: string, sessionID: string, callID: string, message: string): GoatError {
  return new GoatError({ tag: "lifecycle-denial", toolId: tool, sessionId: sessionID, callId: callID, message });
}
