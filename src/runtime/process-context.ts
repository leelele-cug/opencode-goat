import type { DatabaseConnection } from "../store/database.js";
import type { Store } from "../store/store.js";
import type { Orchestrator } from "./orchestrator.js";

export type GoalOrigin = {
  readonly projectId: string;
  readonly rootWorkspaceId: string | null;
  readonly projectDirectory: string;
  readonly worktreeOrigin: string;
};

export class ProcessContext {
  private static readonly registry = new Map<string, ProcessContext | Promise<void>>();

  private refcount = 0;
  private disposed = false;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private recoveryScheduled = false;
  private recoveryPromise: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(
    readonly projectId: string,
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
    projectId: string;
    instanceId: string;
    db: DatabaseConnection;
    store: Store;
    orchestrator: Orchestrator;
    releaseOwnedLeases: () => void;
  }): ProcessContext {
    return new ProcessContext(input.projectId, input.instanceId, input.db, input.store, input.orchestrator, input.releaseOwnedLeases);
  }

  static contextKey(dataHome: string, projectId: string): string {
    return `${dataHome}\u0000${projectId}`;
  }

  static getExisting(dataHome: string, projectId: string): ProcessContext | undefined {
    const value = ProcessContext.registry.get(ProcessContext.contextKey(dataHome, projectId));
    return value instanceof ProcessContext ? value : undefined;
  }

  static async acquire(dataHome: string, projectId: string, factory: () => ProcessContext): Promise<ProcessContext> {
    const key = ProcessContext.contextKey(dataHome, projectId);
    const existing = ProcessContext.registry.get(key);
    if (existing instanceof ProcessContext) {
      existing.retain();
      return existing;
    }
    if (existing) {
      await existing;
      return ProcessContext.acquire(dataHome, projectId, factory);
    }
    const context = factory();
    ProcessContext.registry.set(key, context);
    context.retain();
    return context;
  }

  static register(context: ProcessContext, dataHome: string): void {
    ProcessContext.registry.set(ProcessContext.contextKey(dataHome, context.projectId), context);
  }

  retain(): void {
    if (this.disposed) throw new Error("Goat process context is already disposed.");
    this.refcount += 1;
  }

  release(dataHome: string): Promise<void> {
    if (this.disposed || this.refcount === 0) return Promise.resolve();
    this.refcount -= 1;
    if (this.refcount > 0) return Promise.resolve();
    this.disposed = true;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    const key = ProcessContext.contextKey(dataHome, this.projectId);
    const cleanup = (async (): Promise<void> => {
      if (this.recoveryPromise) await this.recoveryPromise;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.releaseOwnedLeases();
      this.db.close();
    })();
    ProcessContext.registry.set(key, cleanup);
    void cleanup.finally(() => {
      if (ProcessContext.registry.get(key) === cleanup) ProcessContext.registry.delete(key);
    });
    return cleanup;
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
