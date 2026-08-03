import { expect, test } from "bun:test";
import type { ToolContext } from "@opencode-ai/plugin";
import { operationKey, toolContext } from "../src/tools/deps.js";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "root-session",
    messageID: "message-1",
    agent: "goat-formulator",
    directory: "C:\\Project",
    worktree: "C:\\Project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
    ...overrides,
  };
}

test("tool contexts carry the exact tool ID and stable operation keys", () => {
  const mapped = toolContext(context(), "goat_contract_propose");
  expect(mapped).toEqual({
    toolId: "goat_contract_propose",
    sessionID: "root-session",
    messageID: "message-1",
    agent: "goat-formulator",
    directory: "C:\\Project",
    worktree: "C:\\Project",
  });
  expect(operationKey("goat_evidence_record", context())).toBe("goat_evidence_record:message-1");
  expect(operationKey("goat_evidence_record", context(), "criterion-a")).toBe("goat_evidence_record:message-1:criterion-a");
  expect(operationKey("goat_evidence_record", context(), "criterion-b")).not.toBe(operationKey("goat_evidence_record", context(), "criterion-a"));
});

test("operation keys are stable across retries of the same tool call", () => {
  expect(operationKey("goat_completion_propose", context({ messageID: "message-1" }))).toBe(operationKey("goat_completion_propose", context({ messageID: "message-1" })));
  expect(operationKey("goat_completion_propose", context({ messageID: "message-1" }))).not.toBe(operationKey("goat_completion_propose", context({ messageID: "message-2" })));
});
