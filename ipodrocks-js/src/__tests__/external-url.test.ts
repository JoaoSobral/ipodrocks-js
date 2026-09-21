/**
 * @vitest-environment node
 */
import { describe, it, expect, vi } from "vitest";

// external-url.ts reaches the browser through the host adapter rather than
// Electron's `shell` directly, so the stub goes there: a host registered for
// this test records what it was asked to open. `vi.hoisted` keeps the mock fn
// accessible from the hoisted vi.mock factory.
const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn(async (_url: string) => ({ opened: true })),
}));
vi.mock("../main/host", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../main/host")>();
  return { ...actual, getHostShell: () => ({ openExternal }) };
});

import { isAllowedExternalUrl, openExternalUrl } from "../main/utils/external-url";

describe("isAllowedExternalUrl", () => {
  it("allows http, https, and mailto", () => {
    expect(isAllowedExternalUrl("http://example.com")).toBe(true);
    expect(isAllowedExternalUrl("https://example.com/path?q=1")).toBe(true);
    expect(isAllowedExternalUrl("mailto:someone@example.com")).toBe(true);
  });

  it("rejects file, smb, javascript and custom schemes", () => {
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("smb://server/share")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("vscode://foo")).toBe(false);
  });

  it("rejects empty, non-string, and unparseable input", () => {
    expect(isAllowedExternalUrl("")).toBe(false);
    expect(isAllowedExternalUrl("   ")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    // @ts-expect-error intentionally passing a non-string
    expect(isAllowedExternalUrl(null)).toBe(false);
  });
});

describe("openExternalUrl", () => {
  it("forwards allowed URLs to the host shell", async () => {
    openExternal.mockClear();
    const res = await openExternalUrl("https://example.com");
    expect(res).toEqual({ ok: true });
    expect(openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("does not open disallowed URLs", async () => {
    openExternal.mockClear();
    const res = await openExternalUrl("file:///etc/passwd");
    expect(res).toEqual({ ok: false });
    expect(openExternal).not.toHaveBeenCalled();
  });
});
