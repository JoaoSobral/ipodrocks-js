/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { getEncoderEnv } from "../main/utils/encoder-env";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getEncoderEnv", () => {
  it("includes /opt/homebrew/bin in PATH on non-Windows", () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    vi.stubEnv("HOME", "/Users/test");
    const result = getEncoderEnv();
    expect(result.PATH).toContain("/opt/homebrew/bin");
  });

  it("includes /usr/local/bin in PATH on non-Windows", () => {
    vi.stubEnv("PATH", "/usr/bin:/bin");
    const result = getEncoderEnv();
    expect(result.PATH).toContain("/usr/local/bin");
  });

  it("preserves the original PATH at the end", () => {
    vi.stubEnv("PATH", "/custom/user/bin");
    const result = getEncoderEnv();
    expect(result.PATH).toMatch(/\/custom\/user\/bin$/);
  });

  it("includes $HOME/.local/bin when HOME is set", () => {
    vi.stubEnv("PATH", "");
    vi.stubEnv("HOME", "/Users/alice");
    const result = getEncoderEnv();
    expect(result.PATH).toContain("/Users/alice/.local/bin");
  });

  it("spreads all other env vars through", () => {
    vi.stubEnv("MY_CUSTOM_VAR", "hello");
    const result = getEncoderEnv();
    expect(result.MY_CUSTOM_VAR).toBe("hello");
  });
});
