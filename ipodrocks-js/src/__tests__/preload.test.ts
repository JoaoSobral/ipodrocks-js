/**
 * @vitest-environment node
 *
 * Tests for the preload channel whitelist logic.
 * The isAllowedChannel function is not exported from preload.ts
 * (it lives behind contextBridge), so we replicate its logic here
 * to verify the whitelist rules independently.
 */
import { describe, it, expect } from "vitest";

const ALLOWED_CHANNEL_PREFIXES = [
  "dialog:",
  "library:",
  "activity:",
  "scan:",
  "app:",
  "shadow:",
  "device:",
  "genius:",
  "sync:",
  "playlist:",
  "savant:",
  "assistant:",
  "settings:",
  "harmonic:",
];

function isAllowedChannel(channel: string): boolean {
  return ALLOWED_CHANNEL_PREFIXES.some((p) => channel.startsWith(p));
}

describe("preload channel whitelist", () => {
  describe("allowed channels", () => {
    const validChannels = [
      "dialog:openFile",
      "library:addFolder",
      "library:scan",
      "library:removeFolder",
      "activity:recent",
      "scan:start",
      "app:version",
      "shadow:build",
      "device:check",
      "device:list",
      "genius:analyze",
      "sync:start",
      "sync:cancel",
      "sync:progress",
      "playlist:list",
      "playlist:create",
      "playlist:delete",
      "savant:generate",
      "assistant:chat",
      "settings:get",
      "settings:set",
      "harmonic:backfill",
    ];

    for (const channel of validChannels) {
      it(`allows "${channel}"`, () => {
        expect(isAllowedChannel(channel)).toBe(true);
      });
    }
  });

  describe("blocked channels", () => {
    const blockedChannels = [
      "shell:exec",
      "fs:readFile",
      "electron:quit",
      "node:spawn",
      "",
      "LIBRARY:addFolder",
      "random",
      "lib:scan",
    ];

    for (const channel of blockedChannels) {
      it(`blocks "${channel}"`, () => {
        expect(isAllowedChannel(channel)).toBe(false);
      });
    }
  });

  it("is case-sensitive (rejects uppercase prefix)", () => {
    expect(isAllowedChannel("Sync:start")).toBe(false);
    expect(isAllowedChannel("DEVICE:check")).toBe(false);
  });

  it("requires the colon separator", () => {
    expect(isAllowedChannel("syncstart")).toBe(false);
    expect(isAllowedChannel("device")).toBe(false);
  });

  it("allows channels with nested colons", () => {
    expect(isAllowedChannel("settings:openrouter:test")).toBe(true);
  });
});
