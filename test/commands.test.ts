import { expect, test } from "bun:test";
import { parseGoatCommand } from "../src/opencode/commands.js";
import type { Config } from "@opencode-ai/plugin";
import { assertGoatToolRegistration, registerGoatConfig } from "../src/opencode/config.js";
import { REGISTERED_GOAT_TOOL_IDS, ROLE_CAPABILITIES } from "../src/core/role-capabilities.js";

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
