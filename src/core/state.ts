import { z } from "zod";

export const GoalStateSchema = z.enum([
  "FORMING",
  "AWAITING_APPROVAL",
  "ACTIVE",
  "VERIFYING",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
]);
export type GoalState = z.infer<typeof GoalStateSchema>;

export const TERMINAL_STATES: ReadonlySet<GoalState> = new Set(["COMPLETED", "CANCELLED"]);
export const NON_TERMINAL_STATES: ReadonlySet<GoalState> = new Set([
  "FORMING",
  "AWAITING_APPROVAL",
  "ACTIVE",
  "VERIFYING",
  "PAUSED",
  "BLOCKED",
]);

export const DEFAULT_MAX_VERIFICATION_ATTEMPTS = 7;

export function isTerminal(state: GoalState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isNonTerminal(state: GoalState): boolean {
  return NON_TERMINAL_STATES.has(state);
}

const LEGAL_TRANSITIONS: ReadonlyMap<GoalState, ReadonlySet<GoalState>> = new Map([
  ["FORMING", new Set(["AWAITING_APPROVAL", "CANCELLED"])],
  ["AWAITING_APPROVAL", new Set(["ACTIVE", "FORMING", "BLOCKED", "CANCELLED"])],
  ["ACTIVE", new Set(["VERIFYING", "FORMING", "PAUSED", "BLOCKED", "CANCELLED"])],
  ["VERIFYING", new Set(["COMPLETED", "ACTIVE", "FORMING", "BLOCKED", "CANCELLED"])],
  ["PAUSED", new Set(["ACTIVE", "FORMING", "BLOCKED", "CANCELLED"])],
  ["BLOCKED", new Set(["AWAITING_APPROVAL", "ACTIVE", "FORMING", "CANCELLED"])],
  ["COMPLETED", new Set()],
  ["CANCELLED", new Set()],
]);

export function canTransition(from: GoalState, to: GoalState): boolean {
  return LEGAL_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransition(from: GoalState, to: GoalState): void {
  if (!canTransition(from, to)) throw new TypeError(`Illegal Goal transition: ${from} -> ${to}`);
}

export const RunStatusSchema = z.enum([
  "PREPARING",
  "ACTIVE",
  "VERIFYING",
  "PAUSED",
  "BLOCKED",
  "COMPLETED",
  "CANCELLED",
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["PREPARING", "ACTIVE", "VERIFYING", "PAUSED", "BLOCKED"]);
export const RUN_TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set(["COMPLETED", "CANCELLED"]);

const LEGAL_RUN_TRANSITIONS: ReadonlyMap<RunStatus, ReadonlySet<RunStatus>> = new Map([
  ["PREPARING", new Set(["ACTIVE", "BLOCKED", "CANCELLED"])],
  ["ACTIVE", new Set(["VERIFYING", "PAUSED", "BLOCKED", "CANCELLED"])],
  ["VERIFYING", new Set(["COMPLETED", "ACTIVE", "BLOCKED", "CANCELLED"])],
  ["PAUSED", new Set(["ACTIVE", "BLOCKED", "CANCELLED"])],
  ["BLOCKED", new Set(["ACTIVE", "CANCELLED"])],
  ["COMPLETED", new Set()],
  ["CANCELLED", new Set()],
]);

export function canTransitionRun(from: RunStatus, to: RunStatus): boolean {
  return LEGAL_RUN_TRANSITIONS.get(from)?.has(to) ?? false;
}

export function assertTransitionRun(from: RunStatus, to: RunStatus): void {
  if (!canTransitionRun(from, to)) throw new TypeError(`Illegal Run transition: ${from} -> ${to}`);
}
