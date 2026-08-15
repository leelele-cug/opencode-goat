import type { GoatRole } from "../core/role-capabilities.js";

const EXECUTOR_MUTATIONS = new Set(["write", "edit", "apply_patch", "bash"]);

export function requiresLiveLease(role: GoatRole, toolId: string): boolean {
  return role === "executor" ? EXECUTOR_MUTATIONS.has(toolId) : role === "verifier" && toolId === "bash";
}
