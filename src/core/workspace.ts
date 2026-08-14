import { z } from "zod";
import { posix, win32 } from "node:path";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
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

export function sortByCanonicalPath(left: string, right: string): number {
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
  /** Retained only at the adapter boundary; raw text is not persisted. */
  rawDiff?: string;
  platform: WorkspacePlatform;
}): WorkspaceSnapshot {
  const status = input.status.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path, input.platform) }));
  const diff = input.diff.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path, input.platform) }));
  const untracked = input.untracked.map((entry) => ({ ...entry, path: normalizeWorkspacePath(entry.path, input.platform) }));
  const snapshot = { schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION, head: input.head, status, diff, untracked };
  return WorkspaceSnapshotSchema.parse({ ...snapshot, digest: canonicalHash(snapshot) });
}

export function isWorkspaceClean(snapshot: WorkspaceSnapshot): boolean {
  return snapshot.status.length === 0 && snapshot.diff.length === 0 && snapshot.untracked.length === 0;
}

export function hasSameSnapshotDigest(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
  return left.head === right.head && left.digest === right.digest;
}

function indexDiffEntries(entries: readonly CanonicalDiffEntry[]): Map<string, CanonicalDiffEntry> {
  const result = new Map<string, CanonicalDiffEntry>();
  for (const entry of entries) {
    if (result.has(entry.path)) throw new TypeError(`duplicate diff path ${entry.path}`);
    result.set(entry.path, entry);
  }
  return result;
}

function sameDiffEntry(left: CanonicalDiffEntry, right: CanonicalDiffEntry): boolean {
  if (left.path !== right.path || left.status !== right.status || left.additions !== right.additions || left.deletions !== right.deletions) return false;
  if (left.status === "added") return true;
  return comparablePatch(left.patch) === comparablePatch(right.patch);
}

function comparablePatch(patch: string): string {
  return patch.replace(/\r\n/g, "\n").split("\n").filter((line) => !line.startsWith("diff --git ") && !line.startsWith("index ") && !line.startsWith("new file mode ") && !line.startsWith("deleted file mode ") && !line.startsWith("old mode ") && !line.startsWith("new mode ") && !line.startsWith("similarity index ") && !line.startsWith("rename from ") && !line.startsWith("rename to ") && !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("@@ ")).join("\n").replace(/\n+$/, "");
}

export function canonicalizeExecutorDiff(value: unknown, platform: WorkspacePlatform): { ok: true; entries: readonly CanonicalDiffEntry[] } | { ok: false; code: "invalid-diff-shape" | "patch-missing" | "patch-too-large" } {
  return canonicalizeDiff(value, platform, true);
}

export type WorkspaceComparison =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "head-changed" | "unattributed-change" | "attribution-incomplete"; readonly detail: string };

export function validateWorkspaceToolArguments(toolId: string, args: unknown, directory: string, platform: WorkspacePlatform): { ok: true } | { ok: false; error: string } {
  // Bash remains governed by OpenCode's native permission resolver. Goat can
  // constrain file-oriented tools, but cannot infer every command side effect.
  if (toolId === "bash") return { ok: true };
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

export function assertSnapshotUnchanged(expected: WorkspaceSnapshot, observed: WorkspaceSnapshot): WorkspaceComparison {
  if (!hasSameSnapshotDigest(expected, observed)) return { ok: false, code: "unattributed-change", detail: "Workspace changed while the Run was paused or being verified." };
  return { ok: true };
}

export function assertExecutorOwnsSnapshot(baseline: WorkspaceSnapshot, current: WorkspaceSnapshot, executorDiff: readonly CanonicalDiffEntry[]): WorkspaceComparison {
  if (baseline.head !== current.head) return { ok: false, code: "head-changed", detail: `HEAD moved from ${baseline.head.slice(0, 12)} to ${current.head.slice(0, 12)}.` };
  let executor: Map<string, CanonicalDiffEntry>;
  let baselineDiff: Map<string, CanonicalDiffEntry>;
  let currentDiff: Map<string, CanonicalDiffEntry>;
  let baselineStatus: Map<string, CanonicalStatusEntry>;
  let currentStatus: Map<string, CanonicalStatusEntry>;
  try {
    executor = indexDiffEntries(executorDiff);
    baselineDiff = indexDiffEntries(baseline.diff);
    currentDiff = indexDiffEntries(current.diff);
    baselineStatus = indexStatusEntries(baseline.status);
    currentStatus = indexStatusEntries(current.status);
  } catch (error) {
    return { ok: false, code: "attribution-incomplete", detail: error instanceof Error ? error.message : "duplicate workspace diff path" };
  }
  for (const [path, finalEntry] of currentStatus) {
    const baselineEntry = baselineStatus.get(path);
    if (baselineEntry && sameStatusEntry(baselineEntry, finalEntry)) continue;
    const attributed = executor.get(path);
    if (!attributed || attributed.status !== finalEntry.status) return { ok: false, code: "unattributed-change", detail: `Final status change to ${path} is not explained by the Executor Session diff.` };
  }
  for (const path of baselineStatus.keys()) {
    if (currentStatus.has(path)) continue;
    const attributed = executor.get(path);
    if (!attributed || attributed.status !== "deleted") return { ok: false, code: "unattributed-change", detail: `Removal of status entry ${path} is not explained by the Executor Session diff.` };
  }
  for (const [path, finalEntry] of currentDiff) {
    const baselineEntry = baselineDiff.get(path);
    if (baselineEntry && sameDiffEntry(baselineEntry, finalEntry)) continue;
    const attributed = executor.get(path);
    if (!attributed || !sameDiffEntry(attributed, finalEntry)) return { ok: false, code: "unattributed-change", detail: `Final change to ${path} is not explained by the Executor Session diff.` };
  }
  for (const path of baselineDiff.keys()) {
    if (currentDiff.has(path)) continue;
    const attributed = executor.get(path);
    if (!attributed || attributed.status !== "deleted") return { ok: false, code: "unattributed-change", detail: `Removal of ${path} is not explained by the Executor Session diff.` };
  }
  const baselineUntracked = new Map(baseline.untracked.map((entry) => [entry.path, entry.contentHash]));
  const currentUntracked = new Map(current.untracked.map((entry) => [entry.path, entry.contentHash]));
  for (const [path, contentHash] of currentUntracked) {
    if (baselineUntracked.get(path) === contentHash) continue;
    const attributed = executor.get(path);
    if (!attributed || attributed.status !== "added" || addedPatchContentHash(attributed.patch) !== contentHash) return { ok: false, code: "attribution-incomplete", detail: `Untracked file ${path} is not attributed to the Executor Session.` };
  }
  for (const path of baselineUntracked.keys()) {
    if (currentUntracked.has(path)) continue;
    const attributed = executor.get(path);
    if (!attributed || attributed.status !== "deleted") return { ok: false, code: "attribution-incomplete", detail: `Removed untracked file ${path} is not attributed to the Executor Session.` };
  }
  return { ok: true };
}

export function addedPatchContentHash(patch: string | undefined): string | undefined {
  if (patch === undefined) return undefined;
  const lines = patch.split(/\r?\n/);
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  if (added.length === 0) return undefined;
  const content = added.map((line) => line.slice(1)).join("\n") + (patch.includes("\\ No newline at end of file") ? "" : "\n");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function indexStatusEntries(entries: readonly CanonicalStatusEntry[]): Map<string, CanonicalStatusEntry> {
  const result = new Map<string, CanonicalStatusEntry>();
  for (const entry of entries) {
    if (result.has(entry.path)) throw new TypeError(`duplicate status path ${entry.path}`);
    result.set(entry.path, entry);
  }
  return result;
}

function sameStatusEntry(left: CanonicalStatusEntry, right: CanonicalStatusEntry): boolean {
  return left.path === right.path && left.status === right.status && left.additions === right.additions && left.deletions === right.deletions;
}
