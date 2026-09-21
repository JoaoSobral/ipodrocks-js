import { useState } from "react";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import type { AuthStatus } from "../../ipc/web-transport";

/**
 * The web mode login screen.
 *
 * It renders *before* the app, in place of it, because `window.api` calls
 * against an unauthenticated session all 401 and the panels have no sensible
 * state to show. Two paths: the first-run owner claim, and an ordinary login.
 *
 * The claim form only appears while the server has no owner at all. That is
 * the server's answer, not a guess from the client — `needsOwnerClaim` comes
 * from `/api/auth/status`, and the claim itself is refused server-side once an
 * identity exists, so a stale page cannot be used to create a second one.
 */

const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  facebook: "Facebook",
};

interface LoginScreenProps {
  auth: AuthStatus;
  onAuthenticated: () => void;
}

export function LoginScreen({ auth, onAuthenticated }: LoginScreenProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [claimToken, setClaimToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError());

  const claiming = auth.needsOwnerClaim;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const endpoint = claiming ? "/api/auth/local/claim" : "/api/auth/local/login";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(
          claiming ? { username, password, claimToken } : { username, password }
        ),
      });
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setError(body?.error ?? `Sign-in failed (HTTP ${res.status})`);
        return;
      }
      onAuthenticated();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-semibold text-foreground">iPodRocks</h1>
          <p className="text-sm text-muted-foreground">
            {claiming
              ? "Claim this server to finish setting it up."
              : "Sign in to continue."}
          </p>
        </div>

        {claiming && (
          <p className="text-xs text-muted-foreground bg-secondary/50 border border-border rounded-lg p-3">
            Nobody owns this server yet. The one-time claim token was printed to
            the server log when it started — whoever can read that log already
            controls the machine, which is why it is safe to use as the
            bootstrap.
          </p>
        )}

        <form className="space-y-3" onSubmit={submit}>
          {claiming && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-foreground">
                Claim token
              </label>
              <Input
                value={claimToken}
                onChange={(e) => setClaimToken(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="From the server log"
              />
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">Username</label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-foreground">Password</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={claiming ? "new-password" : "current-password"}
            />
            {claiming && (
              <p className="text-xs text-muted-foreground">
                At least 12 characters.
              </p>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            type="submit"
            variant="primary"
            className="w-full"
            disabled={busy}
          >
            {busy ? "Signing in…" : claiming ? "Claim server" : "Sign in"}
          </Button>
        </form>

        {auth.providers.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <div className="h-px flex-1 bg-border" />
              <span className="text-xs text-muted-foreground">or</span>
              <div className="h-px flex-1 bg-border" />
            </div>
            {auth.providers.map((p) => (
              <a
                key={p}
                className="block"
                href={
                  claiming && claimToken
                    ? `/api/auth/${p}?claimToken=${encodeURIComponent(claimToken)}`
                    : `/api/auth/${p}`
                }
              >
                <Button className="w-full" type="button">
                  Continue with {PROVIDER_LABELS[p] ?? p}
                </Button>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The OAuth callback redirects back with a reason rather than rendering its
 *  own page, so a failed social login lands here with something to say. */
function initialError(): string | null {
  const reason = new URLSearchParams(window.location.search).get("auth");
  if (reason === "not_allowed") {
    return "That account is not on this server's allowlist.";
  }
  if (reason === "provider_failed") {
    return "The sign-in provider rejected the request.";
  }
  return null;
}
