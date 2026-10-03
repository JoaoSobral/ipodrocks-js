/**
 * Invoke results that outlive the HTTP request that asked for them.
 *
 * `POST /api/invoke/:channel` used to hold its response open until the handler
 * returned. `sync:start` returns when the *sync* does, so behind Cloudflare —
 * which cuts any request that has sent no byte for ~100 s with a 524 — every
 * sync longer than that "failed" in the browser while it carried on happily on
 * the server. Scans and shadow builds were the same shape.
 *
 * So a handler is raced against a short deadline. Inside it, the response is
 * exactly what it always was. Past it, the client gets `202 { pending }` and
 * collects the outcome from `GET /api/invoke/result/:requestId`, which
 * long-polls for a bounded time and can be asked again as often as needed.
 *
 * The same table makes every invoke **safe to retry**: a POST carrying a
 * request id this session has already used joins the existing job instead of
 * running the handler a second time. That is what lets the client retry a
 * request whose response was lost on a flaky link without, say, adding the
 * same device twice.
 *
 * **Keyed on `(sessionId, requestId)`, never on the request id alone.** The id
 * is client-chosen; a global table would let one session read — or join —
 * another's call. Same rule as everything else in "one global is one client".
 */

export interface InvokeOutcome {
  status: number;
  body: { result?: unknown; error?: string };
}

interface Job {
  channel: string;
  createdAt: number;
  promise: Promise<InvokeOutcome>;
  outcome?: InvokeOutcome;
  doneAt?: number;
}

/** How long a finished outcome stays collectable. */
export const INVOKE_RESULT_TTL_MS = 10 * 60 * 1000;
/** Finished jobs kept per session beyond which the oldest are dropped. */
const MAX_JOBS_PER_SESSION = 200;
/** How long a result poll waits before answering "still pending". Comfortably
 *  under any proxy's idle cut. */
export const RESULT_POLL_MS = 25_000;

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const jobs = new Map<string, Map<string, Job>>();

/** The deadline after which a handler's answer is deferred. Overridable for
 *  tests, which must not wait twenty seconds to see a `202`. */
export function invokeDeferMs(): number {
  const raw = Number(process.env.IPODROCKS_INVOKE_DEFER_MS);
  return Number.isFinite(raw) && raw >= 0 && raw <= 60_000 ? raw : 20_000;
}

export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID_RE.test(id);
}

function prune(table: Map<string, Job>, now: number): void {
  for (const [id, job] of table) {
    if (job.doneAt !== undefined && now - job.doneAt > INVOKE_RESULT_TTL_MS) {
      table.delete(id);
    }
  }
  if (table.size <= MAX_JOBS_PER_SESSION) return;
  // Insertion order is creation order; only finished jobs are evictable — a
  // pending one is somebody's sync.
  for (const [id, job] of table) {
    if (table.size <= MAX_JOBS_PER_SESSION) break;
    if (job.doneAt !== undefined) table.delete(id);
  }
}

export type StartResult =
  | { kind: "started" | "joined"; job: Job }
  | { kind: "conflict" };

/**
 * Runs `run` under `(sessionId, requestId)`, or joins the job already there.
 * A request id reused for a *different* channel is a client bug and is refused
 * rather than answered with the other channel's result.
 */
export function startOrJoin(
  sessionId: string,
  requestId: string,
  channel: string,
  run: () => Promise<InvokeOutcome>
): StartResult {
  const now = Date.now();
  let table = jobs.get(sessionId);
  if (!table) {
    table = new Map();
    jobs.set(sessionId, table);
  }
  prune(table, now);

  const existing = table.get(requestId);
  if (existing) {
    if (existing.channel !== channel) return { kind: "conflict" };
    return { kind: "joined", job: existing };
  }

  const job: Job = { channel, createdAt: now, promise: null as never };
  job.promise = run().then((outcome) => {
    job.outcome = outcome;
    job.doneAt = Date.now();
    return outcome;
  });
  table.set(requestId, job);
  return { kind: "started", job };
}

/** The job for a result poll, or undefined. Session-scoped by construction. */
export function findJob(sessionId: string, requestId: string): Job | undefined {
  return jobs.get(sessionId)?.get(requestId);
}

/**
 * Resolves with the outcome if the job finishes within `ms`, otherwise null.
 * Never rejects: `run` already turns every failure into an outcome.
 */
export function waitForOutcome(job: Job, ms: number): Promise<InvokeOutcome | null> {
  if (job.outcome) return Promise.resolve(job.outcome);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void job.promise.then((outcome) => {
      clearTimeout(timer);
      resolve(outcome);
    });
  });
}

/** Test-only: forget everything. */
export function _resetInvokeJobs(): void {
  jobs.clear();
}

// Sessions that never poll again (a closed tab) still have their finished
// outcomes swept, rather than living until the next call from that session.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [sessionId, table] of jobs) {
    prune(table, now);
    if (table.size === 0) jobs.delete(sessionId);
  }
}, 60_000);
sweeper.unref?.();
