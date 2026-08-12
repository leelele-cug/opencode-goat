import type { WorkspaceSnapshot } from "./workspace.js";

export interface Clock { now(): Date; }
export interface IDGenerator { next(): string; }
export const systemClock: Clock = { now: () => new Date() };
export const cryptoIDGenerator: IDGenerator = { next: () => crypto.randomUUID() };

export type SessionModel = { id: string; providerID: string; variant?: string };

export type SessionIdentity = {
  id: string;
  title: string | null;
  projectID: string;
  workspaceID: string | null;
  parentID: string | null;
  directory: string;
  agent: string | null;
  model: SessionModel | null;
  metadata: Record<string, unknown> | null;
};

export type SessionPermissionRule = { permission: string; pattern: string; action: "allow" | "deny" | "ask" };

export function openCodeMessageId(id: string): string {
  return id.startsWith("msg_") ? id : `msg_${id}`;
}

export interface ToastPort {
  show(input: { title?: string; message: string; variant: "info" | "success" | "warning" | "error"; directory?: string }): Promise<void>;
}

export type NativeQuestionRequest = { id: string; sessionId: string; questions: unknown[]; callId: string | null };

export interface QuestionPort {
  list(directory: string): Promise<NativeQuestionRequest[]>;
  reject(requestId: string, directory: string): Promise<void>;
}

export interface ToolRegistryPort {
  ids(directory: string): Promise<string[]>;
}

export type SessionCreateInput = {
  parentID?: string;
  title?: string;
  directory: string;
  model?: SessionModel;
  metadata?: Record<string, unknown>;
  agent?: string;
  permission?: readonly SessionPermissionRule[];
};

export interface SessionPort {
  get(id: string, directory: string): Promise<SessionIdentity>;
  create(input: SessionCreateInput): Promise<SessionIdentity>;
  children(id: string, directory: string): Promise<SessionIdentity[]>;
  promptAsync(id: string, body: { messageID?: string; agent?: string; model?: { providerID: string; modelID: string }; variant?: string; parts: unknown[]; directory: string }): Promise<void>;
  diff(id: string, directory: string, messageID?: string): Promise<unknown>;
  history?(id: string, directory: string): Promise<unknown[]>;
  message(id: string, messageId: string, directory: string): Promise<unknown>;
  interrupt(id: string, directory: string): Promise<void>;
  status(id: string, directory: string): Promise<"idle" | "busy" | "unknown">;
}

export interface WorkspacePort {
  probeGit(cwd: string): Promise<{ isGit: boolean; isClean: boolean }>;
  listWorktrees(cwd: string): Promise<{ name: string; path: string }[]>;
  createWorktree(cwd: string, branch: string): Promise<{ path: string; waitUntilReady(): Promise<void> }>;
  captureSnapshot(cwd: string): Promise<{ ok: true; snapshot: WorkspaceSnapshot } | { ok: false; error: string }>;
}

export type ToolCallContext = {
  toolId: string;
  sessionID: string;
  messageID: string;
  agent: string;
  directory: string;
  worktree: string;
};

export type ExternalErrorKind = "not-found" | "rejected" | "unknown";

export function classifyExternalError(error: unknown): ExternalErrorKind {
  if (!error || typeof error !== "object") return "unknown";
  let status = 0;
  if ("status" in error) status = Number((error as { status?: unknown }).status) || 0;
  else if ("response" in error && (error as { response?: unknown }).response instanceof Response) status = (error as { response: Response }).response.status;
  else if ("data" in error && (error as { data?: unknown }).data && typeof (error as { data: unknown }).data === "object" && "statusCode" in (error as { data: { statusCode?: unknown } }).data) status = Number((error as { data: { statusCode?: unknown } }).data.statusCode) || 0;
  if (status === 404) return "not-found";
  if (status === 400 || status === 403 || status === 422) return "rejected";
  return "unknown";
}
