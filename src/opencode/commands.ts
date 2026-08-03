import type { Orchestrator } from "../runtime/orchestrator.js";
import { renderBlocked, renderCompleted, renderConcise, renderDetailed, renderHelp } from "../presentation.js";

export type GoatCommand =
  | { type: "intent"; intent: string }
  | { type: "status"; detailed: boolean }
  | { type: "help" | "pause" | "resume" | "cancel" }
  | { type: "revise"; change: string }
  | { type: "unknown"; raw: string };

export function parseGoatCommand(input: string): GoatCommand {
  const value = input.trim(); if (!value) return { type: "status", detailed: false };
  const lower = value.toLowerCase();
  if (lower === "status") return { type: "status", detailed: true };
  if (lower === "help") return { type: "help" };
  if (lower === "pause") return { type: "pause" };
  if (lower === "resume") return { type: "resume" };
  if (lower === "cancel") return { type: "cancel" };
  if (lower === "revise") return { type: "unknown", raw: value };
  if (lower.startsWith("revise ")) return { type: "revise", change: value.slice(7).trim() };
  return { type: "intent", intent: value };
}

export async function executeGoatCommand(orchestrator: Orchestrator, sessionId: string, arguments_: string): Promise<string> {
  const command = parseGoatCommand(arguments_);
  if (command.type === "help") return renderHelp();
  if (command.type === "status") {
    const model = orchestrator.getStatusReadModel(sessionId);
    if (!model) return "[Goat] No Goal for this Session.";
    if (model.goal.state === "BLOCKED") return renderBlocked(model);
    if (model.goal.state === "COMPLETED") return renderCompleted(model);
    return command.detailed ? renderDetailed(model) : renderConcise(model);
  }
  if (command.type === "unknown") return `[Goat] Unknown command: ${command.raw}`;
  if (command.type === "intent") {
    const model = orchestrator.getBindingForSession(sessionId);
    if (model) return "[Goat] This Session already has an active Goal. Use /goat status, revise, cancel, or a new Session.";
    const created = await orchestrator.createGoal({ sourceRequest: command.intent, rootSessionId: sessionId });
    return created.ok ? `Goal created. Discovery is read-only and will now operationalize: ${command.intent}` : `[Goat] Could not create Goal: ${created.error}.`;
  }
  const binding = orchestrator.getBindingForSession(sessionId);
  if (!binding) return "[Goat] No active Goal for this Session.";
  if (binding.role !== "root") return "[Goat] Child Goat Sessions cannot control the Goal. Use the root Session for pause, resume, revise, or cancel.";
  const goalId = binding.goal.goalId;
  if (command.type === "resume") {
    const resumed = await orchestrator.resume(goalId);
    if (!resumed.ok) return `[Goat] ${resumed.error}. No state change was committed.`;
    const delivery = resumed.delivery === "sent" ? "" : ` Dispatch delivery is ${resumed.delivery}; durable state was preserved for recovery.`;
    return `[Goat] Goal is now ${orchestrator.getBindingForSession(sessionId)?.goal.state ?? "updated"}.${delivery}`;
  }
  let result;
  if (command.type === "revise") result = await orchestrator.revise(goalId, command.change);
  else if (command.type === "pause") result = await orchestrator.pause(goalId);
  else if (command.type === "cancel") result = await orchestrator.cancel(goalId);
  else result = { ok: false as const, error: "unknown-command" };
  if (!result.ok) return `[Goat] ${result.error}. No state change was committed.`;
  return `[Goat] Goal is now ${orchestrator.getBindingForSession(sessionId)?.goal.state ?? "updated"}.`;
}
