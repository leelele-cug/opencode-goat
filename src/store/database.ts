import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";

export class DatabaseConnection {
  private readonly db: Database;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") {
      try { chmodSync(path, 0o600); } catch (error) {
        this.db.close(true);
        throw new Error(`Goat database permissions could not be secured: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.db.run("PRAGMA foreign_keys = ON;");
    this.db.run("PRAGMA busy_timeout = 5000;");
  }

  enableWal(): void {
    this.db.run("PRAGMA journal_mode = WAL;");
    this.secureSidecars();
  }

  run(sql: string, ...params: SQLQueryBindings[]): void {
    (this.db.run as (sql: string, ...bindings: SQLQueryBindings[]) => unknown)(sql, ...params);
    this.secureSidecars();
  }

  query<T = Record<string, unknown>>(sql: string, ...params: SQLQueryBindings[]): T[] {
    return (this.db.prepare(sql).all as (...params: SQLQueryBindings[]) => unknown[])(...params) as T[];
  }

  queryOne<T = Record<string, unknown>>(sql: string, ...params: SQLQueryBindings[]): T | undefined {
    const value = (this.db.prepare(sql).get as (...params: SQLQueryBindings[]) => unknown)(...params);
    return value === null ? undefined : value as T;
  }

  transaction<T>(fn: () => T): ((...args: unknown[]) => T) & { immediate: (...args: unknown[]) => T; deferred: (...args: unknown[]) => T; exclusive: (...args: unknown[]) => T } {
    return this.db.transaction(fn) as ((...args: unknown[]) => T) & { immediate: (...args: unknown[]) => T; deferred: (...args: unknown[]) => T; exclusive: (...args: unknown[]) => T };
  }

  getUserVersion(): number {
    const row = this.queryOne<{ user_version: number }>("PRAGMA user_version;");
    return row ? row.user_version : 0;
  }

  setUserVersion(version: number): void {
    this.run(`PRAGMA user_version = ${version};`);
  }

  getApplicationId(): number {
    const row = this.queryOne<{ application_id: number }>("PRAGMA application_id;");
    return row ? row.application_id : 0;
  }

  setApplicationId(id: number): void {
    this.run(`PRAGMA application_id = ${id};`);
  }

  listSchemaObjects(): { type: "table" | "index" | "trigger" | "view"; name: string; tableName: string; sql: string }[] {
    return this.query<{ type: "table" | "index" | "trigger" | "view"; name: string; tableName: string; sql: string }>(
      "SELECT type,name,tbl_name AS tableName,sql FROM sqlite_schema WHERE type IN ('table','index','trigger','view') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type,name",
    );
  }

  foreignKeyViolations(): Record<string, unknown>[] {
    return this.query<Record<string, unknown>>("PRAGMA foreign_key_check;");
  }

  integrityCheck(): { ok: true } | { ok: false; message: string } {
    const rows = this.query<{ integrity_check: string }>("PRAGMA integrity_check;");
    if (rows.length === 1 && rows[0]?.integrity_check === "ok") return { ok: true };
    return { ok: false, message: rows.map((row) => String(row.integrity_check)).join("; ") };
  }

  hasUserSchemaObjects(): boolean {
    return this.queryOne("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','index','trigger','view') LIMIT 1") !== undefined;
  }

  close(): void {
    try { this.db.close(true); } catch { /* force close */ this.db.close(); }
  }

  private secureSidecars(): void {
    if (this.path === ":memory:") return;
    for (const sidecar of [`${this.path}-wal`, `${this.path}-shm`]) if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }
}

export function openDatabase(path: string): DatabaseConnection {
  return new DatabaseConnection(path);
}
