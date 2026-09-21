/**
 * The IPC channel allowlist, shared by every transport.
 *
 * It used to live inside `preload.ts`, where it was the only thing standing
 * between a compromised renderer and the whole main-process surface. The web
 * server needs exactly the same gate on `POST /api/invoke/:channel` — and a
 * second copy of this list would drift the first time a domain is added, with
 * the failure mode being "the new feature works in the desktop app and 403s
 * over the web". So there is one list, here, and both transports import it.
 *
 * `src/shared/` is the only folder both the preload bundle (CommonJS, built by
 * `tsconfig.main.json`) and the renderer bundle (ESM, built by Vite) can reach.
 */
export const ALLOWED_CHANNEL_PREFIXES = [
  "dialog:",
  "library:",
  "activity:",
  "scan:",
  "app:",
  "shadow:",
  "device:",
  "genius:",
  "sync:",
  "playlist:",
  "savant:",
  "assistant:",
  "settings:",
  "harmonic:",
  "ratings:",
  "player:",
  "podcast:",
  "audiobook:",
  "server:",
] as const;

export function isAllowedChannel(channel: string): boolean {
  return (
    typeof channel === "string" &&
    ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p))
  );
}

/**
 * The push channels a client may subscribe to.
 *
 * Over Electron IPC `ipcRenderer.on` accepts anything the main process sends,
 * because there is exactly one renderer and it is ours. A server fans these out
 * to *sessions*, so the set has to be closed: a client must not be able to
 * subscribe to a channel name it invents and receive another user's frames.
 */
export const PUSH_CHANNELS = [
  "scan:progress",
  "shadow:buildProgress",
  "sync:progress",
  "savant:backfillProgress",
  "audiobook:coverUpdated",
  "assistant:triggerSync",
  "assistant:triggerLibraryScan",
  "assistant:triggerShadowRebuild",
] as const;

export type PushChannel = (typeof PUSH_CHANNELS)[number];

export function isPushChannel(channel: string): channel is PushChannel {
  return (PUSH_CHANNELS as readonly string[]).includes(channel);
}
