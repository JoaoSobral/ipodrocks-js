import Database from "better-sqlite3";
import { app } from "electron";
import path from "path";
import { SCHEMA_SQL } from "./schema";

export class AppDatabase {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath =
      dbPath ?? path.join(app.getPath("userData"), "ipodrock.db");
  }

  initialize(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
  }

  getConnection(): Database.Database {
    if (!this.db) {
      throw new Error("Database not initialized. Call initialize() first.");
    }
    return this.db;
  }

  getAll<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T[] {
    return this.getConnection().prepare(sql).all(...params) as T[];
  }

  getOne<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): T | undefined {
    return this.getConnection().prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: unknown[]): Database.RunResult {
    return this.getConnection().prepare(sql).run(...params);
  }

  transaction<T>(fn: (db: Database.Database) => T): T {
    const conn = this.getConnection();
    const wrapped = conn.transaction(() => fn(conn));
    return wrapped();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
