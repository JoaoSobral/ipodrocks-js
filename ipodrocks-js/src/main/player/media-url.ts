/**
 * How a server-side file path becomes a URL the renderer can put in an
 * `<audio src>` or an `<img src>`.
 *
 * Under Electron that is `media://local/<base64url>` — a privileged scheme
 * registered by `media-protocol.ts`, which the renderer reaches directly. Over
 * the web server there is no such scheme and no shared filesystem, so it
 * becomes `/api/media/<token>`; `src/server/http.ts` installs the encoder that
 * mints those tokens.
 *
 * A hook rather than a `getHost().kind` check because the encoder needs
 * something the host adapter has no business knowing about: the HMAC key and
 * the calling session. Keeping it a registration also means the desktop app is
 * unchanged until something registers, so the default path stays the one
 * that ships.
 */

export type MediaUrlEncoder = (filePath: string, sessionId?: string) => string;

let encoder: MediaUrlEncoder | null = null;

export function setMediaUrlEncoder(fn: MediaUrlEncoder | null): void {
  encoder = fn;
}

export function encodePathToUrl(filePath: string, sessionId?: string): string {
  if (encoder) return encoder(filePath, sessionId);
  return `media://local/${Buffer.from(filePath, "utf8").toString("base64url")}`;
}

export function decodeUrlToPath(url: string): string {
  const u = new URL(url);
  return Buffer.from(u.pathname.slice(1), "base64url").toString("utf8");
}
