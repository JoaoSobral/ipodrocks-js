/**
 * @vitest-environment node
 *
 * Writing the Rockbox database onto a device (`rockbox/tagcache-sync.ts`).
 *
 * The encoder's byte layout is pinned in tagcache-encoder.test.ts; this file
 * pins what goes *into* it and what happens to the database already there:
 * runtime statistics survive, the device's volume prefix is kept, Rockbox's
 * own scan rules decide which files appear, and a device that is not running
 * Rockbox 4.x is left untouched.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { localFs } from "../../main/devices/fs";
import {
  buildDeviceTagcache,
  buildLibraryDeviceIndex,
  firmwareWritesV10,
  rockboxMtime,
  detectFatClock,
  type LibraryDeviceIndex,
} from "../../main/rockbox/tagcache-sync";
import {
  INDEX_FILE_NAME,
  STRING_TAGS,
  decodeTagcache,
  tagFileName,
} from "../../main/rockbox/tagcache-build";
import { FLAG } from "../../main/rockbox/tcd-format";
import { writeTcdFixture } from "../harness/tcd-fixture";

function touch(root: string, rel: string, bytes = 4000): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 1));
}

function readDatabase(root: string) {
  const rb = path.join(root, ".rockbox");
  const tagFiles = new Map<number, Buffer>();
  for (const tag of STRING_TAGS) {
    const p = path.join(rb, tagFileName(tag));
    if (fs.existsSync(p)) tagFiles.set(tag, fs.readFileSync(p));
  }
  return decodeTagcache(fs.readFileSync(path.join(rb, INDEX_FILE_NAME)), tagFiles);
}

const EMPTY_LIBRARY: LibraryDeviceIndex = { exact: new Map(), stem: new Map() };

/** One library FLAC that the sync transcoded to `Music/Artist/Album/new.mp3`. */
function libraryWithNewTrack(rating: number | null): LibraryDeviceIndex {
  const trackPath = "/library/Artist/Album/new.flac";
  return buildLibraryDeviceIndex([
    {
      contentFolderRel: "Music",
      destMap: { [trackPath]: "Artist/Album/new.mp3" },
      tracks: {
        [trackPath]: {
          id: 7,
          title: "New Song",
          artist: "Artist",
          albumArtist: "Artist",
          album: "Album",
          genre: "Unknown Genre",
          year: 2001,
          composer: "Composer",
          trackNumber: 3,
          discNumber: 1,
          duration: 2,
          rating,
        },
      },
    },
  ]);
}

describe("buildDeviceTagcache", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ipr-tcd-build-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("leaves a device with no .rockbox folder untouched", async () => {
    touch(root, "Music/a.mp3");
    const result = await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: EMPTY_LIBRARY }
    );
    expect(result).toMatchObject({ state: "skipped", reason: "not-rockbox" });
    expect(fs.existsSync(path.join(root, ".rockbox"))).toBe(false);
  });

  it("carries runtime data, keeps the volume prefix and adds new tracks with their rating", async () => {
    writeTcdFixture(root, [
      {
        path: "/<HDD0>/Music/Artist/Album/old.mp3",
        playCount: 4,
        rating: 6,
        playTimeMs: 90_000,
        lastPlayedSerial: 9,
        lengthMs: 3000,
      },
    ]);
    fs.writeFileSync(path.join(root, ".rockbox/database_tmp.tcd"), "stale scan");
    touch(root, "Music/Artist/Album/old.mp3");
    touch(root, "Music/Artist/Album/new.mp3", 16_000);
    touch(root, "Music/._new.mp3"); // AppleDouble: never indexed
    touch(root, "Music/notes.txt"); // not audio
    touch(root, "Ignored/database.ignore", 0);
    touch(root, "Ignored/x.mp3");
    touch(root, "Ignored/Back/database.unignore", 0);
    touch(root, "Ignored/Back/y.ogg");
    touch(root, ".ipodrocks-trash-123/Music/z.mp3"); // a delete-all still being removed

    const result = await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: libraryWithNewTrack(8) }
    );

    expect(result.state).toBe("built");
    if (result.state !== "built") return;
    expect(result.seededTrackIds).toEqual([7]);
    expect(result.carried).toBe(1);
    expect(result.fromLibrary).toBe(1);

    const db = readDatabase(root);
    const byName = new Map(db.entries.map((e) => [e.filename, e]));
    expect([...byName.keys()].sort()).toEqual([
      "/<HDD0>/Ignored/Back/y.ogg",
      "/<HDD0>/Music/Artist/Album/new.mp3",
      "/<HDD0>/Music/Artist/Album/old.mp3",
    ]);

    const old = byName.get("/<HDD0>/Music/Artist/Album/old.mp3")!;
    expect(old.runtime).toMatchObject({ playcount: 4, rating: 6, playtime: 90_000, lastplayed: 9 });
    expect(old.flag & FLAG.DIRTYNUM).toBe(FLAG.DIRTYNUM);

    const fresh = byName.get("/<HDD0>/Music/Artist/Album/new.mp3")!;
    expect(fresh).toMatchObject({
      title: "New Song",
      artist: "Artist",
      album: "Album",
      genre: "<Untagged>", // the library's placeholder is not a genre
      composer: "Composer",
      year: 2001,
      tracknumber: 3,
      discnumber: 1,
      length: 2000,
      bitrate: 64, // 16000 bytes over 2 s, not the source FLAC's figure
    });
    expect(fresh.runtime.rating).toBe(8);

    // The next play must not tie with an old one.
    expect(db.header.serial).toBeGreaterThan(9);
    expect(db.header.dirty).toBe(0);

    const rb = path.join(root, ".rockbox");
    expect(fs.existsSync(path.join(rb, "database_tmp.tcd"))).toBe(false);
    expect(fs.existsSync(path.join(rb, INDEX_FILE_NAME + ".ipodrocks-bak"))).toBe(true);
    expect(fs.readdirSync(rb).filter((n) => n.endsWith(".ipodrocks-new"))).toEqual([]);
  });

  it("does not seed a rating over one the device already holds", async () => {
    writeTcdFixture(root, [{ path: "/Music/Artist/Album/new.mp3", rating: 2, playCount: 1 }]);
    touch(root, "Music/Artist/Album/new.mp3");
    const result = await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: libraryWithNewTrack(8) }
    );
    expect(result).toMatchObject({ state: "built", seededTrackIds: [] });
    const [entry] = readDatabase(root).entries;
    expect(entry.filename).toBe("/Music/Artist/Album/new.mp3");
    expect(entry.runtime.rating).toBe(2);
  });

  it("matches a library track whose device copy changed codec", async () => {
    fs.mkdirSync(path.join(root, ".rockbox"));
    fs.writeFileSync(path.join(root, ".rockbox/rockbox-info.txt"), "Target: ipodvideo\nVersion: 4.0\n");
    touch(root, "Music/Artist/Album/new.ogg");
    await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: libraryWithNewTrack(null) }
    );
    const [entry] = readDatabase(root).entries;
    expect(entry.filename).toBe("/Music/Artist/Album/new.ogg");
    expect(entry.title).toBe("New Song");
  });

  it("refuses a database written by Rockbox older than 4.0", async () => {
    const rb = path.join(root, ".rockbox");
    fs.mkdirSync(rb);
    const idx = Buffer.alloc(24);
    idx.writeInt32LE(0x5443480f, 0);
    fs.writeFileSync(path.join(rb, INDEX_FILE_NAME), idx);
    touch(root, "Music/a.mp3");

    const result = await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: EMPTY_LIBRARY }
    );
    expect(result).toMatchObject({ state: "skipped", reason: "unsupported-version" });
    expect(fs.readFileSync(path.join(rb, INDEX_FILE_NAME))).toEqual(idx);
  });

  it("with no database yet, builds only when rockbox-info.txt names 4.x", async () => {
    const rb = path.join(root, ".rockbox");
    fs.mkdirSync(rb);
    touch(root, "Music/a.mp3");

    fs.writeFileSync(path.join(rb, "rockbox-info.txt"), "Version: 3.15\n");
    const old = await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: EMPTY_LIBRARY }
    );
    expect(old.state).toBe("skipped");
    expect(fs.existsSync(path.join(rb, INDEX_FILE_NAME))).toBe(false);

    fs.writeFileSync(path.join(rb, "rockbox-info.txt"), "Version: 4.0\n");
    const fresh = await buildDeviceTagcache(
      { fs: localFs(root), mountPath: root },
      { library: EMPTY_LIBRARY }
    );
    // The file is unknown to the library and has no old entry, so it is read
    // off the (local) device; this one has no tags at all.
    expect(fresh).toMatchObject({ state: "built", entries: 1, parsed: 1 });
    expect(readDatabase(root).header.serial).toBe(0);
  });
});

describe("firmware and mtime helpers", () => {
  it("reads the firmware generation from rockbox-info.txt", () => {
    expect(firmwareWritesV10("Version: 4.0\n")).toBe(true);
    expect(firmwareWritesV10("Version: 3.15\n")).toBe(false);
    expect(firmwareWritesV10("Version: a1b2c3d-240101\n")).toBe(true);
    expect(firmwareWritesV10("Target: x\n")).toBeNull();
  });

  it("gives Rockbox's 2-second mtime for each way FAT time is stored", () => {
    const ms = Date.UTC(2024, 0, 15, 12, 0, 3, 500);
    const offset = -new Date(ms).getTimezoneOffset() * 60;
    expect(rockboxMtime(ms, { kind: "local" })).toBe(Math.floor((Math.floor(ms / 1000) + offset) / 2) * 2);
    // Linux with the clock on UTC: the FAT fields are UTC, so Rockbox's
    // reading is the real time. Adding the zone here re-indexed a whole iPod.
    expect(rockboxMtime(ms, { kind: "utc" })).toBe(Date.UTC(2024, 0, 15, 12, 0, 2) / 1000);
    expect(rockboxMtime(ms, { kind: "fixed", offsetSec: 3600 })).toBe(Date.UTC(2024, 0, 15, 13, 0, 2) / 1000);
    expect(rockboxMtime(ms) % 2).toBe(0);
    expect(rockboxMtime(undefined)).toBe(0);
  });

  it("detects how the mount stores FAT time", () => {
    const files = (mounts: string, adjtime = "0.0 0 0\n0\nUTC\n") => (f: string) =>
      f === "/proc/mounts" ? mounts : f === "/etc/adjtime" ? adjtime : null;
    const ipod = "/dev/sdb1 /run/media/me/IPOD vfat rw,uid=1000,shortname=mixed,utf8 0 0\n";
    expect(detectFatClock("/run/media/me/IPOD", "linux", files(ipod))).toEqual({ kind: "utc" });
    expect(detectFatClock("/run/media/me/IPOD", "linux", files(ipod, "0.0 0 0\n0\nLOCAL\n")).kind).toBe("fixed");
    expect(
      detectFatClock("/run/media/me/IPOD", "linux", files(ipod.replace("utf8", "utf8,time_offset=-60")))
    ).toEqual({ kind: "fixed", offsetSec: -3600 });
    expect(
      detectFatClock("/run/media/me/IPOD", "linux", files(ipod.replace("utf8", "utf8,tz=UTC"), "0.0 0 0\n0\nLOCAL\n"))
    ).toEqual({ kind: "utc" });
    // An escaped space in the mount point (`\040`).
    expect(
      detectFatClock(
        "/run/media/me/MY IPOD",
        "linux",
        files("/dev/sdb1 /run/media/me/MY\\040IPOD vfat rw,time_offset=120 0 0\n")
      )
    ).toEqual({ kind: "fixed", offsetSec: 7200 });
    expect(detectFatClock("/Volumes/IPOD", "darwin", files(""))).toEqual({ kind: "local" });
    expect(detectFatClock("C:\\", "win32", files(""))).toEqual({ kind: "local" });
  });
});
