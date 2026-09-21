/**
 * Playwright E2E — the HTTP surface's two coarse guards, over the real daemon.
 *
 * `src/__tests__/regressions/request-guards.test.ts` pins the decision matrix,
 * which is mostly header combinations no browser will produce to order. What it
 * cannot show is that the guards are actually *mounted*, in front of the routes
 * that matter and not in front of the one that must stay unlimited. That is
 * what this spec is for: three rounds of correct guard code have already been
 * written in this repo against the wrong client (see `web-add-device-form`),
 * and a middleware nobody reaches is the same class of mistake.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect } from "@playwright/test";
import { WEB_ORIGIN, signIn } from "./web-harness";

const FOREIGN = "https://evil.example";
/** A read channel with no arguments and no side effects. */
const HARMLESS_CHANNEL = "app:getMpcRemindDisabled";

test.beforeEach(async ({ request }) => {
  await signIn(request);
});

test("a state-changing API call from another origin is refused", async ({ request }) => {
  const refused = await request.post(`/api/invoke/${HARMLESS_CHANNEL}`, {
    headers: { origin: FOREIGN },
    data: { args: [] },
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toEqual({ error: "Cross-origin request refused" });

  // The control, and the reason the guard admits an absent `Origin`: CSRF needs
  // a browser, and this harness is not one. Refusing here would lock out every
  // script that drives the API while buying nothing.
  const allowed = await request.post(`/api/invoke/${HARMLESS_CHANNEL}`, {
    data: { args: [] },
  });
  expect(allowed.status()).toBe(200);
});

test("the app's own origin is admitted", async ({ request }) => {
  const res = await request.post(`/api/invoke/${HARMLESS_CHANNEL}`, {
    headers: { origin: WEB_ORIGIN },
    data: { args: [] },
  });
  expect(res.status()).toBe(200);
});

test("Sec-Fetch-Site is believed over the Origin header", async ({ request }) => {
  const res = await request.post(`/api/invoke/${HARMLESS_CHANNEL}`, {
    headers: { origin: WEB_ORIGIN, "sec-fetch-site": "cross-site" },
    data: { args: [] },
  });
  expect(res.status()).toBe(403);
});

test("a cross-origin GET is not refused, because the OAuth callback is one", async ({
  request,
}) => {
  // `GET /api/auth/<provider>/callback` arrives from the provider. Guarding
  // safe methods would break every social login, and nothing reachable by GET
  // changes state.
  const res = await request.get("/api/auth/status", {
    headers: { origin: FOREIGN },
  });
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty("authenticated");
});

test("the control plane and the auth surface are rate-limited; the device data plane is not", async ({
  request,
}) => {
  // `standardHeaders: "draft-7"` makes the limiter announce itself, which is
  // what lets this assert the wiring without spending anyone's budget — the
  // daemon is shared by every spec in this project.
  const invoked = await request.post(`/api/invoke/${HARMLESS_CHANNEL}`, {
    data: { args: [] },
  });
  expect(invoked.status()).toBe(200);
  expect(invoked.headers()["ratelimit"]).toBeTruthy();

  const status = await request.get("/api/auth/status");
  expect(status.headers()["ratelimit"]).toBeTruthy();

  // Deliberately absent: a sync is one request per file, so copying a
  // twenty-thousand-track library is tens of thousands of requests as fast as
  // the wire allows. Any ceiling low enough to be protection stops a library
  // copying. The token refusal below is the route answering, which is the
  // point — the header is missing because no limiter is in front of it, not
  // because the request never arrived.
  const deviceIo = await request.get("/api/device-io/read/not-a-real-token");
  expect(deviceIo.status()).toBeGreaterThanOrEqual(400);
  expect(deviceIo.headers()["ratelimit"]).toBeUndefined();
});
