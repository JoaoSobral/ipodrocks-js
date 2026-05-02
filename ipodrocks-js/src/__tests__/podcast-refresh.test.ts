/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SCHEMA_SQL } from "../main/database/schema";

let canRunDbTests = false;
try {
  const probe = require("better-sqlite3");
  const d = new probe(":memory:");
  d.close();
  canRunDbTests = true;
} catch { /* better-sqlite3 compiled for Electron; skip */ }
import {
  subscribe,
  listEpisodes,
  getSubscriptionById,
  listSubscriptions,
} from "../main/podcasts/podcast-subscriptions";
import { refreshSubscription } from "../main/podcasts/podcast-refresh";
import type { PodcastSearchResult } from "../shared/types";

vi.mock("../main/podcasts/podcast-index-client", () => ({
  getEpisodes: vi.fn(),
}));

vi.mock("../main/podcasts/podcast-downloader", () => ({
  downloadEpisode: vi.fn().mockResolvedValue({ localPath: "/fake/ep.mp3" }),
}));

vi.mock("../main/podcasts/podcast-storage", () => ({
  getPodcastsRoot: vi.fn().mockReturnValue("/fake"),
  getEpisodePath: vi.fn().mockImplementation((feedId: number, epId: number) => `/fake/${epId}.mp3`),
  ensureEpisodeDir: vi.fn(),
}));

import { getEpisodes } from "../main/podcasts/podcast-index-client";
import { downloadEpisode } from "../main/podcasts/podcast-downloader";

let db: import("better-sqlite3").Database;

const testFeed: PodcastSearchResult = {
  feedId: 42,
  title: "Test Podcast",
  author: "Test Author",
  description: "A test podcast",
  imageUrl: "",
  feedUrl: "https://example.com/feed.xml",
  episodeCount: 10,
};

function makeMockEpisode(n: number) {
  return {
    guid: `guid-${n}`,
    title: `Episode ${n}`,
    description: `Desc ${n}`,
    enclosureUrl: `https://example.com/ep${n}.mp3`,
    enclosureLength: 5000000,
    duration: 3600,
    datePublished: 1700000000 + n * 86400,
    feedId: 42,
  };
}

beforeEach(() => {
  if (canRunDbTests) {
    const Database = require("better-sqlite3");
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);
  }
  vi.clearAllMocks();
});

afterEach(() => {
  if (db) db.close();
});

describe("refreshSubscription", () => {
  it.skipIf(!canRunDbTests)("upserts episodes but downloads only N when auto_count = 3", async () => {
    const sub = subscribe(db, testFeed);
    db.prepare("UPDATE podcast_subscriptions SET auto_count = 3 WHERE id = ?").run(sub.id);

    const mockEps = [5, 4, 3, 2, 1].map(makeMockEpisode);
    vi.mocked(getEpisodes).mockResolvedValue(mockEps);

    vi.mocked(downloadEpisode).mockImplementation(async (database, epId) => {
      database.prepare(
        "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE id = ?"
      ).run(`/fake/${epId}.mp3`, epId);
      return { localPath: `/fake/${epId}.mp3` };
    });

    await refreshSubscription(db, sub.id, "key", "secret");

    const episodes = listEpisodes(db, sub.id);
    expect(episodes).toHaveLength(5);
    expect(downloadEpisode).toHaveBeenCalledTimes(3);

    const updated = getSubscriptionById(db, sub.id);
    expect(updated?.lastRefreshedAt).not.toBeNull();
  });

  it.skipIf(!canRunDbTests)("is idempotent — running twice does not re-download ready episodes", async () => {
    const sub = subscribe(db, testFeed);
    db.prepare("UPDATE podcast_subscriptions SET auto_count = 2 WHERE id = ?").run(sub.id);

    const mockEps = [2, 1].map(makeMockEpisode);
    vi.mocked(getEpisodes).mockResolvedValue(mockEps);

    vi.mocked(downloadEpisode).mockImplementation(async (database, epId) => {
      database.prepare(
        "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE id = ?"
      ).run(`/fake/${epId}.mp3`, epId);
      return { localPath: `/fake/${epId}.mp3` };
    });

    await refreshSubscription(db, sub.id, "key", "secret");
    expect(downloadEpisode).toHaveBeenCalledTimes(2);

    vi.mocked(getEpisodes).mockResolvedValue(mockEps);
    await refreshSubscription(db, sub.id, "key", "secret");
    expect(downloadEpisode).toHaveBeenCalledTimes(2);
  });

  it.skipIf(!canRunDbTests)("downloads manual_selected episodes when auto_count = 0", async () => {
    const sub = subscribe(db, testFeed);
    db.prepare("UPDATE podcast_subscriptions SET auto_count = 0 WHERE id = ?").run(sub.id);

    const mockEps = [3, 2, 1].map(makeMockEpisode);
    vi.mocked(getEpisodes).mockResolvedValue(mockEps);
    vi.mocked(downloadEpisode).mockResolvedValue({ localPath: "/fake/ep.mp3" });

    await refreshSubscription(db, sub.id, "key", "secret");
    expect(downloadEpisode).toHaveBeenCalledTimes(0);

    const eps = listEpisodes(db, sub.id);
    db.prepare("UPDATE podcast_episodes SET manual_selected = 1 WHERE id = ?").run(eps[2].id);

    vi.mocked(getEpisodes).mockResolvedValue(mockEps);
    await refreshSubscription(db, sub.id, "key", "secret");
    expect(downloadEpisode).toHaveBeenCalledTimes(1);
  });

  it.skipIf(!canRunDbTests)("prunes oldest episodes when ready count exceeds 10", async () => {
    const sub = subscribe(db, testFeed);
    db.prepare("UPDATE podcast_subscriptions SET auto_count = 1 WHERE id = ?").run(sub.id);

    // Simulate 11 ready episodes already in DB (oldest first, ep 1..11)
    for (let n = 1; n <= 11; n++) {
      db.prepare(
        `INSERT INTO podcast_episodes (subscription_id, guid, title, enclosure_url, published_at, download_state, local_path)
         VALUES (?, ?, ?, ?, datetime(?, 'unixepoch'), 'ready', ?)`
      ).run(sub.id, `pre-guid-${n}`, `Pre ${n}`, `https://example.com/pre${n}.mp3`, 1700000000 + n * 86400, `/fake/pre${n}.mp3`);
    }

    // New episode to trigger refresh
    vi.mocked(getEpisodes).mockResolvedValue([makeMockEpisode(12)]);
    vi.mocked(downloadEpisode).mockImplementation(async (database, epId) => {
      database.prepare(
        "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE id = ?"
      ).run(`/fake/${epId}.mp3`, epId);
      return { localPath: `/fake/${epId}.mp3` };
    });

    await refreshSubscription(db, sub.id, "key", "secret");

    const episodes = listEpisodes(db, sub.id);
    const readyCount = episodes.filter((e) => e.downloadState === "ready").length;
    expect(readyCount).toBeLessThanOrEqual(10);

    const skippedCount = episodes.filter((e) => e.downloadState === "skipped").length;
    expect(skippedCount).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!canRunDbTests)("isUpToDate is true when all target episodes are ready", async () => {
    const sub = subscribe(db, testFeed);
    db.prepare("UPDATE podcast_subscriptions SET auto_count = 2 WHERE id = ?").run(sub.id);

    const mockEps = [2, 1].map(makeMockEpisode);
    vi.mocked(getEpisodes).mockResolvedValue(mockEps);

    vi.mocked(downloadEpisode).mockImplementation(async (database, epId) => {
      database.prepare(
        "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE id = ?"
      ).run(`/fake/${epId}.mp3`, epId);
      return { localPath: `/fake/${epId}.mp3` };
    });

    let subs = listSubscriptions(db);
    expect(subs[0].isUpToDate).toBe(false);

    await refreshSubscription(db, sub.id, "key", "secret");

    subs = listSubscriptions(db);
    expect(subs[0].isUpToDate).toBe(true);
  });
});
