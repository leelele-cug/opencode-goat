import type { WorkflowState } from "./state.js";
import type { SessionPermissionRule } from "./ports.js";

export const GOAT_AGENT_IDS = ["goat-formulator", "goat-executor", "goat-verifier"] as const;
export type GoatAgentId = (typeof GOAT_AGENT_IDS)[number];

export const REGISTERED_GOAT_TOOL_IDS = [
  "goat_state",
  "goat_contract_propose",
  "goat_evidence_record",
  "goat_completion_propose",
  "goat_block",
  "goat_verifier_report",
] as const;
export type RegisteredGoatToolId = (typeof REGISTERED_GOAT_TOOL_IDS)[number];

export type GoatRole = "formulator" | "executor" | "verifier";

const READ_TOOLS = ["read", "glob", "grep", "list", "lsp", "webfetch", "websearch"] as const;
const WRITE_TOOLS = ["edit", "write", "apply_patch"] as const;
const UNREACHABLE_TOOLS = ["task", "todowrite", "skill"] as const;

export type RoleCapability = {
  readonly role: GoatRole;
  readonly agentId: GoatAgentId;
  readonly mode: "primary" | "subagent";
  readonly genericTools: ReadonlySet<string>;
  readonly writeTools: ReadonlySet<string>;
  readonly goatTools: ReadonlySet<RegisteredGoatToolId>;
  readonly deniedTools: ReadonlySet<string>;
  readonly sessionDeny: readonly SessionPermissionRule[];
  readonly canUseNativeQuestion: boolean;
};

function deny(...pairs: readonly [permission: string, pattern: string][]): readonly SessionPermissionRule[] {
  return pairs.map(([permission, pattern]) => ({ permission, pattern, action: "deny" as const }));
}

const formulatorGeneric: ReadonlySet<string> = new Set([...READ_TOOLS, "question"]);
const executorGeneric: ReadonlySet<string> = new Set([...READ_TOOLS, ...WRITE_TOOLS, "bash"]);
const verifierGeneric: ReadonlySet<string> = new Set([...READ_TOOLS, "bash"]);

export const ROLE_CAPABILITIES: Readonly<Record<GoatRole, RoleCapability>> = {
  formulator: {
    role: "formulator",
    agentId: "goat-formulator",
    mode: "primary",
    genericTools: formulatorGeneric,
    writeTools: new Set(),
    goatTools: new Set<RegisteredGoatToolId>(["goat_state", "goat_contract_propose"]),
    deniedTools: new Set<string>([...WRITE_TOOLS, "bash", ...UNREACHABLE_TOOLS]),
    sessionDeny: [],
    canUseNativeQuestion: true,
  },
  executor: {
    role: "executor",
    agentId: "goat-executor",
    mode: "primary",
    genericTools: executorGeneric,
    writeTools: new Set(WRITE_TOOLS),
    goatTools: new Set<RegisteredGoatToolId>(["goat_state", "goat_evidence_record", "goat_completion_propose", "goat_block"]),
    deniedTools: new Set<string>(["question", ...UNREACHABLE_TOOLS]),
    sessionDeny: deny(["task", "*"], ["question", "*"]),
    canUseNativeQuestion: false,
  },
  verifier: {
    role: "verifier",
    agentId: "goat-verifier",
    mode: "subagent",
    genericTools: verifierGeneric,
    writeTools: new Set(),
    goatTools: new Set<RegisteredGoatToolId>(["goat_state", "goat_verifier_report"]),
    deniedTools: new Set<string>([...WRITE_TOOLS, "question", ...UNREACHABLE_TOOLS]),
    sessionDeny: deny(["edit", "*"], ["write", "*"], ["apply_patch", "*"], ["task", "*"], ["question", "*"]),
    canUseNativeQuestion: false,
  },
};

export function agentIdForRole(role: GoatRole): GoatAgentId {
  return ROLE_CAPABILITIES[role].agentId;
}

export function roleForAgent(agent: string): GoatRole | undefined {
  if (agent === "goat-formulator") return "formulator";
  if (agent === "goat-executor") return "executor";
  if (agent === "goat-verifier") return "verifier";
  return undefined;
}

export function isRegisteredGoatTool(toolId: string): toolId is RegisteredGoatToolId {
  return (REGISTERED_GOAT_TOOL_IDS as readonly string[]).includes(toolId);
}

const GOAT_TOOL_RULES: Readonly<Record<RegisteredGoatToolId, { readonly roles: readonly GoatRole[]; readonly states: readonly WorkflowState[]; readonly mutation: boolean }>> = {
  goat_state: { roles: ["formulator", "executor", "verifier"], states: ["PLANNING", "AWAITING_APPROVAL", "EXECUTING", "VERIFYING", "PAUSED", "BLOCKED"], mutation: false },
  goat_contract_propose: { roles: ["formulator"], states: ["PLANNING"], mutation: true },
  goat_evidence_record: { roles: ["executor"], states: ["EXECUTING"], mutation: true },
  goat_completion_propose: { roles: ["executor"], states: ["EXECUTING"], mutation: true },
  goat_block: { roles: ["executor"], states: ["EXECUTING"], mutation: true },
  goat_verifier_report: { roles: ["verifier"], states: ["VERIFYING"], mutation: true },
};

export type GuardResult = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export type GoatToolAccessContext = {
  readonly toolId: RegisteredGoatToolId;
  readonly state: WorkflowState;
  readonly role: GoatRole;
  readonly sessionBindingMatchesRole: boolean;
  readonly leaseOwned: boolean;
  readonly workspaceMatches: boolean;
};

export function validateGoatToolAccess(context: GoatToolAccessContext): GuardResult {
  const rule = GOAT_TOOL_RULES[context.toolId];
  if (!rule.roles.includes(context.role)) return { allowed: false, reason: `${context.role} cannot call ${context.toolId}.` };
  if (!rule.states.includes(context.state)) return { allowed: false, reason: `${context.toolId} is unavailable while Goal is ${context.state}.` };
  if (!context.sessionBindingMatchesRole) return { allowed: false, reason: "Session is not bound to the required Goat role." };
  if (!context.workspaceMatches) return { allowed: false, reason: "Tool directory or worktree does not match the persisted Goal workspace." };
  if (rule.mutation && !context.leaseOwned) return { allowed: false, reason: "This Goat instance does not own a live lease." };
  return { allowed: true };
}

export function guardGenericTool(state: WorkflowState, role: GoatRole, toolId: string): GuardResult {
  if (isRegisteredGoatTool(toolId)) return { allowed: false, reason: "Registered Goat tools require their role-bound internal validation." };
  const capability = ROLE_CAPABILITIES[role];
  if (!capability.genericTools.has(toolId)) return { allowed: false, reason: `${role} Session cannot call ${toolId}.` };
  if (role === "executor" && state !== "EXECUTING") return { allowed: false, reason: `Executor tools are forbidden while workflow is ${state}.` };
  if (role === "verifier" && state !== "VERIFYING") return { allowed: false, reason: `Verifier tools are forbidden while workflow is ${state}.` };
  if (toolId === "question" && !capability.canUseNativeQuestion) return { allowed: false, reason: `${role} Sessions cannot ask native Questions.` };
  return { allowed: true };
}

export function sessionDenyRules(role: GoatRole): readonly SessionPermissionRule[] {
  return ROLE_CAPABILITIES[role].sessionDeny;
}
