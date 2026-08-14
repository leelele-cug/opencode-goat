import type { Config } from "@opencode-ai/plugin";
import { GOAT_AGENT_IDS, REGISTERED_GOAT_TOOL_IDS, ROLE_CAPABILITIES } from "../core/role-capabilities.js";
import { EXECUTOR_PROMPT, FORMULATOR_PROMPT, VERIFIER_PROMPT } from "./prompts.js";

const PROMPTS: Record<string, string> = {
  "goat-formulator": FORMULATOR_PROMPT,
  "goat-executor": EXECUTOR_PROMPT,
  "goat-verifier": VERIFIER_PROMPT,
};

function fixedAgent(agentId: string): Config["agent"] extends Record<string, infer Agent> | undefined ? Agent : never {
  const role = ROLE_CAPABILITIES[agentId === "goat-formulator" ? "formulator" : agentId === "goat-executor" ? "executor" : "verifier"];
  return {
    mode: role.mode,
    prompt: PROMPTS[agentId],
    tools: Object.fromEntries([...role.genericTools, ...role.goatTools].map((tool) => [tool, true])),
  } as never;
}

export function registerGoatConfig(config: Config): void {
  config.command ??= {};
  if (config.command.goat) throw new Error("/goat command already exists. Goat will not override it.");
  config.command.goat = {
    description: "Contract-driven Goal execution and verification for OpenCode",
    agent: "goat-formulator",
    template: "Process the /goat command exactly. Use Goat tools and native Questions; never edit before Contract approval.",
  };
  config.agent ??= {};
  for (const agentId of GOAT_AGENT_IDS) {
    if (config.agent[agentId]) throw new Error(`Agent ${agentId} is reserved by Goat. Goat will not override it.`);
    config.agent[agentId] = fixedAgent(agentId);
  }
}

export function assertGoatToolRegistration(ids: readonly string[]): void {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  const invalid = REGISTERED_GOAT_TOOL_IDS.flatMap((id) => counts.get(id) === 1 ? [] : [`${id} (${counts.get(id) ?? 0})`]);
  if (invalid.length > 0) throw new Error(`Goat tool registration collision or omission: ${invalid.join(", ")}.`);
}
