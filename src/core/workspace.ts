import { posix, win32 } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { z } from "zod";
import { canonicalHash } from "./canonical.js";

export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const MAX_WORKSPACE_ENTRIES = 20_000;
export const MAX_WORKSPACE_PATCH_CHARS = 5_000_000;
export const MAX_WORKSPACE_FILE_BYTES = 25_000_000;
export const MAX_WORKSPACE_TOTAL_FILE_BYTES = 100_000_000;

export type WorkspacePlatform = "win32" | "darwin" | "linux";

const ChangeStatusSchema = z.enum(["added", "deleted", "modified"]);

export const CanonicalStatusEntrySchema = z.object({
  path: z.string().min(1),
  status: ChangeStatusSchema,
  additions: z.number().int().nonnegative().finite(),
  deletions: z.number().int().nonnegative().finite(),
}).strict().readonly();
export type CanonicalStatusEntry = z.infer<typeof CanonicalStatusEntrySchema>;

export const CanonicalDiffEntrySchema = z.object({
  path: z.string().min(1),
  status: ChangeStatusSchema,
  additions: z.number().int().nonnegative().finite(),
  deletions: z.number().int().nonnegative().finite(),
  patch: z.string().max(MAX_WORKSPACE_PATCH_CHARS),
}).strict().readonly();
export type CanonicalDiffEntry = z.infer<typeof CanonicalDiffEntrySchema>;

export const UntrackedEntrySchema = z.object({
  path: z.string().min(1),
  contentHash: z.string().length(64),
}).strict().readonly();
export type UntrackedEntry = z.infer<typeof UntrackedEntrySchema>;

export const WorkspaceSnapshotSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_SNAPSHOT_SCHEMA_VERSION),
  head: z.string().regex(/^[0-9a-f]{40,64}$/i),
  status: z.array(CanonicalStatusEntrySchema).max(MAX_WORKSPACE_ENTRIES),
  diff: z.array(CanonicalDiffEntrySchema).max(MAX_WORKSPACE_ENTRIES),
  untracked: z.array(UntrackedEntrySchema).max(MAX_WORKSPACE_ENTRIES),
  digest: z.string().length(64),
}).strict().readonly();
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;

export function normalizeWorkspacePath(path: string, platform: WorkspacePlatform): string {
  const cleaned = platform === "win32"
    ? path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").replace(/\/+/g, "/")
    : path.replace(/^\.\//, "").replace(/\/+$/, "").replace(/\/+/g, "/");
  if (!cleaned || cleaned.startsWith("/") || /^[a-zA-Z]:\//.test(cleaned) || cleaned.split("/").includes("..")) throw new TypeError(`invalid workspace path: ${path}`);
  return platform === "win32" ? cleaned.toLowerCase() : cleaned;
}

function sortByCanonicalPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

export function canonicalizeStatus(value: unknown, platform: WorkspacePlatform): { ok: true; entries: readonly CanonicalStatusEntry[] } | { ok: false; code: "invalid-status-shape" } {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_ENTRIES) return { ok: false, code: "invalid-status-shape" };
  const entries: CanonicalStatusEntry[] = [];
  const seen = new Set<string>();
  try {
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, code: "invalid-status-shape" };
      const record = item as Record<string, unknown>;
      if (typeof record.file !== "string" || typeof record.status !== "string" || !validCount(record.additions) || !validCount(record.deletions) || !ChangeStatusSchema.safeParse(record.status).success) return { ok: false, code: "invalid-status-shape" };
      const path = normalizeWorkspacePath(record.file, platform);
      if (seen.has(path)) return { ok: false, code: "invalid-status-shape" };
      seen.add(path);
      entries.push({ path, status: record.status as CanonicalStatusEntry["status"], additions: record.additions, deletions: record.deletions });
    }
  } catch { return { ok: false, code: "invalid-status-shape" }; }
  entries.sort((left, right) => sortByCanonicalPath(left.path, right.path));
  return { ok: true, entries };
}

export function canonicalizeDiff(value: unknown, platform: WorkspacePlatform, requirePatch = true): { ok: true; entries: readonly CanonicalDiffEntry[] } | { ok: false; code: "invalid-diff-shape" | "patch-missing" | "patch-too-large" } {
  if (!Array.isArray(value) || value.length > MAX_WORKSPACE_ENTRIES) return { ok: false, code: "invalid-diff-shape" };
  const entries: CanonicalDiffEntry[] = [];
  const seen = new Set<string>();
  let patchChars = 0;
  try {
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return { ok: false, code: "invalid-diff-shape" };
      const record = item as Record<string, unknown>;
      if (typeof record.file !== "string" || typeof record.status !== "string" || !validCount(record.additions) || !validCount(record.deletions) || !ChangeStatusSchema.safeParse(record.status).success) return { ok: false, code: "invalid-diff-shape" };
      const path = normalizeWorkspacePath(record.file, platform);
      if (seen.has(path)) return { ok: false, code: "invalid-diff-shape" };
      const patch = record.patch === undefined || record.patch === null ? "" : typeof record.patch === "string" ? record.patch : "";
      if (requirePatch && patch.length === 0 && record.status !== "deleted") return { ok: false, code: "patch-missing" };
      patchChars += patch.length;
      if (patchChars > MAX_WORKSPACE_PATCH_CHARS) return { ok: false, code: "patch-too-large" };
      seen.add(path);
      entries.push({ path, status: record.status as CanonicalDiffEntry["status"], additions: record.additions, deletions: record.deletions, patch });
    }
  } catch { return { ok: false, code: "invalid-diff-shape" }; }
  entries.sort((left, right) => sortByCanonicalPath(left.path, right.path));
  return { ok: true, entries };
}

export function buildSnapshot(input: {
  head: string;
  status: readonly CanonicalStatusEntry[];
  diff: readonly CanonicalDiffEntry[];
  untracked: readonly UntrackedEntry[];
  platform: WorkspacePlatform;
}): WorkspaceSnapshot {
  const status = input.status.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path, input.platform) })).sort((a, b) => sortByCanonicalPath(a.path, b.path));
  const diff = input.diff.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path, input.platform) })).sort((a, b) => sortByCanonicalPath(a.path, b.path));
  const untracked = input.untracked.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path, input.platform) })).sort((a, b) => sortByCanonicalPath(a.path, b.path));
  const snapshot = { schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION, head: input.head, status, diff, untracked };
  return WorkspaceSnapshotSchema.parse({ ...snapshot, digest: canonicalHash(snapshot) });
}

export function parseWorkspaceSnapshot(value: unknown): WorkspaceSnapshot {
  const parsed = WorkspaceSnapshotSchema.parse(value);
  const { digest, ...content } = parsed;
  const expected = canonicalHash(content);
  if (digest !== expected) throw new TypeError("workspace snapshot digest mismatch");
  return parsed;
}

export function isWorkspaceClean(snapshot: WorkspaceSnapshot): boolean {
  return snapshot.status.length === 0 && snapshot.diff.length === 0 && snapshot.untracked.length === 0;
}

export function hasSameSnapshotDigest(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return left.head === right.head && left.digest === right.digest;
}

export type WorkspaceComparison =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "head-changed" | "workspace-changed"; readonly detail: string };

export function assertSnapshotUnchanged(expected: WorkspaceSnapshot, observed: WorkspaceSnapshot): WorkspaceComparison {
  if (expected.head !== observed.head) return { ok: false, code: "head-changed", detail: `HEAD moved from ${expected.head.slice(0, 12)} to ${observed.head.slice(0, 12)}.` };
  if (expected.digest !== observed.digest) return { ok: false, code: "workspace-changed", detail: "Git-visible worktree state changed while it was paused or being verified." };
  return { ok: true };
}

export function assertHeadUnchanged(expected: WorkspaceSnapshot, observed: WorkspaceSnapshot): WorkspaceComparison {
  return expected.head === observed.head ? { ok: true } : { ok: false, code: "head-changed", detail: `HEAD moved from ${expected.head.slice(0, 12)} to ${observed.head.slice(0, 12)}.` };
}

export function validateWorkspaceToolArguments(toolId: string, args: unknown, directory: string, platform: WorkspacePlatform): { ok: true } | { ok: false; error: string } {
  if (toolId === "bash") {
    if (!args || typeof args !== "object") return { ok: false, error: "workspace-command-missing" };
    const record = args as Record<string, unknown>;
    const command = typeof record.command === "string" ? record.command : typeof record.cmd === "string" ? record.cmd : undefined;
    if (!command?.trim()) return { ok: false, error: "workspace-command-missing" };
    const workdir = typeof record.workdir === "string" ? record.workdir : typeof record.cwd === "string" ? record.cwd : undefined;
    if (workdir && !isWorkspaceTarget(workdir, directory, platform)) return { ok: false, error: "workspace-target-outside-approved-directory" };
    if (/(?:^|[;&|]\s*|\b(?:sudo|env)\s+)git\s+(?:commit|checkout|switch|reset|merge|rebase|push|pull|cherry-pick|revert|clean|worktree)(?:\s|$)/i.test(command)) return { ok: false, error: "git-lifecycle-command-forbidden" };
    if (/(?:^|[;&|]\s*)(?:cd|pushd|popd)\b/i.test(command) || /(?:^|[\\/])\.git(?:[\\/]|$)/i.test(command)) return { ok: false, error: "workspace-shell-boundary-forbidden" };
    return { ok: true };
  }
  if (toolId === "write" || toolId === "edit") {
    if (!args || typeof args !== "object") return { ok: false, error: "workspace-target-missing" };
    const record = args as Record<string, unknown>;
    const value = typeof record.filePath === "string" ? record.filePath : typeof record.path === "string" ? record.path : undefined;
    return value && isWorkspaceTarget(value, directory, platform) ? { ok: true } : { ok: false, error: "workspace-target-outside-approved-directory" };
  }
  if (toolId === "apply_patch") {
    if (!args || typeof args !== "object") return { ok: false, error: "workspace-patch-missing" };
    const record = args as Record<string, unknown>;
    const patch = typeof record.patch === "string" ? record.patch : typeof record.patchText === "string" ? record.patchText : undefined;
    if (!patch) return { ok: false, error: "workspace-patch-missing" };
    const paths = [
      ...[...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]?.trim()),
      ...[...patch.matchAll(/^\*\*\* Move to: (.+)$/gm)].map((match) => match[1]?.trim()),
    ].filter((value): value is string => !!value);
    if (paths.length === 0 || paths.some((value) => !isWorkspaceTarget(value, directory, platform))) return { ok: false, error: "workspace-target-outside-approved-directory" };
  }
  return { ok: true };
}

function isWorkspaceTarget(value: string, directory: string, platform: WorkspacePlatform): boolean {
  if (!value || value.includes("\0")) return false;
  const path = platform === "win32" ? win32 : posix;
  const root = path.resolve(directory);
  const candidate = path.resolve(root, value);
  const relative = path.relative(root, candidate);
  if (!(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)))) return false;
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment.toLowerCase() === ".git")) return false;
  try {
    const realRoot = realpathSync(root);
    const existing = nearestExistingPath(candidate, path);
    if (existing && hasSymlinkComponent(root, existing, path)) return false;
    const realCandidate = existing ? path.resolve(realpathSync(existing), path.relative(existing, candidate)) : candidate;
    const realRelative = path.relative(realRoot, realCandidate);
    return realRelative === "" || (!realRelative.startsWith("..") && !path.isAbsolute(realRelative));
  } catch {
    return false;
  }
}

function nearestExistingPath(candidate: string, path: typeof posix | typeof win32): string | undefined {
  let current = candidate;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return current;
}

function hasSymlinkComponent(root: string, existing: string, path: typeof posix | typeof win32): boolean {
  let current = root;
  while (true) {
    if (lstatSync(current).isSymbolicLink()) return true;
    if (current === existing) return false;
    const next = path.join(current, path.relative(current, existing).split(/[\\/]/)[0] ?? "");
    if (next === current) return false;
    current = next;
  }
}
