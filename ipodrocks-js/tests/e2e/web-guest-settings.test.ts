/**
 * Playwright E2E — a signed-in guest cannot rewrite the server's settings, and
 * Rocksy is not a way around that.
 *
 * `settings:*` writes one `ipodrocks-prefs.json` for the whole server, and
 * `/api/invoke` only checks that a caller is authenticated. Before the gate,
 * any allowlisted account could swap the OpenRouter key for one of its own —
 * after which the owner's Rocksy prompts (library context, chat history, the
 * app-data paths the system prompt carries) went to an account the guest could
 * read. The load-bearing assertions are that every setter refuses the guest,
 * that the owner's values are unchanged afterwards, and that the guest's copy
 * of the OpenRouter config carries no key material.
 *
 * The Rocksy half goes through `assistant:confirmAction`, which runs a
 * client-named tool directly: `ratings_set_tag_priority` must refuse the
 * guest's write the way `settings:setRatingPrefs` does. (`usb_device_list` is
 * pinned in `regressions/web-guest-assistant-tools.test.ts` — confirmAction
 * folds a tool's result into a sentence, so its devices are not visible here.)
 *
 * The handler-level twin, including the logout race that cannot be driven
 * deterministically here, is `src/__tests__/regressions/web-caller-scope.test.ts`.
 *
 * Run with: `npm run build && npx playwright test --project=web`
 */
import { test, expect, request as playwrightRequest } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import { WEB_ORIGIN, invoke, signIn } from "./web-harness";

test.describe.configure({ mode: "serial" });

// Its own account, so this spec never collides with web-identities' guest.
const GUEST_USERNAME = "e2e-settings-guest";
const GUEST_PASSWORD = "a-perfectly-fine-settings-password";

interface Identity {
  id: number;
  subject: string;
}

let guest: APIRequestContext;

async function removeGuest(owner: APIRequestContext): Promise<void> {
  const res = await invoke<{ identities?: Identity[] }>(owner, "server:listIdentities");
  const found = (res.identities ?? []).find((i) => i.subject === GUEST_USERNAME);
  if (found) await invoke(owner, "server:revokeIdentity", found.id);
}

test.beforeAll(async ({ request }) => {
  await signIn(request);
  await removeGuest(request);
  await invoke(request, "server:allowIdentity", {
    provider: "local",
    subject: GUEST_USERNAME,
    displayName: "E2E Settings Guest",
    password: GUEST_PASSWORD,
  });
  guest = await playwrightRequest.newContext({ baseURL: WEB_ORIGIN });
  const login = await guest.post("/api/auth/local/login", {
    data: { username: GUEST_USERNAME, password: GUEST_PASSWORD },
  });
  expect(login.ok()).toBe(true);
});

test.afterAll(async ({ request }) => {
  await guest?.dispose();
  await signIn(request);
  await removeGuest(request);
});

test("a guest is refused by every server-wide settings setter", async ({ request }) => {
  await signIn(request);

  // The control: an ordinary channel works for this guest, so the refusals
  // below are the gate and not a broken login.
  expect((await invoke<{ error?: string }>(guest, "library:getStats")).error).toBeUndefined();

  const ratingBefore = await invoke<{ tagRatingAlwaysWins?: boolean }>(
    request,
    "settings:getRatingPrefs"
  );
  const harmonicBefore = await invoke<Record<string, unknown>>(
    request,
    "settings:getHarmonicPrefs"
  );
  const orBefore = await invoke<Record<string, unknown> | null>(
    request,
    "settings:getOpenRouterConfig"
  );

  for (const [channel, arg] of [
    ["settings:setOpenRouterConfig", { apiKey: "sk-or-e2e-attacker", model: "evil/model" }],
    ["settings:setOpenRouterConfig", null],
    ["settings:setHarmonicPrefs", { analyzeWithEssentia: true, analyzePercent: 100 }],
    ["settings:setRatingPrefs", { tagRatingAlwaysWins: !(ratingBefore.tagRatingAlwaysWins ?? false) }],
  ] as const) {
    const res = await invoke<{ error?: string } | null>(guest, channel, arg);
    expect(res?.error, `${channel} must refuse a non-owner`).toContain("owner");
  }

  const tested = await invoke<{ ok: boolean; error?: string }>(
    guest,
    "settings:testOpenRouter",
    { apiKey: "sk-or-e2e-anything", model: "x" }
  );
  expect(tested.ok).toBe(false);
  expect(tested.error).toContain("owner");

  // Nothing took effect.
  expect(await invoke(request, "settings:getRatingPrefs")).toEqual(ratingBefore);
  expect(await invoke(request, "settings:getHarmonicPrefs")).toEqual(harmonicBefore);
  expect(await invoke(request, "settings:getOpenRouterConfig")).toEqual(orBefore);
});

test("a guest's copy of the OpenRouter config carries no key material", async ({ request }) => {
  await signIn(request);
  const before = await invoke<{ apiKey: string } | null>(
    request,
    "settings:getOpenRouterConfig"
  );
  // The stored key can only ever be read back masked, so a spec that replaced
  // a real one could not put it back. The e2e daemon starts with none.
  test.skip(before !== null, "an OpenRouter key is already configured on this daemon");

  await invoke(request, "settings:setOpenRouterConfig", {
    apiKey: "sk-or-e2e-owner-key-9876",
    model: "owner/e2e-model",
  });
  try {
    const seen = await invoke<{ apiKey: string; model: string }>(
      guest,
      "settings:getOpenRouterConfig"
    );
    // Still truthy — the guest's FloatChat decides whether to offer Rocksy
    // from exactly this.
    expect(seen.apiKey.trim()).not.toBe("");
    expect(JSON.stringify(seen)).not.toContain("9876");
    expect(JSON.stringify(seen)).not.toContain("owner/e2e-model");

    // And the owner still sees their own last four, the control.
    const owned = await invoke<{ apiKey: string }>(request, "settings:getOpenRouterConfig");
    expect(owned.apiKey.endsWith("9876")).toBe(true);
  } finally {
    // Put it back; the daemon is shared by every spec in this project.
    await invoke(request, "settings:setOpenRouterConfig", null);
  }
});

test("Rocksy's tag-priority switch refuses a guest's write", async ({ request }) => {
  await signIn(request);
  const before = await invoke<{ tagRatingAlwaysWins?: boolean }>(
    request,
    "settings:getRatingPrefs"
  );
  const res = await invoke<{ reply?: string }>(guest, "assistant:confirmAction", {
    toolCallId: "e2e",
    tool: "ratings_set_tag_priority",
    args: { enabled: !(before.tagRatingAlwaysWins ?? false) },
    summary: "Flip tag priority",
  });
  expect(res.reply).toMatch(/failed/i);
  expect(await invoke(request, "settings:getRatingPrefs")).toEqual(before);
});
