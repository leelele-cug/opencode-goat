import type { PluginInput } from "@opencode-ai/plugin";
import { OpencodeClient as V2OpencodeClient } from "@opencode-ai/sdk/v2";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import type { NativeQuestionRequest, QuestionPort, SessionCreateInput, SessionIdentity, SessionModel, SessionPermissionRule, SessionPort, ToastPort, ToolRegistryPort, WorkspacePort } from "../core/ports.js";
import { buildSnapshot, canonicalizeDiff, canonicalizeStatus, MAX_WORKSPACE_FILE_BYTES, MAX_WORKSPACE_TOTAL_FILE_BYTES, normalizeWorkspacePath, type WorkspacePlatform } from "../core/workspace.js";

type InjectedClient = PluginInput["client"];
type V2Client = V2OpencodeClient;
function unwrap<T>(value: unknown): T {
  if (!value || typeof value !== "object") return value as T;
  const result = value as { data?: T; error?: unknown; response?: Response };
  if (result.error !== undefined) {
    const error = new Error("OpenCode SDK request failed") as Error & { status?: number; cause?: unknown };
    if (result.response) error.status = result.response.status;
    error.cause = result.error;
    throw error;
  }
  return "data" in result ? result.data as T : value as T;
}

function injectedTransport(client: InjectedClient): object {
  const transport = (client as unknown as { _client?: unknown })._client;
   if (!transport || typeof transport !== "object") throw new Error("OpenCode compatibility check failed: injected SDK transport is unavailable.");
  const value = transport as Record<string, unknown>;
  for (const method of ["get", "post", "patch", "delete", "buildUrl", "getConfig"] as const) {
     if (typeof value[method] !== "function") throw new Error(`OpenCode compatibility check failed: injected transport is missing ${method}.`);
  }
  return transport;
}

export function createOpenCodeAdapters(input: Pick<PluginInput, "client" | "serverUrl" | "directory" | "$">, platform: WorkspacePlatform): { session: SessionPort; workspace: WorkspacePort; question: QuestionPort; registry: ToolRegistryPort; toast: ToastPort } {
  const v2 = new V2OpencodeClient({ client: injectedTransport(input.client) as never });
  const required: readonly [string, unknown][] = [
    ["injected.tui.showToast", input.client.tui.showToast],
    ["v2.session.get", v2.session.get],
    ["v2.session.create", v2.session.create],
    ["v2.session.children", v2.session.children],
    ["session.promptAsync", v2.session.promptAsync],
    ["v2.session.prompt", v2.v2.session.prompt],
    ["v2.session.interrupt", v2.v2.session.interrupt],
    ["v2.session.status", v2.session.status],
    ["v2.session.message", v2.session.message],
    ["v2.session.diff", v2.session.diff],
    ["v2.tool.ids", v2.tool.ids],
    ["v2.worktree.list", v2.worktree.list],
    ["v2.worktree.create", v2.worktree.create],
    ["v2.vcs.status", v2.vcs.status],
    ["v2.vcs.diff", v2.vcs.diff],
    ["v2.question.list", v2.question.list],
    ["v2.question.reject", v2.question.reject],
  ];
  const missing = required.filter(([, value]) => typeof value !== "function").map(([name]) => name);
   if (missing.length > 0) throw new Error(`OpenCode compatibility check failed: missing ${missing.join(", ")}.`);
  return {
    session: createSessionAdapter(v2, platform),
    workspace: createWorkspaceAdapter(v2, input.$, platform),
    question: {
      list: async (directory) => {
        const requests = unwrap<{ id: string; sessionID: string; questions: unknown[]; tool?: { callID?: string } }[]>(await v2.question.list({ directory }));
        return requests.map((request) => ({ id: request.id, sessionId: request.sessionID, questions: request.questions, callId: request.tool?.callID ?? null } satisfies NativeQuestionRequest));
      },
      reject: async (requestId, directory) => { unwrap(await v2.question.reject({ requestID: requestId, directory })); },
    },
    registry: { ids: async (directory) => unwrap<string[]>(await v2.tool.ids({ directory })) },
     toast: { show: async (toast) => { const { directory, ...body } = toast; unwrap(await input.client.tui.showToast({ query: { directory: directory ?? input.directory }, body })); } },
  };
}

function toSessionIdentity(value: { id?: unknown; title?: unknown; projectID?: unknown; workspaceID?: unknown; parentID?: unknown; directory?: unknown; agent?: unknown; model?: unknown; metadata?: unknown }): SessionIdentity {
  if (typeof value.id !== "string" || !value.id) throw new Error("session-returned-no-id");
  if (typeof value.directory !== "string" || !value.directory) throw new Error("session-returned-invalid-metadata");
  const model = value.model as { id?: unknown; providerID?: unknown; variant?: unknown } | null | undefined;
  const sessionModel: SessionModel | null = model && typeof model === "object" && typeof model.id === "string" && typeof model.providerID === "string"
    ? { id: model.id, providerID: model.providerID, ...(typeof model.variant === "string" ? { variant: model.variant } : {}) }
    : null;
  return {
    id: value.id,
    title: typeof value.title === "string" ? value.title : null,
    projectID: typeof value.projectID === "string" ? value.projectID : "",
    workspaceID: typeof value.workspaceID === "string" ? value.workspaceID : null,
    parentID: typeof value.parentID === "string" ? value.parentID : null,
    directory: value.directory,
    agent: typeof value.agent === "string" ? value.agent : null,
    model: sessionModel,
    metadata: value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : null,
  };
}

function createSessionAdapter(client: V2Client, _platform: WorkspacePlatform): SessionPort {
  return {
    create: async (input: SessionCreateInput) => {
      if (!input.directory) throw new Error("session-directory-required");
      const request: Record<string, unknown> = { directory: input.directory };
      if (input.parentID !== undefined) request.parentID = input.parentID;
      if (input.title !== undefined) request.title = input.title;
      if (input.agent !== undefined) request.agent = input.agent;
      if (input.model !== undefined) request.model = input.model;
      if (input.metadata !== undefined) request.metadata = input.metadata;
      if (input.permission !== undefined) request.permission = input.permission as unknown as SessionPermissionRule[];
      const created = unwrap<{ id: string }>(await client.session.create(request));
      if (!created?.id) throw new Error("session-create-returned-no-id");
      return getIdentity(client, created.id, input.directory);
    },
    get: async (id, directory) => {
      const identity = getIdentity(client, id, directory);
      return identity;
    },
    children: async (id, directory) => {
      const rows = unwrap<unknown[]>(await client.session.children({ sessionID: id, directory }));
      return rows.map((row) => toSessionIdentity(row as { id?: unknown; title?: unknown; projectID?: unknown; workspaceID?: unknown; parentID?: unknown; directory?: unknown; agent?: unknown; model?: unknown; metadata?: unknown }));
    },
    promptAsync: async (id, body) => {
      if (!body.directory) throw new Error("session-directory-required");
      const request: { sessionID: string; directory: string; parts: unknown[]; messageID?: string; agent?: string; model?: { providerID: string; modelID: string }; variant?: string } = { sessionID: id, directory: body.directory, parts: body.parts };
      if (body.messageID !== undefined) request.messageID = body.messageID;
      if (body.agent !== undefined) request.agent = body.agent;
      if (body.model !== undefined) request.model = body.model;
      if (body.variant !== undefined) request.variant = body.variant;
      unwrap(await client.session.promptAsync(request as Parameters<typeof client.session.promptAsync>[0] as never));
    },
    diff: async (id, directory, messageID) => {
      const request: { sessionID: string; directory: string; messageID?: string } = { sessionID: id, directory };
      if (messageID !== undefined) request.messageID = messageID;
      return unwrap(await client.session.diff(request));
    },
    history: async (id, directory) => unwrap<unknown[]>(await client.session.messages({ sessionID: id, directory })),
    message: async (id, messageId, directory) => unwrap(await client.session.message({ sessionID: id, messageID: messageId, directory })),
    interrupt: async (id) => { unwrap(await client.v2.session.interrupt({ sessionID: id })); },
    status: async (id, directory) => {
      const statuses = unwrap<Record<string, { type?: string }>>(await client.session.status({ directory }));
      const type = statuses[id]?.type;
      return type === "idle" ? "idle" : type ? "busy" : "unknown";
    },
  };
}

async function getIdentity(client: V2Client, id: string, directory: string): Promise<SessionIdentity> {
  const session = unwrap<{ id?: unknown; title?: unknown; projectID?: unknown; workspaceID?: unknown; parentID?: unknown; directory?: unknown; agent?: unknown; model?: unknown; metadata?: unknown }>(await client.session.get({ sessionID: id, directory }));
  if (session.id !== id) throw new Error("session-get-returned-wrong-id");
  return toSessionIdentity(session);
}

function createWorkspaceAdapter(client: V2Client, shell: PluginInput["$"], platform: WorkspacePlatform): WorkspacePort {
  return {
    probeGit: async (cwd) => {
      const output = await shell`git rev-parse --is-inside-work-tree`.cwd(cwd).quiet().nothrow();
      if (output.exitCode !== 0 || output.text().trim() !== "true") return { isGit: false, isClean: false };
      const status = await shell`git status --porcelain=v1`.cwd(cwd).quiet();
      return { isGit: true, isClean: status.text().trim().length === 0 };
    },
    listWorktrees: async (cwd) => unwrap<(string | { name: string; directory: string })[]>(await client.worktree.list({ directory: cwd })).map((item) => typeof item === "string" ? { name: item.split(/[\\/]/).at(-1) ?? item, path: item } : { name: item.name, path: item.directory }),
    createWorktree: async (cwd, name) => {
      const worktree = unwrap<{ directory: string }>(await client.worktree.create({ directory: cwd, worktreeCreateInput: { name } }));
      if (!worktree?.directory) throw new Error("native-worktree-returned-no-directory");
      return {
        path: worktree.directory,
        waitUntilReady: async () => {
          for (let attempt = 0; attempt < 240; attempt += 1) {
            const status = await shell`git rev-parse --is-inside-work-tree`.cwd(worktree.directory).quiet().nothrow();
            if (status.exitCode === 0 && status.text().trim() === "true") return;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          throw new Error("native-worktree-readiness-timeout");
        },
      };
    },
    captureSnapshot: async (cwd) => {
      try {
        const commit = (await shell`git rev-parse HEAD`.cwd(cwd).quiet().text()).trim();
        if (!/^[0-9a-f]{40,64}$/i.test(commit)) throw new Error("git-head-is-not-a-commit");
        const status = canonicalizeStatus(unwrap<unknown>(await client.vcs.status({ directory: cwd })), platform);
        if (!status.ok) throw new Error("workspace-status-invalid");
        const diff = canonicalizeDiff(unwrap<unknown>(await client.vcs.diff({ directory: cwd, mode: "git" })), platform, true);
        if (!diff.ok) throw new Error(diff.code === "patch-missing" ? "workspace-patch-missing" : "workspace-diff-invalid");
        const untracked: { path: string; contentHash: string }[] = [];
        let totalBytes = 0;
        const untrackedOutput = await shell`git ls-files --others --exclude-standard -z`.cwd(cwd).quiet().nothrow();
        if (untrackedOutput.exitCode !== 0) throw new Error("workspace-untracked-list-failed");
        const names = untrackedOutput.text().split("\0").filter((name) => name.length > 0);
        for (const name of names) {
          let normalized: string;
          try { normalized = normalizeWorkspacePath(name, platform); } catch { throw new Error("workspace-untracked-path-invalid"); }
          try {
            const info = await lstat(join(cwd, normalized));
            if (!info.isFile()) throw new Error("workspace-untracked-file-not-regular");
            if (info.size > MAX_WORKSPACE_FILE_BYTES || totalBytes + info.size > MAX_WORKSPACE_TOTAL_FILE_BYTES) throw new Error("workspace-untracked-size-limit");
            const file = Bun.file(join(cwd, normalized));
            const buffer = await file.arrayBuffer();
            totalBytes += buffer.byteLength;
            untracked.push({ path: normalized, contentHash: createHash("sha256").update(new Uint8Array(buffer)).digest("hex") });
          } catch (error) {
            if (error instanceof Error && error.message.startsWith("workspace-untracked-")) throw error;
            throw new Error("workspace-untracked-hash-failed");
          }
        }
        return { ok: true, snapshot: buildSnapshot({ head: commit, status: status.entries, diff: diff.entries, untracked, platform }) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : "workspace-snapshot-capture-failed" };
      }
    },
  };
}
