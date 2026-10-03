import type { Request, Response } from "express";
import { isAllowedChannel } from "../shared/ipc-channels";
import { getHandler } from "../main/host/bridge";
import { sanitizeErrorMessage } from "../main/ipc/common";
import { ensureSession, senderFor } from "./events";
import { randomUUID } from "node:crypto";
import {
  findJob,
  invokeDeferMs,
  isValidRequestId,
  RESULT_POLL_MS,
  startOrJoin,
  waitForOutcome,
  type InvokeOutcome,
} from "./invoke-jobs";

/**
 * `POST /api/invoke/:channel` — the control plane's request/response half.
 *
 * It is deliberately thin. Every handler already returns either a value or
 * `{ error }` (that is what `safe()` does), and every one already receives a
 * context with a `sender`. So the dispatcher's whole job is: check the channel
 * is allowed, look it up in the same registry Electron's transport reads, and
 * call it with a session-scoped sender.
 *
 * The channel allowlist is the *same list* the preload uses
 * (`src/shared/ipc-channels.ts`). It is the one gate standing between an
 * authenticated client and any channel that happens to be registered, so it
 * must not become a second copy that drifts.
 */

/** Requests are small JSON argument arrays; a multi-megabyte body is not one. */
export const MAX_INVOKE_BODY_BYTES = 2 * 1024 * 1024;

export interface InvokeRouteDeps {
  /** The authenticated subject for this request, used to key the session. */
  subjectFor(req: Request): string | null;
}

export async function handleInvoke(
  req: Request,
  res: Response,
  deps: InvokeRouteDeps
): Promise<void> {
  const channel = String(req.params.channel ?? "");

  if (!isAllowedChannel(channel)) {
    res.status(403).json({ error: `Channel not allowed: ${channel}` });
    return;
  }

  const handler = getHandler(channel);
  if (!handler) {
    res.status(404).json({ error: `No handler for channel: ${channel}` });
    return;
  }

  const body = req.body as { args?: unknown } | undefined;
  const args = Array.isArray(body?.args) ? body.args : [];

  const subject = deps.subjectFor(req);
  const sessionId = req.sessionID;
  if (!subject || !sessionId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  // The client may invoke before its WebSocket is up; registering here means
  // a handler that pushes progress has somewhere to push to the moment the
  // socket arrives, rather than dropping the first frames.
  ensureSession(sessionId, subject);

  const headerId = req.get("x-request-id");
  // A missing id still gets a job — the deferral is what fixes the 524 — but
  // one minted here cannot be retried by the client, only collected.
  const requestId = isValidRequestId(headerId) ? headerId : randomUUID();

  const run = async (): Promise<InvokeOutcome> => {
    try {
      // `subject` rides along so a handler scoping by identity reuses the
      // answer this gate just reached — see `callerSubject()`. The session row
      // can be destroyed (a logout on another connection) between here and the
      // handler.
      const result = await handler(
        { sender: senderFor(sessionId), sessionId, subject },
        ...args
      );
      // `undefined` is a perfectly ordinary handler result (every setter
      // returns it) and is not valid JSON on its own, so it goes out as null.
      return { status: 200, body: { result: result === undefined ? null : result } };
    } catch (err) {
      // Handlers are wrapped in `safe()` and should not throw, but a handler
      // registered without it — or a throw from the wrapper itself — must not
      // take the response down with a stack trace in it.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[server] ${channel} — ${message}`);
      return { status: 500, body: { error: sanitizeErrorMessage(message) } };
    }
  };

  const started = startOrJoin(sessionId, requestId, channel, run);
  if (started.kind === "conflict") {
    res.status(409).json({ error: "Request id already used for another channel" });
    return;
  }
  const outcome = await waitForOutcome(started.job, invokeDeferMs());
  if (outcome) {
    res.status(outcome.status).json(outcome.body);
    return;
  }
  res.status(202).json({ pending: requestId });
}

/**
 * `GET /api/invoke/result/:requestId` — collects a deferred outcome.
 *
 * Long-polls for up to `RESULT_POLL_MS`, then answers `202` so the client asks
 * again. `404` means this session has no such call: it never existed, was made
 * by another session, or finished more than `INVOKE_RESULT_TTL_MS` ago.
 */
export async function handleInvokeResult(req: Request, res: Response): Promise<void> {
  const sessionId = req.sessionID;
  const requestId = String(req.params.requestId ?? "");
  if (!sessionId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const job = isValidRequestId(requestId) ? findJob(sessionId, requestId) : undefined;
  if (!job) {
    res.status(404).json({ error: "No such request" });
    return;
  }
  const outcome = await waitForOutcome(job, RESULT_POLL_MS);
  if (outcome) {
    res.status(outcome.status).json(outcome.body);
    return;
  }
  res.status(202).json({ pending: requestId });
}
