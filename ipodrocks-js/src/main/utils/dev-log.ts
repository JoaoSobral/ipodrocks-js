/**
 * The opt-in developer log.
 *
 * Off unless the process was started with `IPODROCKS_DEV_LOGS=1` (or the
 * daemon with `--dev-logs`, which sets it). Checked `=== "1"`, like
 * `IPODROCKS_HEADLESS`, and set nowhere else: what it records — library and
 * device paths, file sizes, every device RPC that failed — is more than an
 * ordinary user should be shown, so it stays a deliberate choice.
 *
 * While on, every entry is echoed to stdout (the server-side reader is
 * `docker logs` or the terminal) and kept in a bounded in-memory ring, which
 * the `app:devLog:*` channels serve to the **owner** — the in-app console is
 * how a remote client sees what the server decided about its device without a
 * shell on the server.
 *
 * Every call site is on a hot path or near one, so a disabled log must cost a
 * branch and nothing more: pass a function for anything expensive to format.
 */

export interface DevLogEntry {
  seq: number;
  /** Epoch ms, server clock. */
  at: number;
  scope: string;
  message: string;
}

export interface DevLogPage {
  enabled: boolean;
  entries: DevLogEntry[];
  /** The newest seq the server holds; pass it back as `afterSeq`. */
  lastSeq: number;
}

/** Enough for a full device check's diagnostics plus a sync or two. */
export const DEV_LOG_CAPACITY = 5000;
/** A page larger than this is a client asking for the whole ring at once. */
export const DEV_LOG_MAX_PAGE = 1000;

let enabledOverride: boolean | null = null;
let seq = 0;
const ring: DevLogEntry[] = [];

export function isDevLogEnabled(): boolean {
  return enabledOverride ?? process.env.IPODROCKS_DEV_LOGS === "1";
}

/** Tests only: force the flag either way, or `null` to read the env again. */
export function setDevLogEnabledForTests(enabled: boolean | null): void {
  enabledOverride = enabled;
}

export function devLog(scope: string, message: string | (() => string)): void {
  if (!isDevLogEnabled()) return;
  let text: string;
  try {
    text = typeof message === "function" ? message() : message;
  } catch (err) {
    // A diagnostic that throws must never take down the operation it
    // describes.
    text = `<log formatter threw: ${err instanceof Error ? err.message : String(err)}>`;
  }
  const entry: DevLogEntry = { seq: ++seq, at: Date.now(), scope, message: text };
  ring.push(entry);
  if (ring.length > DEV_LOG_CAPACITY) ring.splice(0, ring.length - DEV_LOG_CAPACITY);
  console.log(`[dev:${scope}] ${text}`);
}

/** Entries newer than `afterSeq`, oldest first, at most `limit` of them. */
export function readDevLog(afterSeq = 0, limit = DEV_LOG_MAX_PAGE): DevLogPage {
  if (!isDevLogEnabled()) return { enabled: false, entries: [], lastSeq: 0 };
  const after = Number.isFinite(afterSeq) ? afterSeq : 0;
  const cap = Number.isFinite(limit)
    ? Math.max(1, Math.min(DEV_LOG_MAX_PAGE, Math.floor(limit)))
    : DEV_LOG_MAX_PAGE;
  const newer = ring.filter((e) => e.seq > after);
  return { enabled: true, entries: newer.slice(0, cap), lastSeq: seq };
}

/** The newest `count` entries, for a reader that wants "what just happened". */
export function tailDevLog(count: number): DevLogEntry[] {
  const n = Number.isFinite(count) ? Math.max(1, Math.min(DEV_LOG_MAX_PAGE, Math.floor(count))) : 200;
  return ring.slice(-n);
}

export function clearDevLog(): void {
  ring.length = 0;
}
