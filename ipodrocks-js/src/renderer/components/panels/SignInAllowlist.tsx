import { useCallback, useEffect, useState } from "react";
import { PROVIDER_LABELS, isProvider } from "@shared/auth-providers";
import { Button } from "../common/Button";
import {
  approveAccessRequest,
  dismissAccessRequest,
  isWebServerDenied,
  listAccessRequests,
  listServerIdentities,
  removeServerLink,
  revokeServerIdentity,
  type AccessRequest,
  type ServerIdentity,
} from "../../ipc/api";

function label(provider: string): string {
  return isProvider(provider) ? PROVIDER_LABELS[provider] : provider;
}

/**
 * Settings → Web Server → Who can sign in. Owner only — the parent card does
 * not render it for anyone the server refuses.
 *
 * Two lists: the allowlist with each account's linked sign-in methods, and the
 * provider logins the allowlist refused, waiting for a yes or no. A request's
 * display name is whatever the person typed into their Google profile, so the
 * provider, the email and whether it is verified are always shown beside it —
 * "Pedro" is not evidence of anything.
 */
export function SignInAllowlist({ open }: { open: boolean }) {
  const [identities, setIdentities] = useState<ServerIdentity[]>([]);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Removing an account is two clicks: the first arms, the second does it.
  const [armedRemoval, setArmedRemoval] = useState<number | null>(null);

  const load = useCallback(async () => {
    const [ids, reqs] = await Promise.all([listServerIdentities(), listAccessRequests()]);
    if (isWebServerDenied(ids)) {
      setError(ids.error);
      return;
    }
    if (isWebServerDenied(reqs)) {
      setError(reqs.error);
      return;
    }
    setIdentities(ids.identities);
    setRequests(reqs.requests);
  }, []);

  useEffect(() => {
    if (!open) return;
    setArmedRemoval(null);
    void load();
  }, [open, load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      if (
        typeof result === "object" &&
        result !== null &&
        isWebServerDenied(result as { error: string })
      ) {
        setError((result as { error: string }).error);
      }
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4" data-testid="sign-in-allowlist">
      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Who can sign in</p>
        <ul className="space-y-2">
          {identities.map((identity) => (
            <li
              key={identity.id}
              className="rounded-lg border border-border px-3 py-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">
                    {identity.displayName ?? identity.subject}
                    {identity.isOwner && (
                      <span className="ml-2 text-xs text-muted-foreground">owner</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {label(identity.provider)}
                    {identity.email ? ` · ${identity.email}` : ""}
                  </p>
                </div>
                {!identity.isOwner && (
                  <Button
                    size="sm"
                    variant={armedRemoval === identity.id ? "danger" : "secondary"}
                    disabled={busy}
                    onClick={() => {
                      if (armedRemoval !== identity.id) {
                        setArmedRemoval(identity.id);
                        return;
                      }
                      setArmedRemoval(null);
                      void run(() => revokeServerIdentity(identity.id));
                    }}
                  >
                    {armedRemoval === identity.id ? "Confirm remove" : "Remove"}
                  </Button>
                )}
              </div>
              {identity.links.map((link) => (
                <div
                  key={link.id}
                  className="flex items-center justify-between gap-3 pl-3 border-l border-border"
                >
                  <p className="text-xs text-muted-foreground truncate">
                    also signs in with {label(link.provider)}
                    {link.email ? ` · ${link.email}` : ""}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => removeServerLink(link.id))}
                  >
                    Unlink
                  </Button>
                </div>
              ))}
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium text-foreground">Waiting for approval</p>
        {requests.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nobody. When someone signs in with an account that is not on the list,
            it shows up here.
          </p>
        ) : (
          <ul className="space-y-2">
            {requests.map((req) => (
              <li
                key={req.id}
                data-testid="access-request"
                className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-sm text-foreground truncate">
                    {req.displayName ?? "Unnamed account"}
                  </p>
                  <p className="text-xs text-muted-foreground truncate">
                    {label(req.provider)} ·{" "}
                    {req.email
                      ? `${req.email}${req.emailVerified ? "" : " (unverified)"}`
                      : "no email"}{" "}
                    · id {req.subject} · {req.attempts}{" "}
                    {req.attempts === 1 ? "attempt" : "attempts"}, last{" "}
                    {new Date(req.lastSeenAt).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void run(() => approveAccessRequest(req.id))}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void run(() => dismissAccessRequest(req.id))}
                  >
                    Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
