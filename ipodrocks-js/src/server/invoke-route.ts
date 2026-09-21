import type { Request, Response } from "express";
import { isAllowedChannel } from "../shared/ipc-channels";
import { getHandler } from "../main/host/bridge";
import { sanitizeErrorMessage } from "../main/ipc/common";
import { ensureSession, senderFor } from "./events";

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

  try {
    const result = await handler({ sender: senderFor(sessionId), sessionId }, ...args);
    // `undefined` is a perfectly ordinary handler result (every setter returns
    // it) and is not valid JSON on its own, so it goes out as null.
    res.json({ result: result === undefined ? null : result });
  } catch (err) {
    // Handlers are wrapped in `safe()` and should not throw, but a handler
    // registered without it — or a throw from the wrapper itself — must not
    // take the response down with a stack trace in it.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] ${channel} — ${message}`);
    res.status(500).json({ error: sanitizeErrorMessage(message) });
  }
}
