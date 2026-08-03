import type { DatabaseConnection } from "../store/database.js";
import type { Store } from "../store/store.js";
import type { Orchestrator } from "./orchestrator.js";

export type ProjectScope = {
  readonly projectId: string;
  readonly rootWorkspaceId: string | null;
  readonly projectDirectory: string;
  readonly worktreeOrigin: string;
};

export class ProcessContext {
  private static readonly registry = new Map<string, ProcessContext>();

  private refcount = 0;
  private disposed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private recoveryScheduled = false;
  private recoveryPromise: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    readonly scope: ProjectScope,
    readonly instanceId: string,
    readonly db: DatabaseConnection,
    readonly store: Store,
    readonly orchestrator: Orchestrator,
    private readonly releaseOwnedLeases: () => void,
  ) {
    this.heartbeat = setInterval(() => {
      try { store.renewOwnedLeases(); } catch (error) { console.error("[Goat] lease heartbeat failed:", error instanceof Error ? error.message : String(error)); }
    }, 2 * 60 * 1000);
    this.heartbeat.unref();
  }

  static create(input: {
    scope: ProjectScope;
    instanceId: string;
    db: DatabaseConnection;
    store: Store;
    orchestrator: Orchestrator;
    releaseOwnedLeases: () => void;
  }): ProcessContext {
    return new ProcessContext(input.scope, input.instanceId, input.db, input.store, input.orchestrator, input.releaseOwnedLeases);
  }

  static contextKey(dataHome: string, projectId: string, rootDirectory = "", rootWorktreePath = ""): string {
    return `${dataHome}\u0000${projectId}\u0000${rootDirectory.toLowerCase()}\u0000${rootWorktreePath.toLowerCase()}`;
  }

  static getExisting(dataHome: string, projectId: string, rootDirectory = "", rootWorktreePath = "", shareProject = false): ProcessContext | undefined {
    const exact = ProcessContext.registry.get(ProcessContext.contextKey(dataHome, projectId, rootDirectory, rootWorktreePath));
    if (exact || !shareProject) return exact;
    const prefix = `${dataHome}\u0000${projectId}\u0000`;
    return [...ProcessContext.registry.entries()].find(([key]) => key.startsWith(prefix))?.[1];
  }

  static register(context: ProcessContext, dataHome: string): void {
    ProcessContext.registry.set(ProcessContext.contextKey(dataHome, context.scope.projectId, context.scope.projectDirectory, context.scope.worktreeOrigin), context);
  }

  static unregister(context: ProcessContext, dataHome: string): void {
    const key = ProcessContext.contextKey(dataHome, context.scope.projectId, context.scope.projectDirectory, context.scope.worktreeOrigin);
    if (ProcessContext.registry.get(key) === context) ProcessContext.registry.delete(key);
  }

  retain(): void {
    if (this.disposed) throw new Error("Goat process context is already disposed.");
    this.refcount += 1;
  }

  release(dataHome: string): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.refcount -= 1;
    if (this.refcount > 0) return Promise.resolve();
    this.disposed = true;
    ProcessContext.unregister(this, dataHome);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const cleanup = async (): Promise<void> => {
      if (this.recoveryPromise) await this.recoveryPromise;
      this.releaseOwnedLeases();
      this.db.close();
    };
    return cleanup();
  }

  scheduleRecovery(): void {
    if (this.recoveryScheduled || this.disposed) return;
    this.recoveryScheduled = true;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryPromise = this.orchestrator.recoverProject().catch((error) => {
        console.error("[Goat] startup recovery failed:", error instanceof Error ? error.message : String(error));
      });
    }, 0);
    this.recoveryTimer.unref?.();
  }
}
