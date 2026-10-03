/**
 * The sign-in providers, as one list.
 *
 * `"google" | "github" | "facebook"` used to be spelled out by hand in the
 * config loader, the passport wiring, the status route, the allowlist route,
 * the IPC handler, the Rocksy tool's enum and the login screen's labels. A
 * provider added to some of them and not others is the "works on the login
 * screen, 400s on the allowlist" kind of bug, so every one of those now reads
 * from here.
 *
 * In `src/shared/` because the renderer needs the labels and the server needs
 * the rest — see the note at the top of `ipc-channels.ts`.
 */
export const OAUTH_PROVIDERS = ["google", "github", "facebook"] as const;

export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/** Every way an identity can sign in: a third-party provider, or a local
 *  password account. */
export type Provider = OAuthProvider | "local";

export const PROVIDERS: readonly Provider[] = [...OAUTH_PROVIDERS, "local"];

export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return (
    typeof value === "string" && (OAUTH_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isProvider(value: unknown): value is Provider {
  return value === "local" || isOAuthProvider(value);
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  google: "Google",
  github: "GitHub",
  facebook: "Facebook",
  local: "Password",
};
