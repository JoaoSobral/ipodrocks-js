import { useEffect, useState } from "react";
import { getWebTransport, type ConnectionState } from "../../ipc/web-transport";

/**
 * A slim strip at the top of the window saying what the link to the server is
 * doing. Web mode only — the desktop app has no link to lose.
 *
 * It exists because every failure mode it names used to surface as something
 * else: a panel stuck on its spinner, a sync "failing" that was still running,
 * a generic "HTTP 524". Saying "reconnecting" once, in one place, is what lets
 * every panel underneath simply wait.
 */
export function ConnectionBanner() {
  const transport = getWebTransport();
  const [state, setState] = useState<ConnectionState>(
    () => transport?.getConnectionState() ?? { status: "online", updateAvailable: false }
  );

  useEffect(() => {
    if (!transport) return;
    setState(transport.getConnectionState());
    return transport.onConnectionChange(setState);
  }, [transport]);

  if (!transport) return null;

  let message: string | null = null;
  let action: { label: string; run: () => void } | null = null;
  let tone = "bg-warning/20 text-warning";

  switch (state.status) {
    case "reconnecting":
      message = "Connection to the server lost — reconnecting…";
      action = { label: "Retry now", run: () => transport.reconnectNow() };
      break;
    case "offline":
      message = "You are offline. iPodRocks will reconnect when the network is back.";
      break;
    case "signed-out":
      message = "You have been signed out.";
      action = { label: "Sign in again", run: () => window.location.reload() };
      tone = "bg-destructive/15 text-destructive";
      break;
    default:
      break;
  }

  if (!message && state.updateAvailable) {
    message = "iPodRocks was updated on the server.";
    action = { label: "Reload", run: () => window.location.reload() };
    tone = "bg-primary/15 text-primary";
  }

  if (!message) return null;

  return (
    <div
      role="status"
      data-testid="connection-banner"
      data-status={state.status}
      className={`fixed inset-x-0 top-0 z-[60] flex items-center justify-center gap-3 px-3 py-1 text-xs ${tone}`}
    >
      <span>{message}</span>
      {action && (
        <button type="button" className="underline font-medium" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  );
}
