import { Store, type SessionData } from "express-session";
import { getServerDb } from "./db";

/**
 * An `express-session` store backed by the server's own SQLite file.
 *
 * `connect-sqlite3` would do this, but the app already carries `better-sqlite3`
 * and a synchronous driver makes the whole store about forty lines with no
 * callback plumbing. The default `MemoryStore` is not an option: it leaks, and
 * it logs everyone out on restart.
 */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Callback = (err?: unknown) => void;

export class SqliteSessionStore extends Store {
  private lastSweep = 0;

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {
    super();
  }

  /** Sweeps at most once a minute; a session read should not pay for it. */
  private maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    try {
      getServerDb()
        .prepare("DELETE FROM server_sessions WHERE expires_at < ?")
        .run(now);
    } catch {
      // A sweep failure must never fail the request it rode in on.
    }
  }

  private expiryFor(session: SessionData): number {
    const cookieExpires = session.cookie?.expires;
    if (cookieExpires) return new Date(cookieExpires).getTime();
    return Date.now() + this.ttlMs;
  }

  get(
    sid: string,
    callback: (err: unknown, session?: SessionData | null) => void
  ): void {
    try {
      this.maybeSweep();
      const row = getServerDb()
        .prepare("SELECT data, expires_at FROM server_sessions WHERE sid = ?")
        .get(sid) as { data: string; expires_at: number } | undefined;
      if (!row) return callback(null, null);
      if (row.expires_at < Date.now()) {
        this.destroy(sid, () => callback(null, null));
        return;
      }
      callback(null, JSON.parse(row.data) as SessionData);
    } catch (err) {
      callback(err);
    }
  }

  set(sid: string, session: SessionData, callback?: Callback): void {
    try {
      getServerDb()
        .prepare(
          "INSERT INTO server_sessions (sid, data, expires_at) VALUES (?, ?, ?) " +
            "ON CONFLICT(sid) DO UPDATE SET data = excluded.data, " +
            "expires_at = excluded.expires_at"
        )
        .run(sid, JSON.stringify(session), this.expiryFor(session));
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  destroy(sid: string, callback?: Callback): void {
    try {
      getServerDb().prepare("DELETE FROM server_sessions WHERE sid = ?").run(sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  touch(sid: string, session: SessionData, callback?: Callback): void {
    try {
      getServerDb()
        .prepare("UPDATE server_sessions SET expires_at = ? WHERE sid = ?")
        .run(this.expiryFor(session), sid);
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  /** Used by the logout-everywhere path and by tests. */
  clear(callback?: Callback): void {
    try {
      getServerDb().prepare("DELETE FROM server_sessions").run();
      callback?.();
    } catch (err) {
      callback?.(err);
    }
  }

  length(callback: (err: unknown, length?: number) => void): void {
    try {
      const row = getServerDb()
        .prepare("SELECT COUNT(*) AS n FROM server_sessions")
        .get() as { n: number };
      callback(null, row.n);
    } catch (err) {
      callback(err);
    }
  }
}
