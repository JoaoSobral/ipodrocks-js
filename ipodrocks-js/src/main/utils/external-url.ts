import { shell } from "electron";

/**
 * Schemes we are willing to hand to the OS. Anything else (file:, smb:,
 * javascript:, custom protocol handlers, …) is rejected so a renderer — or
 * remote content that somehow reaches a window-open/navigation — cannot use
 * the main process to launch arbitrary local handlers.
 */
const ALLOWED_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** Returns true if the URL is safe to pass to `shell.openExternal`. */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  return ALLOWED_SCHEMES.has(parsed.protocol);
}

/**
 * Opens a URL in the user's default browser/mail client after validating its
 * scheme. Rejects (without throwing) anything outside the allowlist.
 */
export async function openExternalUrl(rawUrl: string): Promise<{ ok: boolean }> {
  if (!isAllowedExternalUrl(rawUrl)) return { ok: false };
  await shell.openExternal(rawUrl);
  return { ok: true };
}
