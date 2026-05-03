/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";

let canRunDbTests = false;
try {
  const Database = require("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
  canRunDbTests = true;
} catch {
  /* better-sqlite3 may be compiled for Electron's Node; skip DB tests */
}

function makeDb() {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  return db;
}

vi.mock("../main/llm/openRouterClient", () => ({
  callOpenRouter: vi.fn().mockResolvedValue("Mocked reply"),
}));

const TEST_PATHS = {
  userData: "/Users/test/Library/Application Support/iPodRocks",
  podcastsRoot: "/Users/test/Library/Application Support/iPodRocks/auto-podcasts",
  autoPodcastEnabled: false,
  autoPodcastIntervalMin: 60,
};

describe("assistantChat — app path context", () => {
  if (!canRunDbTests) {
    it.skip("better-sqlite3 unavailable — skipping DB tests", () => {});
    return;
  }

  it("includes userData and podcastsRoot in the system prompt", async () => {
    const db = makeDb();
    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "where are my autopodcasts?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const calls = vi.mocked(callOpenRouter).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const systemMessages = calls[0][0]
      .filter((m: { role: string; content: string }) => m.role === "system")
      .map((m: { role: string; content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain(TEST_PATHS.userData);
    expect(systemMessages).toContain(TEST_PATHS.podcastsRoot);
    expect(systemMessages).toContain("ipodrock.db");
    expect(systemMessages).toContain("ipodrocks-prefs.json");
    db.close();
  });

  it("includes configured library folders by path", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
    ).run("My Music", "/home/user/Music", "music");
    db.prepare(
      "INSERT INTO library_folders (name, path, content_type) VALUES (?, ?, ?)"
    ).run("My Audiobooks", "/home/user/Audiobooks", "audiobook");

    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");
    vi.mocked(callOpenRouter).mockClear();

    await sendAssistantMessage(
      [{ role: "user", content: "what is my library path?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const calls = vi.mocked(callOpenRouter).mock.calls;
    const systemMessages = calls[0][0]
      .filter((m: { role: string; content: string }) => m.role === "system")
      .map((m: { role: string; content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("/home/user/Music");
    expect(systemMessages).toContain("/home/user/Audiobooks");
    expect(systemMessages).toContain("My Music");
    expect(systemMessages).toContain("My Audiobooks");
    db.close();
  });

  it("reports no library folders when none are configured", async () => {
    const db = makeDb();

    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");
    vi.mocked(callOpenRouter).mockClear();

    await sendAssistantMessage(
      [{ role: "user", content: "where is my library?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const calls = vi.mocked(callOpenRouter).mock.calls;
    const systemMessages = calls[0][0]
      .filter((m: { role: string; content: string }) => m.role === "system")
      .map((m: { role: string; content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("No library folders configured yet");
    db.close();
  });
});

describe("assistantChat — devices context", () => {
  if (!canRunDbTests) {
    it.skip("better-sqlite3 unavailable — skipping DB tests", () => {});
    return;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.mock("../main/llm/openRouterClient", () => ({
      callOpenRouter: vi.fn().mockResolvedValue("Mocked reply"),
    }));
  });

  it("reports no devices when none are configured", async () => {
    const db = makeDb();
    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "how many devices do I have?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("No devices configured");
    db.close();
  });

  it("includes device name, model, codec, and sync info", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO codecs (name, description) VALUES ('MP3', 'MPEG Layer 3')"
    ).run();
    db.prepare(
      `INSERT INTO codec_configurations (codec_id, name, bitrate_value)
       VALUES (1, 'MP3 320', 320)`
    ).run();
    db.prepare(
      `INSERT INTO device_transfer_modes (name, description)
       VALUES ('copy', 'Copy files')`
    ).run();
    db.prepare(
      `INSERT INTO devices (name, mount_path, default_transfer_mode_id, default_codec_config_id,
                            last_sync_date, total_synced_items, last_sync_count)
       VALUES ('My iPod', '/Volumes/iPod', 1, 1, '2025-01-15 10:00:00', 250, 5)`
    ).run();

    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "tell me about my device" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("My iPod");
    expect(systemMessages).toContain("/Volumes/iPod");
    expect(systemMessages).toContain("MP3");
    expect(systemMessages).toContain("320kbps");
    expect(systemMessages).toContain("2025-01-15");
    expect(systemMessages).toContain("250");
    db.close();
  });
});

describe("assistantChat — shadow libraries context", () => {
  if (!canRunDbTests) {
    it.skip("better-sqlite3 unavailable — skipping DB tests", () => {});
    return;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.mock("../main/llm/openRouterClient", () => ({
      callOpenRouter: vi.fn().mockResolvedValue("Mocked reply"),
    }));
  });

  it("reports no shadow libraries when none exist", async () => {
    const db = makeDb();
    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "do I have any shadow libraries?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("No shadow libraries configured");
    db.close();
  });

  it("includes shadow library name, codec, status, and track counts", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO codecs (name, description) VALUES ('AAC', 'Advanced Audio Coding')").run();
    db.prepare(
      "INSERT INTO codec_configurations (codec_id, name, bitrate_value) VALUES (1, 'AAC 256', 256)"
    ).run();
    db.prepare(
      `INSERT INTO shadow_libraries (name, path, codec_config_id, status)
       VALUES ('iPod Shadow', '/Volumes/Shadow', 1, 'ready')`
    ).run();

    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "show me my shadow libraries" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("iPod Shadow");
    expect(systemMessages).toContain("AAC");
    expect(systemMessages).toContain("256kbps");
    expect(systemMessages).toContain("ready");
    db.close();
  });
});

describe("assistantChat — auto podcasts context", () => {
  if (!canRunDbTests) {
    it.skip("better-sqlite3 unavailable — skipping DB tests", () => {});
    return;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.mock("../main/llm/openRouterClient", () => ({
      callOpenRouter: vi.fn().mockResolvedValue("Mocked reply"),
    }));
  });

  it("includes auto-download enabled status and interval", async () => {
    const db = makeDb();
    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");
    const paths = { ...TEST_PATHS, autoPodcastEnabled: true, autoPodcastIntervalMin: 30 };

    await sendAssistantMessage(
      [{ role: "user", content: "are autopodcasts enabled?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      paths
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("enabled");
    expect(systemMessages).toContain("30 min");
    db.close();
  });

  it("includes podcast subscription title and episode counts", async () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO podcast_subscriptions (feed_id, title, author, feed_url, auto_count)
       VALUES (1, 'Darknet Diaries', 'Jack Rhysider', 'https://feed.example.com', 3)`
    ).run();
    db.prepare(
      `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state)
       VALUES (1, 'ep1', 'Episode 1', 'https://ep.example.com/1', 'ready')`
    ).run();
    db.prepare(
      `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, download_state)
       VALUES (1, 'ep2', 'Episode 2', 'https://ep.example.com/2', 'pending')`
    ).run();

    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "what podcasts am I subscribed to?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("Darknet Diaries");
    expect(systemMessages).toContain("Jack Rhysider");
    expect(systemMessages).toContain("auto latest 3");
    db.close();
  });
});

describe("assistantChat — activity/dashboard context", () => {
  if (!canRunDbTests) {
    it.skip("better-sqlite3 unavailable — skipping DB tests", () => {});
    return;
  }

  beforeEach(() => {
    vi.resetModules();
    vi.mock("../main/llm/openRouterClient", () => ({
      callOpenRouter: vi.fn().mockResolvedValue("Mocked reply"),
    }));
  });

  it("includes recent activity entries in the system prompt", async () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO activity_log (operation, detail) VALUES (?, ?)"
    ).run("library_scan", "Scanned 500 files, 10 added");
    db.prepare(
      "INSERT INTO activity_log (operation, detail) VALUES (?, ?)"
    ).run("add_device", "Added device: My iPod");

    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "what happened recently?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("library_scan");
    expect(systemMessages).toContain("Scanned 500 files");
    expect(systemMessages).toContain("add_device");
    db.close();
  });

  it("reports no recent activity when log is empty", async () => {
    const db = makeDb();
    const { sendAssistantMessage } = await import("../main/assistant/assistantChat");
    const { callOpenRouter } = await import("../main/llm/openRouterClient");

    await sendAssistantMessage(
      [{ role: "user", content: "any recent activity?" }],
      db,
      { apiKey: "test-key", model: "test-model" },
      TEST_PATHS
    );

    const systemMessages = vi.mocked(callOpenRouter).mock.calls[0][0]
      .filter((m: { role: string }) => m.role === "system")
      .map((m: { content: string }) => m.content)
      .join("\n");

    expect(systemMessages).toContain("No recent activity");
    db.close();
  });
});
