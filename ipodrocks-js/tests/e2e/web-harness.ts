/**
 * Helpers for the `web` Playwright project.
 *
 * The daemon under test is the real one, started by `playwright.config.ts`'s
 * `webServer` block against a scratch data directory. Nothing here reaches
 * inside the app: the only thing read out of band is the owner claim token,
 * which a real operator reads from the server log. A test cannot read that log
 * through Playwright, so it reads the same value from the row the server wrote
 * it to — which is also worth doing deliberately, because it means the claim
 * flow itself is exercised end to end rather than stubbed.
 */
import * as path from "path";
import Database from "better-sqlite3";
import type { APIRequestContext, Page } from "@playwright/test";
import { WEB_DATA_DIR, WEB_ORIGIN } from "../../playwright.config";

export { WEB_DATA_DIR, WEB_ORIGIN };

export const OWNER_USERNAME = "e2e-owner";
export const OWNER_PASSWORD = "correct-horse-battery-staple";

function serverDb(): Database.Database {
  return new Database(path.join(WEB_DATA_DIR, "ipodrocks-server.db"), {
    readonly: true,
  });
}

export function readClaimToken(): string | null {
  const db = serverDb();
  try {
    const row = db
      .prepare("SELECT value FROM server_settings WHERE key = 'owner_claim_token'")
      .get() as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * Deletes a device row directly.
 *
 * For the one case a test cannot clean up through the app: a server-attached
 * device, which the web client is now refused — correctly — the right to
 * remove. Reaching past the app is otherwise exactly what this harness avoids.
 */
export function removeDeviceRow(deviceId: number): void {
  const db = new Database(path.join(WEB_DATA_DIR, "ipodrock.db"));
  try {
    db.prepare("DELETE FROM devices WHERE id = ?").run(deviceId);
  } finally {
    db.close();
  }
}

/**
 * Inserts a server-attached device straight into the library database.
 *
 * `device:add` from a browser now always creates a *remote* device — a web
 * client registering `transport: "local"` with a mount path of its own
 * choosing is how a host volume reached `device:eject`. So a spec that needs a
 * server-side device to prove the locality guard refuses it can no longer
 * build one through the app, and reaches past it here instead. That is the
 * same exception `removeDeviceRow` already makes, for the same reason.
 */
export function seedLocalDeviceRow(name: string, mountPath: string): number {
  const db = new Database(path.join(WEB_DATA_DIR, "ipodrock.db"));
  try {
    const mode = db
      .prepare("SELECT id FROM device_transfer_modes WHERE name = 'copy'")
      .get() as { id: number } | undefined;
    const info = db
      .prepare(
        `INSERT INTO devices (name, mount_path, default_transfer_mode_id, transport)
         VALUES (?, ?, ?, 'local')`
      )
      .run(name, mountPath, mode?.id ?? null);
    return Number(info.lastInsertRowid);
  } finally {
    db.close();
  }
}

export function ownerExists(): boolean {
  const db = serverDb();
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM server_identities")
      .get() as { n: number };
    return row.n > 0;
  } finally {
    db.close();
  }
}

/**
 * Claims the server if nobody has, then signs in.
 *
 * Idempotent, because the `web` project runs several spec files against one
 * long-lived daemon and only the first of them meets an unclaimed server.
 */
export async function signIn(request: APIRequestContext): Promise<void> {
  if (!ownerExists()) {
    const claimToken = readClaimToken();
    if (!claimToken) throw new Error("No owner and no claim token — server not ready");
    const res = await request.post("/api/auth/local/claim", {
      data: { username: OWNER_USERNAME, password: OWNER_PASSWORD, claimToken },
    });
    if (!res.ok()) {
      throw new Error(`Claim failed: ${res.status()} ${await res.text()}`);
    }
    return;
  }
  const res = await request.post("/api/auth/local/login", {
    data: { username: OWNER_USERNAME, password: OWNER_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(`Login failed: ${res.status()} ${await res.text()}`);
  }
}

/** Signs a browser page's context in, so `page.goto("/")` lands on the app
 *  rather than the login screen. */
export async function signInPage(page: Page): Promise<void> {
  await signIn(page.request);
}

export interface InvokeResponse<T> {
  result: T | null;
  error?: string;
}

/** Calls a channel the way the renderer's web transport does. */
export async function invoke<T = unknown>(
  request: APIRequestContext,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  const res = await request.post(`/api/invoke/${encodeURIComponent(channel)}`, {
    data: { args },
  });
  if (!res.ok()) {
    throw new Error(`invoke ${channel} failed: ${res.status()} ${await res.text()}`);
  }
  const body = (await res.json()) as InvokeResponse<T>;
  return body.result as T;
}

/**
 * Silences the "mpcenc is not installed" reminder for the duration of a spec,
 * and returns the previous setting so the caller can put it back.
 *
 * Any spec that *renders* a panel needs this, and it is not optional dressing:
 * `DevicePanel` pops `MpcUnavailableModal` on its own as soon as the codec
 * configs and the mpcenc probe have both answered, and a modal backdrop
 * (`fixed inset-0`) swallows every click behind it. On a host with mpcenc
 * installed the spec passes; on one without — which is every CI runner, and
 * `musepack-tools` is not installed in the e2e workflow — the modal is up by
 * the time the first click lands and the test times out waiting for an element
 * that is visible, enabled, stable and unreachable.
 *
 * Dismissing the modal from the spec instead would be a race: it appears after
 * two independent IPC round trips, so "close it if it is there" can run before
 * it arrives. The preference is the deterministic lever.
 */
export async function setMpcReminderDisabled(
  request: APIRequestContext,
  disabled: boolean
): Promise<boolean> {
  const before = await invoke<{ disabled: boolean }>(
    request,
    "app:getMpcRemindDisabled"
  );
  await invoke(request, "app:setMpcRemindDisabled", disabled);
  return before.disabled;
}
