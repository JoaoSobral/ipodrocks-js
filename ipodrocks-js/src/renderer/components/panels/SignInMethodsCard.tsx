import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PROVIDER_LABELS, isProvider } from "@shared/auth-providers";
import { Button } from "../common/Button";
import { Card } from "../common/Card";
import { Input } from "../common/Input";
import {
  changeMyPassword,
  isWebServerDenied,
  listMySignInLinks,
  removeMySignInLink,
  startSignInLink,
  type SignInLink,
} from "../../ipc/api";
import { fetchAuthStatus, type AuthStatus } from "../../ipc/web-transport";

function label(provider: string): string {
  return isProvider(provider) ? PROVIDER_LABELS[provider] : provider;
}

/**
 * Settings → Sign-in methods. Web mode only.
 *
 * Lets whoever is signed in attach another provider account to *their own*
 * account, so the owner can admit themselves on Google without ever learning
 * their Google user id. The link is made by the callback, not here: this card
 * only asks the server to remember that the next round trip is a link, then
 * sends the browser to the provider.
 */
export function SignInMethodsCard({ open }: { open: boolean }) {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [links, setLinks] = useState<SignInLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [status, mine] = await Promise.all([fetchAuthStatus(), listMySignInLinks()]);
    setAuth(status);
    if (isWebServerDenied(mine)) {
      setError(mine.error);
      setLinks([]);
    } else {
      setLinks(mine.links);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err))
    );
  }, [open, load]);

  async function connect(provider: string) {
    setBusy(true);
    setError(null);
    const result = await startSignInLink(provider);
    if (isWebServerDenied(result)) {
      setError(result.error);
      setBusy(false);
      return;
    }
    // A full navigation: the provider's consent page, then the callback,
    // which redirects back here with `?auth=linked`.
    window.location.href = result.url;
  }

  async function remove(link: SignInLink) {
    setBusy(true);
    setError(null);
    try {
      const result = await removeMySignInLink(link.id);
      if (isWebServerDenied(result)) {
        setError(result.error);
        return;
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  const user = auth?.user ?? null;
  const linkedProviders = new Set(links.map((l) => l.provider));
  // One link per provider is the common case and keeps the buttons honest;
  // the server would accept a second Google account, but nobody needs the
  // button for it.
  const connectable = (auth?.providers ?? []).filter((p) => !linkedProviders.has(p));

  return (
    <Card
      title="Sign-in methods"
      subtitle="Other accounts that sign you in to this server as you."
    >
      <div className="space-y-4" data-testid="sign-in-methods">
        {user && (
          <p className="text-xs text-muted-foreground">
            Signed in as{" "}
            <span className="text-foreground">
              {user.displayName ?? user.email ?? "this account"}
            </span>{" "}
            ({label(user.provider)}).
          </p>
        )}

        {links.length > 0 && (
          <ul className="space-y-2">
            {links.map((link) => (
              <li
                key={link.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-foreground">{label(link.provider)}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {link.email ?? link.displayName ?? link.subject}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void remove(link)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}

        {connectable.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {connectable.map((p) => (
              <Button
                key={p}
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => void connect(p)}
              >
                Connect {label(p)}
              </Button>
            ))}
          </div>
        ) : (
          auth &&
          auth.providers.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No sign-in provider is configured on this server.
            </p>
          )
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        {user?.provider === "local" && <ChangePasswordForm />}
      </div>
    </Card>
  );
}

/**
 * A local account changing its own password. The server checks the current
 * one on the login form's rate-limit bucket, and signs out every other browser
 * on this account — this one stays signed in.
 */
function ChangePasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (next !== repeat) {
      setError("The new passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const result = await changeMyPassword(current, next);
      if (isWebServerDenied(result)) {
        setError(result.error);
        return;
      }
      setCurrent("");
      setNext("");
      setRepeat("");
      toast.success(
        result.signedOut > 0
          ? `Password changed. ${result.signedOut} other browser(s) were signed out.`
          : "Password changed."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-2 border-t border-border pt-4"
      data-testid="change-password"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm font-medium text-foreground">Change password</p>
      <Input
        id="current-password"
        type="password"
        autoComplete="current-password"
        placeholder="Current password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <div className="grid grid-cols-2 gap-2">
        <Input
          id="next-password"
          type="password"
          autoComplete="new-password"
          placeholder="New password (12+ characters)"
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <Input
          id="repeat-password"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat new password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </div>
      <Button
        size="sm"
        variant="secondary"
        type="submit"
        disabled={busy || !current || !next || !repeat}
      >
        Change password
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

const LINK_FAILURES: Record<string, string> = {
  already_used:
    "That account is already used to sign in to this server, by you or by someone else.",
  no_identity: "Your account no longer exists on this server.",
};

/**
 * The link callback redirects to `/?auth=linked` or `/?auth=link_failed`.
 * Called once by the app after it mounts: says what happened, then strips the
 * query so a reload does not say it again.
 */
export function announceLinkResult(): void {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("auth");
  if (outcome !== "linked" && outcome !== "link_failed") return;
  if (outcome === "linked") {
    toast.success("Sign-in method connected.");
  } else {
    toast.error(
      LINK_FAILURES[params.get("reason") ?? ""] ?? "That sign-in method could not be connected."
    );
  }
  params.delete("auth");
  params.delete("reason");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`
  );
}
