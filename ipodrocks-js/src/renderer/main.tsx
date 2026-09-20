import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "./App";
import { LoginScreen } from "./components/web/LoginScreen";
import {
  fetchAuthStatus,
  installWebTransport,
  isWebMode,
  type AuthStatus,
} from "./ipc/web-transport";
import "./index.css";

/**
 * The bootstrap.
 *
 * Under Electron the preload has already installed `window.api` by the time
 * this module runs, so this is the twelve-line render it always was. Served
 * over HTTP there is no preload: the transport has to be installed and its
 * WebSocket opened *before* React mounts, or the first panel to subscribe in an
 * effect races the handshake and silently misses the frames it was waiting for.
 */

const container = document.getElementById("root");

function renderApp(root: Root): void {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

function renderLogin(root: Root, auth: AuthStatus): void {
  root.render(
    <StrictMode>
      <LoginScreen
        auth={auth}
        onAuthenticated={() => {
          // A full reload rather than a re-render: the transport has to open
          // its socket against the *new* session, and the session id changed
          // when it was regenerated at login.
          window.location.reload();
        }}
      />
    </StrictMode>
  );
}

function renderStartupError(root: Root, message: string): void {
  root.render(
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-sm text-center space-y-2">
        <h1 className="text-lg font-semibold text-foreground">
          iPodRocks could not start
        </h1>
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

async function bootstrap(): Promise<void> {
  if (!container) return;
  const root = createRoot(container);

  if (!isWebMode()) {
    renderApp(root);
    return;
  }

  try {
    const { auth } = await installWebTransport();
    if (auth.authenticated) renderApp(root);
    else renderLogin(root, auth);
  } catch (err) {
    // A failed bootstrap in web mode is almost always "the server restarted
    // under us". Re-check the auth state so the user gets the login screen
    // rather than a dead page.
    try {
      const auth = await fetchAuthStatus();
      if (!auth.authenticated) {
        renderLogin(root, auth);
        return;
      }
    } catch {
      // Fall through to the error screen below.
    }
    renderStartupError(
      root,
      err instanceof Error ? err.message : "Could not reach the server."
    );
  }
}

void bootstrap();
