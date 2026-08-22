/**
 * @vitest-environment node
 *
 * Issue #113: a compilation whose tracks carry different `artist` tags but share
 * one `albumartist` must behave as ONE album.
 *
 * Before the fix the library never read `albumartist` and keyed `albums` on the
 * track artist, so a 3-artist compilation produced 3 album rows: the custom-sync
 * album picker listed it 3 times, and syncing without folder mirroring scattered
 * it across 3 artist folders on the device.
 *
 * Drives the real library:scan and sync:start IPC handlers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  installElectronMock,
  setupIpcSession,
  type IpcSession,
} from "../harness/ipc-harness";
import {
  installMusicMetadataMock,
  resetMusicMetadataMock,
  registerFixture,
} from "../harness/music-metadata-mock";
import { canRunDbTests, createFakeDevice, type FakeDevice } from "../harness";
import { albumLabelForTrack } from "../../shared/album-label";
import type { Track } from "../../shared/types";

installElectronMock();
installMusicMetadataMock();

vi.mock("../../main/sync/sync-executor", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    copyFileToDevice: vi.fn(async (src: string, dest: string) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      return true;
    }),
  };
});

vi.mock("../../main/devices/device-online", () => ({
  isDeviceMountPathOnline: vi.fn().mockReturnValue(true),
}));

const itDb = it.skipIf(!canRunDbTests);

const ALBUM = "Now Thats What I Call Music 40";
const ALBUM_ARTIST = "Various Artists";
const TRACK_ARTISTS = ["Alpha Band", "Beta Crew", "Gamma Trio"];

/** Seed a flat compilation folder: one album, three different track artists. */
function seedCompilation(dir: string): string[] {
  const paths: string[] = [];
  TRACK_ARTISTS.forEach((artist, i) => {
    const rel = `${ALBUM}/0${i + 1} - ${artist}.flac`;
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(`FLAC\x00compilation-track-${i}`));
    registerFixture(full, {
      title: `Track ${i + 1}`,
      artist,
      albumArtist: ALBUM_ARTIST,
      album: ALBUM,
      genre: "Pop",
      trackNumber: i + 1,
      duration: 200,
      bitrate: 1000,
      codec: "FLAC",
    });
    paths.push(full);
  });
  return paths;
}

describe("Album-artist grouping (issue #113)", () => {
  let session: IpcSession;
  let userDataDir: string;
  let libraryDir: string;
  let device: FakeDevice;

  beforeEach(async () => {
    resetMusicMetadataMock();
    vi.clearAllMocks();
    if (!canRunDbTests) return;

    const root = fs.mkdtempSync(path.join(os.homedir(), ".ipodrocks-aa-"));
    userDataDir = path.join(root, "userdata");
    libraryDir = path.join(root, "library");
    fs.mkdirSync(path.join(userDataDir, "userData"), { recursive: true });
    fs.mkdirSync(libraryDir, { recursive: true });
    device = createFakeDevice(root);
    session = await setupIpcSession({ userDataDir });
  });

  afterEach(() => {
    session?.cleanup();
    try {
      fs.rmSync(path.dirname(userDataDir), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  async function scanAndAddDevice(): Promise<number> {
    await session.invoke("library:addFolder", {
      name: "Music",
      path: libraryDir,
      contentType: "music",
    });
    await session.invoke("library:scan", {
      folders: [{ name: "Music", path: libraryDir, contentType: "music" }],
    });
    const dev = await session.invoke<{ id: number }>("device:add", {
      name: "CompilationDevice",
      mountPath: device.mountPath,
    });
    return dev.id;
  }

  itDb("exposes the album artist on every track of a compilation", async () => {
    seedCompilation(libraryDir);
    await scanAndAddDevice();

    const tracks = await session.invoke<Track[]>("library:getTracks", {
      contentType: "music",
    });
    expect(tracks).toHaveLength(3);
    // Track artists stay distinct...
    expect(new Set(tracks.map((t) => t.artist)).size).toBe(3);
    // ...while the album artist is shared.
    expect(new Set(tracks.map((t) => t.albumArtist))).toEqual(
      new Set([ALBUM_ARTIST])
    );
  });

  itDb("lists the compilation once in the album picker, not once per artist", async () => {
    seedCompilation(libraryDir);
    await scanAndAddDevice();

    const tracks = await session.invoke<Track[]>("library:getTracks", {
      contentType: "music",
    });

    const byAlbumArtist = new Set(
      tracks.map((t) => albumLabelForTrack(t, "album-artist"))
    );
    expect([...byAlbumArtist]).toEqual([`${ALBUM} — ${ALBUM_ARTIST}`]);

    // The opt-out reproduces the old behaviour: one entry per track artist.
    const byTrackArtist = new Set(
      tracks.map((t) => albumLabelForTrack(t, "track-artist"))
    );
    expect(byTrackArtist.size).toBe(3);
  });

  itDb("collapses the compilation into a single albums row", async () => {
    seedCompilation(libraryDir);
    await scanAndAddDevice();

    const albums = await session.invoke<{ title: string }[]>("playlist:getAlbums");
    const matching = albums.filter((a) => a.title === ALBUM);
    expect(matching).toHaveLength(1);
  });

  itDb("puts the whole compilation in one device folder when mirroring is off", async () => {
    seedCompilation(libraryDir);
    const deviceId = await scanAndAddDevice();

    const result = await session.invoke<{ synced: number; errors: number }>(
      "sync:start",
      {
        deviceId,
        syncType: "full",
        extraTrackPolicy: "keep",
        preserveFolderStructure: false,
        albumGrouping: "album-artist",
        includeMusic: true,
        includePodcasts: false,
        includeAudiobooks: false,
        includePlaylists: false,
      }
    );
    expect(result.errors).toBe(0);
    expect(result.synced).toBe(3);

    const albumDir = path.join(device.musicDir, ALBUM_ARTIST, ALBUM);
    expect(fs.existsSync(albumDir)).toBe(true);
    expect(fs.readdirSync(albumDir).sort()).toHaveLength(3);

    // None of the track artists became a top-level folder.
    for (const artist of TRACK_ARTISTS) {
      expect(fs.existsSync(path.join(device.musicDir, artist))).toBe(false);
    }
  });

  itDb("scatters per track artist when grouping is set to track-artist", async () => {
    seedCompilation(libraryDir);
    const deviceId = await scanAndAddDevice();

    await session.invoke("sync:start", {
      deviceId,
      syncType: "full",
      extraTrackPolicy: "keep",
      preserveFolderStructure: false,
      albumGrouping: "track-artist",
      includeMusic: true,
      includePodcasts: false,
      includeAudiobooks: false,
      includePlaylists: false,
    });

    for (const artist of TRACK_ARTISTS) {
      expect(fs.existsSync(path.join(device.musicDir, artist, ALBUM))).toBe(true);
    }
    expect(fs.existsSync(path.join(device.musicDir, ALBUM_ARTIST))).toBe(false);
  });

  itDb("custom sync selects the whole compilation from one album label", async () => {
    seedCompilation(libraryDir);
    const deviceId = await scanAndAddDevice();

    const result = await session.invoke<{ synced: number; errors: number }>(
      "sync:start",
      {
        deviceId,
        syncType: "custom",
        extraTrackPolicy: "keep",
        preserveFolderStructure: false,
        albumGrouping: "album-artist",
        selections: {
          mode: "include",
          albums: [`${ALBUM} — ${ALBUM_ARTIST}`],
          artists: [],
          genres: [],
          podcasts: [],
          audiobooks: [],
          playlists: [],
        },
      }
    );
    expect(result.errors).toBe(0);
    // One label now pulls in all three tracks.
    expect(result.synced).toBe(3);
  });

  itDb("still honours a legacy track-artist selection label saved before the fix", async () => {
    seedCompilation(libraryDir);
    const deviceId = await scanAndAddDevice();

    const result = await session.invoke<{ synced: number; errors: number }>(
      "sync:start",
      {
        deviceId,
        syncType: "custom",
        extraTrackPolicy: "keep",
        preserveFolderStructure: false,
        albumGrouping: "album-artist",
        selections: {
          mode: "include",
          // The label an upgraded user has stored from the old build.
          albums: [`${ALBUM} — ${TRACK_ARTISTS[0]}`],
          artists: [],
          genres: [],
          podcasts: [],
          audiobooks: [],
          playlists: [],
        },
      }
    );
    expect(result.errors).toBe(0);
    // The one track that legacy label referred to still syncs — the selection
    // is not silently dropped on upgrade.
    expect(result.synced).toBe(1);
  });
});
