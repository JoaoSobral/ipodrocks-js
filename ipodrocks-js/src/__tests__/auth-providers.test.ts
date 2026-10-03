/**
 * @vitest-environment node
 *
 * The provider list in `shared/auth-providers.ts` is the only one. These pin
 * that the config loader and the passport wiring both follow it, so a provider
 * added there is read from its environment variables and registered without
 * touching either file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OAUTH_PROVIDERS,
  PROVIDER_LABELS,
  isOAuthProvider,
  isProvider,
} from "../shared/auth-providers";
import { loadServerConfig, type ServerConfig } from "../server/config";
import { configurePassport, passport, resetPassport } from "../server/auth/passport-setup";

function envVar(provider: string, half: "ID" | "SECRET"): string {
  return `IPODROCKS_${provider.toUpperCase()}_CLIENT_${half}`;
}

function clearProviderEnv(): void {
  for (const p of OAUTH_PROVIDERS) {
    delete process.env[envVar(p, "ID")];
    delete process.env[envVar(p, "SECRET")];
  }
}

function registered(): string[] {
  const strategies = (passport as unknown as { _strategies: Record<string, unknown> })
    ._strategies;
  return OAUTH_PROVIDERS.filter((p) => p in strategies);
}

beforeEach(() => {
  clearProviderEnv();
  resetPassport();
});

afterEach(() => {
  clearProviderEnv();
  resetPassport();
  vi.restoreAllMocks();
});

describe("shared provider list", () => {
  it("tells providers from anything else", () => {
    for (const p of OAUTH_PROVIDERS) {
      expect(isOAuthProvider(p)).toBe(true);
      expect(isProvider(p)).toBe(true);
      expect(PROVIDER_LABELS[p]).toBeTruthy();
    }
    expect(isOAuthProvider("local")).toBe(false);
    expect(isProvider("local")).toBe(true);
    for (const bad of ["linkedin", "", "Google", null, 1, ["google"]]) {
      expect(isProvider(bad)).toBe(false);
    }
  });
});

describe("config and passport follow the list", () => {
  it("reads IPODROCKS_<PROVIDER>_CLIENT_ID/SECRET for every provider, and only a full pair", () => {
    for (const p of OAUTH_PROVIDERS) {
      process.env[envVar(p, "ID")] = `${p}-id`;
      process.env[envVar(p, "SECRET")] = `${p}-secret`;
    }
    // Half a pair is a misconfiguration, not a provider.
    delete process.env[envVar("facebook", "SECRET")];

    const config = loadServerConfig({});
    expect(Object.keys(config.oauth).sort()).toEqual([...OAUTH_PROVIDERS].sort());
    expect(config.oauth.google).toEqual({ clientId: "google-id", clientSecret: "google-secret" });
    expect(config.oauth.github).toEqual({ clientId: "github-id", clientSecret: "github-secret" });
    expect(config.oauth.facebook).toBeNull();
  });

  it("registers exactly the configured providers when there is a public URL", () => {
    process.env[envVar("google", "ID")] = "id";
    process.env[envVar("google", "SECRET")] = "secret";
    process.env[envVar("github", "ID")] = "id";
    process.env[envVar("github", "SECRET")] = "secret";
    const config: ServerConfig = {
      ...loadServerConfig({}),
      publicUrl: "https://ipod.example.com",
    };
    expect(configurePassport(config)).toEqual(["google", "github"]);
    expect(registered()).toEqual(["google", "github"]);
  });

  it("registers none without a public URL, and says which one it skipped", () => {
    process.env[envVar("github", "ID")] = "id";
    process.env[envVar("github", "SECRET")] = "secret";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config: ServerConfig = { ...loadServerConfig({}), publicUrl: null };
    expect(configurePassport(config)).toEqual([]);
    expect(registered()).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("GitHub"));
  });
});
