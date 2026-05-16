/**
 * @vitest-environment node
 *
 * Behavioral journey for podcasts — user subscribes to a feed, episodes show
 * up in the DB, and syncing copies them onto the device with a cover sidecar.
 *
 * Mocks the network seam (`podcast-index-client`) and the file copy seam
 * (`sync-executor`) — the rest is real DB + real filesystem under tmp.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

import {
  canRunDbTests,
  closeDb,
  createTestDb,
  createTmpDir,
  cleanupTmp,
  createFakeDevice,
  seedDevice,
  installMusicMetadataMock,
  resetMusicMetadataMock,
  registerFixture,
  type TestDb,
  type FakeDevice,
} from "../harness";

import type { PodcastSearchResult } from "../../shared/types";

installMusicMetadataMock();

vi.mock("../../main/sync/sync-executor", () => ({
  copyFileToDevice: vi.fn(),
}));
vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
}));

import { subscribe, upsertEpisode } from "../../main/podcasts/podcast-subscriptions";
import { syncPodcastsToDevice } from "../../main/podcasts/podcast-device-sync";
import { copyFileToDevice } from "../../main/sync/sync-executor";

const itDb = it.skipIf(!canRunDbTests);

const FEED: PodcastSearchResult = {
  feedId: 42,
  title: "Behavior Show",
  author: "Test",
  description: "",
  imageUrl: "",
  feedUrl: "https://example.com/feed.xml",
  episodeCount: 3,
};

describe("Podcasts — subscribe and sync to device", () => {
  let db: TestDb;
  let tmpRoot: string;
  let sourceDir: string;
  let device: FakeDevice;
  let deviceId: number;

  beforeEach(() => {
    resetMusicMetadataMock();
    vi.clearAllMocks();
    if (!canRunDbTests) return;
    db = createTestDb();
    tmpRoot = createTmpDir("podcast-journey-");
    sourceDir = path.join(tmpRoot, "downloads");
    fs.mkdirSync(sourceDir, { recursive: true });
    device = createFakeDevice(tmpRoot);
    deviceId = seedDevice(db, {
      name: "TestPod",
      mountPath: device.mountPath,
      autoPodcastsEnabled: true,
    });
    vi.mocked(copyFileToDevice).mockImplementation(async (src, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return true;
    });
  });

  afterEach(() => {
    closeDb(db);
    cleanupTmp(tmpRoot);
  });

  itDb("subscribes to a feed, episodes appear, then sync copies them to the device", async () => {
    const sub = subscribe(db, FEED);

    const ep1Src = path.join(sourceDir, "ep1.mp3");
    const ep2Src = path.join(sourceDir, "ep2.mp3");
    fs.writeFileSync(ep1Src, Buffer.alloc(100));
    fs.writeFileSync(ep2Src, Buffer.alloc(100));

    upsertEpisode(db, sub.id, {
      guid: "g1",
      title: "Episode One",
      description: "",
      enclosureUrl: "https://example.com/1.mp3",
      durationSeconds: 600,
      publishedAt: Date.parse("2026-05-01") / 1000,
      fileSize: 100,
    });
    upsertEpisode(db, sub.id, {
      guid: "g2",
      title: "Episode Two",
      description: "",
      enclosureUrl: "https://example.com/2.mp3",
      durationSeconds: 700,
      publishedAt: Date.parse("2026-05-08") / 1000,
      fileSize: 100,
    });
    db.prepare(
      "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE guid = ?"
    ).run(ep1Src, "g1");
    db.prepare(
      "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE guid = ?"
    ).run(ep2Src, "g2");

    const result = await syncPodcastsToDevice(db, deviceId);

    expect(result.synced).toBe(2);
    expect(result.errors).toBe(0);

    const syncedRows = db
      .prepare("SELECT episode_id, device_relative_path FROM device_podcast_synced WHERE device_id = ?")
      .all(deviceId) as { episode_id: number; device_relative_path: string }[];
    expect(syncedRows).toHaveLength(2);
    for (const row of syncedRows) {
      const fullPath = path.join(device.mountPath, row.device_relative_path);
      expect(fs.existsSync(fullPath)).toBe(true);
      expect(row.device_relative_path).toContain("Behavior Show");
    }
  });

  itDb("extracts embedded cover art into a cover.jpg sidecar in the show folder", async () => {
    const sub = subscribe(db, FEED);

    const epSrc = path.join(sourceDir, "art.mp3");
    fs.writeFileSync(epSrc, Buffer.alloc(100));

    const artBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    registerFixture(epSrc, { picture: [{ format: "image/jpeg", data: artBytes } as never] });

    upsertEpisode(db, sub.id, {
      guid: "g-art",
      title: "Art Episode",
      description: "",
      enclosureUrl: "https://example.com/art.mp3",
      durationSeconds: 300,
      publishedAt: Date.parse("2026-05-15") / 1000,
      fileSize: 100,
    });
    db.prepare(
      "UPDATE podcast_episodes SET download_state = 'ready', local_path = ? WHERE guid = 'g-art'"
    ).run(epSrc);

    const result = await syncPodcastsToDevice(db, deviceId);
    expect(result.synced).toBe(1);

    const coverPath = path.join(device.podcastsDir, "Behavior Show", "cover.jpg");
    expect(fs.existsSync(coverPath)).toBe(true);
    expect(fs.readFileSync(coverPath)).toEqual(artBytes);
  });
});
