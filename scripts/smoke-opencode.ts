import { createOpencode, createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2";
import { randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const bunExecutable = Bun.which("bun") ?? process.execPath;
const timeoutMs = Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 300_000);
const envKeys = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG_CONTENT", "OPENCODE_GOAT_HOME", "OPENCODE_SERVER_USERNAME", "OPENCODE_SERVER_PASSWORD"] as const;
const smokeModel = process.env.OPENCODE_SMOKE_MODEL ?? "Ark/deepseek-v4-flash";
const smokeModelSeparator = smokeModel.indexOf("/");
if (smokeModelSeparator <= 0 || smokeModelSeparator === smokeModel.length - 1) throw new Error(`OPENCODE_SMOKE_MODEL must be provider/model, received ${smokeModel}`);
const smokeProvider = smokeModel.slice(0, smokeModelSeparator);
const smokeModelID = smokeModel.slice(smokeModelSeparator + 1);

async function packTarball(workspaceRoot: string): Promise<{ path: string; owned: boolean }> {
  const supplied = process.env.GOAT_PACKAGE_SMOKE_TARBALL;
  if (supplied) {
    await readFile(supplied);
    return { path: supplied, owned: false };
  }
  await execFileAsync(bunExecutable, ["pm", "pack", "--no-progress"], { cwd: workspaceRoot, windowsHide: true, timeout: 120_000 });
  const manifest = JSON.parse(await readFile(join(workspaceRoot, "package.json"), "utf8")) as { name: string; version: string };
  return { path: join(workspaceRoot, `${manifest.name}-${manifest.version}.tgz`), owned: true };
}

async function expectUnauthorized(client: OpencodeClient, directory: string): Promise<void> {
  try {
    const result = await withTimeout("unauthenticated config", client.config.get({ directory }));
    if (result.error !== undefined && (result.response?.status === 401 || result.response?.status === 403)) {
      process.stdout.write("smoke unauthenticated access rejected as required\n");
      return;
    }
  } catch (error) {
    const message = safeString(error);
    if (/401|Unauthorized|authentication/i.test(message)) {
      process.stdout.write("smoke unauthenticated access rejected as required\n");
      return;
    }
  }
  throw new Error("unauthenticated OpenCode access was accepted; the smoke gate requires server authentication");
}

type SmokeCase = {
  readonly name: string;
  readonly intent: string;
  readonly file: string;
  readonly content: string;
  readonly workspace: "current" | "worktree";
};
type SmokeWorktree = string | { name?: string; directory?: string };

const cases: readonly SmokeCase[] = [
  {
    name: "current",
    intent: "Deterministic smoke contract: immediately call goat_state and goat_contract_propose without repository exploration. Use the current workspace. Define exactly one MUST criterion: add smoke-current.txt with exactly CURRENT_SMOKE_OK followed by one LF newline, verified by one inspection step that reads the file. Use only OpenCode native tools, never filesystem_* or MCP tools. Do not add any other criteria, commands, scope, or questions except the exact approval Question.",
    file: "smoke-current.txt",
    content: "CURRENT_SMOKE_OK\n",
    workspace: "current",
  },
  {
    name: "worktree",
    intent: "Deterministic smoke contract: immediately call goat_state and goat_contract_propose without repository exploration. You MUST use the native isolated Git worktree already prepared by Goat, not the current workspace. Define exactly one MUST criterion: add smoke-worktree.txt with exactly WORKTREE_SMOKE_OK followed by one LF newline, verified by one inspection step that reads the file. Use only OpenCode native tools, never filesystem_* or MCP tools. Do not add any other criteria, commands, scope, or questions except the exact approval Question.",
    file: "smoke-worktree.txt",
    content: "WORKTREE_SMOKE_OK\n",
    workspace: "worktree",
  },
];

function unwrap<T>(value: unknown): T {
  if (!value || typeof value !== "object") return value as T;
  const result = value as { data?: T; error?: unknown };
  if (result.error !== undefined) throw new Error(`OpenCode API request failed: ${safeString(result.error)}`);
  return "data" in result ? result.data as T : value as T;
}

function safeString(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function timed<T>(timings: Map<string, number>, label: string, operation: Promise<T>): Promise<T> {
  const started = Date.now();
  try { return await operation; }
  finally { timings.set(label, Date.now() - started); }
}

async function withTimeout<T>(label: string, operation: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, windowsHide: true, timeout: 15_000 });
  return result.stdout.trim();
}

async function createRepository(root: string): Promise<void> {
  await git(root, ["init", "--initial-branch", "main"]);
  await git(root, ["config", "user.email", "goat-smoke@example.invalid"]);
  await git(root, ["config", "user.name", "Goat Smoke"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial smoke commit"]);
}

function authHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME || "opencode";
  return { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

function clientFor(url: string, directory: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: url, directory, headers: authHeaders() });
}

async function assertHostLoaded(client: OpencodeClient, directory: string, compatibilityRange: string): Promise<void> {
  const health = unwrap<{ healthy: true; version: string }>(await withTimeout("health", client.global.health()));
   if (!Bun.semver.satisfies(health.version, compatibilityRange)) throw new Error(`OpenCode ${health.version} does not satisfy ${compatibilityRange}`);
   process.stdout.write(`smoke host health passed: ${health.version} satisfies ${compatibilityRange}\n`);
   const config = unwrap<{ command?: Record<string, unknown>; agent?: Record<string, unknown> }>(await withTimeout("directory config", client.config.get({ directory }), 60_000));
  if (!config.command?.goat) throw new Error("Goat /goat command was not registered");
  for (const agent of ["goat-formulator", "goat-executor", "goat-verifier"]) {
    if (!config.agent?.[agent]) throw new Error(`Goat agent ${agent} was not registered`);
  }
  const providers = unwrap<{ all?: Array<{ id?: string }>; connected?: string[]; default?: Record<string, string> }>(await withTimeout("provider list", client.provider.list({ directory })));
  process.stdout.write(`smoke providers: ${providers.connected?.join(",") || "none"}\n`);
  if (!providers.connected?.includes(smokeProvider)) throw new Error(`smoke provider ${smokeProvider} is not connected`);
  const ids = unwrap<string[]>(await withTimeout("tool registry", client.tool.ids({ directory })));
  const expected = ["goat_state", "goat_contract_propose", "goat_evidence_record", "goat_completion_propose", "goat_block", "goat_verifier_report"];
  for (const id of expected) {
    const count = ids.filter((candidate) => candidate === id).length;
    if (count !== 1) throw new Error(`Goat tool ${id} registered ${count} times`);
  }
}

function remainingBudget(deadline: number, cap = 15_000): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("smoke case deadline exceeded");
  return Math.min(cap, remaining);
}

function withBudget<T>(label: string, operation: Promise<T>, deadline: number, cap = 15_000): Promise<T> {
  return withTimeout(label, operation, remainingBudget(deadline, cap));
}

async function answerPendingRequests(client: OpencodeClient, directories: readonly string[], deadline: number): Promise<void> {
  await Promise.all(directories.map(async (directory) => {
    const [questions, permissions] = await Promise.all([
      withBudget("question list", client.question.list({ directory }), deadline),
      withBudget("permission list", client.permission.list({ directory }), deadline),
    ]);
    const pendingQuestions = unwrap<Array<{ id: string; questions?: Array<{ options?: Array<{ label?: string }> }> }>>(questions);
    const pendingPermissions = unwrap<Array<{ id: string; permission?: string }>>(permissions);
    await Promise.all(pendingQuestions.map(async (question) => {
      const options = question.questions?.[0]?.options ?? [];
      process.stdout.write(`smoke question: ${question.id} directory=${directory} options=${options.map((option) => option.label ?? "unknown").join("|")}\n`);
      const approval = options.some((option) => option.label === "Approve and start");
      const prepareWorktree = options.some((option) => option.label === "Prepare a clean worktree");
      const recommendedApproval = options.find((option) => option.label?.toLowerCase().startsWith("approve "))?.label;
      if (approval) {
        unwrap(await withBudget("approval reply", client.question.reply({ requestID: question.id, directory, answers: [["Approve and start"]] }), deadline));
        process.stdout.write("smoke question answered: approve\n");
      } else if (prepareWorktree) {
        unwrap(await withBudget("worktree reply", client.question.reply({ requestID: question.id, directory, answers: [["Prepare a clean worktree"]] }), deadline));
        process.stdout.write("smoke question answered: prepare-worktree\n");
      } else if (recommendedApproval) {
        unwrap(await withBudget("model approval reply", client.question.reply({ requestID: question.id, directory, answers: [[recommendedApproval]] }), deadline));
        process.stdout.write(`smoke model question answered: ${recommendedApproval}\n`);
      } else {
        unwrap(await withBudget("question reject", client.question.reject({ requestID: question.id, directory }), deadline));
      }
    }));
    await Promise.all(pendingPermissions.map(async (permission) => {
      process.stdout.write(`smoke permission: ${permission.permission ?? "unknown"} directory=${directory}\n`);
      try {
        unwrap(await withBudget("permission reply", client.permission.reply({ requestID: permission.id, directory, reply: "always" }), deadline));
      } catch (error) {
        if (!/PermissionNotFound|permission request not found/i.test(safeString(error))) throw error;
      }
    }));
  }));
}



async function sessionTree(client: OpencodeClient, directory: string, rootSessionID: string): Promise<string[]> {
  const result: string[] = [];
  const pending = [rootSessionID];
  while (pending.length > 0) {
    const sessionID = pending.shift()!;
    result.push(sessionID);
    const children = unwrap<Array<{ id: string }>>(await withTimeout("session children", client.session.children({ sessionID, directory })));
    pending.push(...children.map((child) => child.id));
  }
  return result;
}

async function waitForCompletion(client: OpencodeClient, directory: string, rootSessionID: string, goatHome: string, commandError: () => unknown, timings: Map<string, number>, caseName: string): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let polls = 0;
  while (Date.now() < deadline) {
    polls += 1;
    const error = commandError();
    if (error) throw error;
    const snapshot = goatWorkflowSnapshot(goatHome, rootSessionID);
    failOnUnexpectedWorkflow(snapshot);
    if (workflowCompleted(snapshot)) break;
    const directories = [directory, ...(snapshot?.workspacePath && snapshot.workspacePath.toLowerCase() !== directory.toLowerCase() ? [snapshot.workspacePath] : [])];
    await answerPendingRequests(client, directories, deadline);
    const refreshed = goatWorkflowSnapshot(goatHome, rootSessionID);
    failOnUnexpectedWorkflow(refreshed);
    if (workflowCompleted(refreshed)) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remainingBudget(deadline, 1_000))));
  }
  timings.set(`${caseName}/polls`, polls);
  timings.set(`${caseName}/workflow`, Date.now() - started);
  if (workflowCompleted(goatWorkflowSnapshot(goatHome, rootSessionID))) return;
  const sessions = await sessionTree(client, directory, rootSessionID);
  const statuses = unwrap<Record<string, { type?: string }>>(await withTimeout("session status diagnostics", client.session.status({ directory })));
  const recent = await Promise.all(sessions.map(async (sessionID) => {
    const messages = unwrap<unknown>(await withTimeout("session diagnostics", client.session.messages({ sessionID, directory })));
    const metadata = unwrap<unknown>(await withTimeout("session metadata diagnostics", client.session.get({ sessionID, directory })));
    let history: unknown = "unavailable";
    try { history = unwrap(await withTimeout("session history diagnostics", client.v2.session.history({ sessionID, limit: 20 }))); } catch (error) { history = safeString(error); }
    return `${sessionID}:${statuses[sessionID]?.type ?? "unknown"}:metadata=${safeString(metadata).slice(-600)}:history=${safeString(history).slice(-1200)}:messages=${safeString(messages).slice(-1200)}`;
  }));
  throw new Error(`Goat workflow did not reach COMPLETED before the smoke deadline\n${recent.join("\n")}`);
}

type WorkflowSnapshot = { goalState: string | undefined; runStatus: string | undefined; workspacePath: string | undefined; verificationAttempts: number | undefined; verificationOutcome: string | undefined; dispatches: { kind?: string; role?: string; status?: string; targetSessionId?: string }[]; lease: unknown };

function workflowCompleted(snapshot: WorkflowSnapshot | null): boolean {
  return snapshot?.goalState === "COMPLETED" && snapshot.runStatus === "COMPLETED" && snapshot.verificationOutcome === "PASS";
}

function failOnUnexpectedWorkflow(snapshot: WorkflowSnapshot | null): void {
  const hasFailedDispatch = !!snapshot && snapshot.dispatches.some((dispatch) => dispatch.status === "FAILED") && !snapshot.dispatches.some((dispatch) => ["PENDING", "SENT", "STARTED"].includes(dispatch.status ?? ""));
  const hasRemediation = snapshot?.dispatches.some((dispatch) => dispatch.kind === "executor-remediation") ?? false;
  if (snapshot?.goalState === "BLOCKED" || snapshot?.runStatus === "BLOCKED" || hasFailedDispatch || hasRemediation) {
    throw new Error(`Goat workflow entered an unexpected smoke state: ${safeString(snapshot)}`);
  }
}

function goatWorkflowSnapshot(goatHome: string, rootSessionID: string): WorkflowSnapshot | null {
  try {
    const db = new Database(join(goatHome, "goat.db"), { readonly: true });
    const goal = (db.query("SELECT goal_id,state FROM goals WHERE root_session_id=? ORDER BY rowid DESC LIMIT 1").all(rootSessionID)[0] ?? null) as { goal_id?: string; state?: string } | null;
    const run = goal?.goal_id ? ((db.query("SELECT run_id,status,workspace_path,verification_attempts FROM runs WHERE goal_id=? ORDER BY rowid DESC LIMIT 1").all(goal.goal_id)[0] ?? null) as { run_id?: string; status?: string; workspace_path?: string; verification_attempts?: number } | null) : null;
    const verification = run?.run_id ? ((db.query("SELECT outcome FROM verification_results WHERE run_id=? ORDER BY attempt DESC LIMIT 1").all(run.run_id)[0] ?? null) as { outcome?: string } | null) : null;
    const dispatches = goal?.goal_id ? db.query("SELECT kind,role,status,target_session_id AS targetSessionId FROM dispatches WHERE goal_id=? ORDER BY created_at").all(goal.goal_id) as { kind?: string; role?: string; status?: string; targetSessionId?: string }[] : [];
    const lease = goal?.goal_id ? db.query("SELECT holder_instance_id AS holderInstanceId,expires_at AS expiresAt FROM leases WHERE goal_id=?").all(goal.goal_id)[0] : undefined;
    db.close();
    return { goalState: goal?.state, runStatus: run?.status, workspacePath: run?.workspace_path, verificationAttempts: run?.verification_attempts, verificationOutcome: verification?.outcome, dispatches, lease };
  } catch { return null; }
}

async function runCase(client: OpencodeClient, project: string, goatHome: string, smokeCase: SmokeCase, timings: Map<string, number>): Promise<void> {
  const caseStarted = Date.now();
  const before = unwrap<SmokeWorktree[]>(await withTimeout("worktree list", client.worktree.list({ directory: project })));
  const session = unwrap<{ id: string }>(await withTimeout("session create", client.session.create({ directory: project, title: `Goat smoke ${smokeCase.name}`, model: { providerID: smokeProvider, id: smokeModelID }, permission: [{ permission: "question", pattern: "*", action: "allow" }] })));
  const metadata = unwrap<{ model?: { providerID?: string; id?: string } }>(await withTimeout("session metadata", client.session.get({ sessionID: session.id, directory: project })));
  if (metadata.model?.providerID !== smokeProvider || metadata.model.id !== smokeModelID) throw new Error(`smoke session selected ${metadata.model?.providerID ?? "unknown"}/${metadata.model?.id ?? "unknown"}, expected ${smokeModel}`);
  let commandError: unknown;
  void client.session.command({ sessionID: session.id, directory: project, command: "goat", arguments: smokeCase.intent }).then((result) => { try { unwrap(result); } catch (error) { commandError = error; } }, (error) => { commandError = error; });
   await waitForCompletion(client, project, session.id, goatHome, () => commandError, timings, smokeCase.name);
   const completed = goatWorkflowSnapshot(goatHome, session.id);
   if (!workflowCompleted(completed) || completed?.verificationAttempts !== 1) throw new Error(`smoke ${smokeCase.name} did not complete on verification attempt one`);
   timings.set(`${smokeCase.name}/total`, Date.now() - caseStarted);

  if (smokeCase.workspace === "current") {
    const content = await readFile(join(project, smokeCase.file), "utf8");
    if (content !== smokeCase.content) throw new Error(`current workspace file ${smokeCase.file} has unexpected content`);
    await rm(join(project, smokeCase.file), { force: true });
    return;
  }

  const after = unwrap<SmokeWorktree[]>(await withTimeout("worktree list after completion", client.worktree.list({ directory: project })));
  const created = after.filter((entry) => !before.some((item) => worktreeDirectory(item).toLowerCase() === worktreeDirectory(entry).toLowerCase()));
  if (created.length !== 1) throw new Error(`expected one new native worktree, found ${created.length}`);
  const createdDirectory = worktreeDirectory(created[0]!);
  let content: string;
  try { content = await readFile(join(createdDirectory, smokeCase.file), "utf8"); }
  catch (error) {
    let mainContent = "<missing>";
    try { mainContent = await readFile(join(project, smokeCase.file), "utf8"); } catch { /* diagnostic only */ }
    const entries = await readdir(createdDirectory).catch(() => [] as string[]);
    const sessions = await sessionTree(client, project, session.id).catch(() => [] as string[]);
    const transcript = await Promise.all(sessions.map(async (sessionID) => safeString(unwrap(await client.session.messages({ sessionID, directory: project }))))).catch(() => [] as string[]);
    throw new Error(`worktree file ${smokeCase.file} is missing at ${createdDirectory}; main=${JSON.stringify(mainContent)}; entries=${entries.join(",")}; sessions=${transcript.map((item) => item.slice(-500)).join(" | ")}; cause=${safeString(error)}`);
  }
  if (content !== smokeCase.content) throw new Error(`worktree file ${smokeCase.file} has unexpected content`);
  let mainFile: string | undefined;
  try { mainFile = await readFile(join(project, smokeCase.file), "utf8"); } catch { mainFile = undefined; }
  if (mainFile !== undefined) throw new Error(`worktree change leaked into the main workspace: ${smokeCase.file}`);
  unwrap(await withTimeout("worktree cleanup", client.worktree.remove({ directory: project, worktreeRemoveInput: { directory: createdDirectory } })));
}

function worktreeDirectory(entry: SmokeWorktree): string {
  return typeof entry === "string" ? entry : entry.directory ?? "";
}

async function cleanupSmokeRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  process.stderr.write(`smoke cleanup deferred; artifacts preserved at ${root}\n`);
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "goat-opencode-smoke-"));
  const project = join(root, "project");
  const goatHome = join(root, "goat-data");
  await mkdir(project, { recursive: true });
  await mkdir(goatHome, { recursive: true });
   const workspaceRoot = process.cwd();
   await writeFile(join(project, "package.json"), JSON.stringify({ name: "goat-opencode-smoke", private: true, type: "module" }, null, 2), "utf8");
  await writeFile(join(project, ".gitignore"), "node_modules\n", "utf8");
    const timings = new Map<string, number>();
    const candidate = await timed(timings, "pack", packTarball(workspaceRoot));
    const tarball = candidate.path;
   await timed(timings, "install", execFileAsync(bunExecutable, ["install", tarball], { cwd: project, windowsHide: true, timeout: 120_000 }));
   if (candidate.owned) await rm(tarball, { force: true });
  const installedPackage = join(project, "node_modules", "opencode-goat");
   if (!(await readdir(join(installedPackage, "dist")).catch(() => [] as string[])).includes("index.js")) {
     throw new Error("opencode-goat tarball install did not provide dist/index.js");
   }
   const installedManifest = JSON.parse(await readFile(join(installedPackage, "package.json"), "utf8")) as { engines?: { opencode?: string } };
   const compatibilityRange = installedManifest.engines?.opencode;
   if (!compatibilityRange) throw new Error("packaged OpenCode compatibility range is missing");
   await timed(timings, "repository", createRepository(project));

  const username = `goat-smoke-${randomUUID().slice(0, 8)}`;
  const password = randomUUID();
  const original = new Map(envKeys.map((key) => [key, process.env[key]]));
  const previousCwd = process.cwd();
  process.chdir(project);
  delete process.env.OPENCODE_CONFIG;
   process.env.OPENCODE_GOAT_HOME = goatHome;
  process.env.OPENCODE_SERVER_USERNAME = username;
  process.env.OPENCODE_SERVER_PASSWORD = password;
   if (original.get("OPENCODE_CONFIG_CONTENT") === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;

  let server: { close(): void } | undefined;
  let passed = false;
  try {
     const pluginUrl = pathToFileURL(join(installedPackage, "dist", "index.js")).href;
      const started = await timed(timings, "server", createOpencode({ hostname: "127.0.0.1", port: 0, timeout: 10_000, config: { plugin: [pluginUrl] } }));
    server = started.server;
    const unauthenticated = createOpencodeClient({ baseUrl: started.server.url, directory: project });
    await expectUnauthorized(unauthenticated, project);
    const client = clientFor(started.server.url, project);
     await assertHostLoaded(client, project, compatibilityRange);
      for (const smokeCase of cases) {
        process.stdout.write(`smoke case: ${smokeCase.name} model=${smokeModel}\n`);
        await runCase(client, project, goatHome, smokeCase, timings);
      }
      passed = true;
      process.stdout.write(`smoke timings: ${safeString(Object.fromEntries(timings))}\n`);
     process.stdout.write(`${process.env.OPENCODE_SERVER_PASSWORD ? "authenticated " : ""}OpenCode current/worktree smoke passed\n`);
   } catch (error) {
     process.stderr.write(`smoke timings: ${safeString(Object.fromEntries(timings))}\n`);
     try {
      const db = new Database(join(goatHome, "goat.db"), { readonly: true });
      const goals = db.query("SELECT goal_id,state,blocker FROM goals ORDER BY created_at").all();
       const runs = db.query("SELECT run_id,status,workspace_path,preparation_retry_requested,executor_diff_json,final_snapshot_json FROM runs ORDER BY created_at").all();
       const dispatches = db.query("SELECT kind,role,status,failure_reason,target_session_id FROM dispatches ORDER BY created_at").all();
       const leases = db.query("SELECT goal_id,holder_instance_id,expires_at FROM leases ORDER BY goal_id").all();
       const bindings = db.query("SELECT session_id,goal_id,run_id,role,status FROM session_bindings ORDER BY created_at").all();
       const audit = db.query("SELECT kind,payload_json,previous_state,next_state FROM audit_events ORDER BY goal_sequence DESC LIMIT 12").all();
       db.close();
       process.stderr.write(`smoke Goat state: ${safeString({ goals, runs, dispatches, leases, bindings, audit })}\n`);
    } catch (diagnosticError) {
      process.stderr.write(`smoke Goat state unavailable: ${safeString(diagnosticError)}\n`);
    }
    throw error;
  } finally {
    try { server?.close(); } finally {
      for (const [key, value] of original) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      process.chdir(previousCwd);
       if (passed) await cleanupSmokeRoot(root);
       else process.stderr.write(`smoke artifacts preserved at ${root}\n`);
    }
  }
}

try {
  await main();
} catch (error) {
  const message = safeString(error).slice(-4_000).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  process.stderr.write(`smoke failure: ${message}\n`);
  if (process.env.GITHUB_ACTIONS === "true") process.stdout.write(`::error title=OpenCode smoke::${message}\n`);
  process.exitCode = 1;
}
