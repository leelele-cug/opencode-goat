import { z } from "zod";

export const WorkflowStateSchema = z.enum([
  "PLANNING",
  "AWAITING_APPROVAL",
  "PREPARING",
  "EXECUTING",
  "FINALIZING_EXECUTION",
  "VERIFYING",
  "FINALIZING_VERIFICATION",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
]);
export type WorkflowState = z.infer<typeof WorkflowStateSchema>;

export const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set(["COMPLETED", "CANCELLED"]);
export const NON_TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set([
  "PLANNING",
  "AWAITING_APPROVAL",
  "PREPARING",
  "EXECUTING",
  "FINALIZING_EXECUTION",
  "VERIFYING",
  "FINALIZING_VERIFICATION",
  "PAUSED",
  "BLOCKED",
]);

export const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 10;

const LEGAL_TRANSITIONS: ReadonlyMap<WorkflowState, ReadonlySet<WorkflowState>> = new Map([
  ["PLANNING", new Set(["AWAITING_APPROVAL", "CANCELLED"])],
  ["AWAITING_APPROVAL", new Set(["PREPARING", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["PREPARING", new Set(["EXECUTING", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["EXECUTING", new Set(["FINALIZING_EXECUTION", "PAUSED", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["FINALIZING_EXECUTION", new Set(["VERIFYING", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["VERIFYING", new Set(["FINALIZING_VERIFICATION", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["FINALIZING_VERIFICATION", new Set(["EXECUTING", "COMPLETED", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["PAUSED", new Set(["EXECUTING", "BLOCKED", "PLANNING", "CANCELLED"])],
  ["BLOCKED", new Set(["AWAITING_APPROVAL", "PREPARING", "EXECUTING", "FINALIZING_EXECUTION", "VERIFYING", "FINALIZING_VERIFICATION", "PLANNING", "CANCELLED"])],
  ["COMPLETED", new Set()],
  ["CANCELLED", new Set()],
]);

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isNonTerminal(state: WorkflowState): boolean {
  return NON_TERMINAL_STATES.has(state);
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) throw new TypeError(`Illegal workflow transition: ${from} -> ${to}`);
}

export type WorkflowOwner = "formulator" | "executor" | "verifier" | "orchestrator" | "user" | "none";

export function ownerForState(state: WorkflowState): WorkflowOwner {
  switch (state) {
    case "PLANNING": return "formulator";
    case "EXECUTING": return "executor";
    case "VERIFYING": return "verifier";
    case "PREPARING":
    case "FINALIZING_EXECUTION":
    case "FINALIZING_VERIFICATION": return "orchestrator";
    case "AWAITING_APPROVAL":
    case "PAUSED":
    case "BLOCKED": return "user";
    default: return "none";
  }
}

export function displayStage(state: WorkflowState): string {
  switch (state) {
    case "PLANNING": return "Plan";
    case "AWAITING_APPROVAL": return "Approve";
    case "PREPARING":
    case "EXECUTING":
    case "FINALIZING_EXECUTION": return "Execute";
    case "VERIFYING":
    case "FINALIZING_VERIFICATION": return "Verify";
    case "COMPLETED": return "Done";
    default: return state.charAt(0) + state.slice(1).toLowerCase();
  }
}
