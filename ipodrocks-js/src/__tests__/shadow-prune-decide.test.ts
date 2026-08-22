/**
 * @vitest-environment node
 *
 * Classification rules for the shadow-library orphan prune.
 *
 * This decides what gets deleted from disk, so it is tested exhaustively and in
 * isolation. The rule that matters most is the artwork one: `cover.jpg` has no
 * `shadow_tracks` row of its own, so judging it like an audio file would delete
 * the cover of every album in the library.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import { decidePrune, isAudioFile, type ShadowFileEntry } from "../main/library/shadow-prune";

const ROOT = path.resolve("/shadow");

function entry(rel: string, size = 100): ShadowFileEntry {
  const full = path.join(ROOT, rel);
  return {
    path: full,
    normalizedPath: full,
    normalizedDir: path.dirname(full),
    size,
  };
}

function names(entries: ShadowFileEntry[]): string[] {
  return entries.map((e) => path.relative(ROOT, e.path).split(path.sep).join("/")).sort();
}

describe("isAudioFile", () => {
  it("recognises the shadow codecs", () => {
    for (const ext of [".mpc", ".mp3", ".opus", ".m4a", ".flac", ".ogg"]) {
      expect(isAudioFile(`/x/track${ext}`)).toBe(true);
    }
  });

  it("does not treat artwork as audio", () => {
    expect(isAudioFile("/x/cover.jpg")).toBe(false);
    expect(isAudioFile("/x/folder.png")).toBe(false);
  });
});

describe("decidePrune", () => {
  it("keeps audio the library still claims", () => {
    const live = entry("Artist/Album/01.mpc");
    const { orphans } = decidePrune([live], new Set([live.normalizedPath]));
    expect(orphans).toEqual([]);
  });

  it("removes audio nothing claims", () => {
    const stale = entry("Artist/Old Album/01.mpc");
    const { orphans } = decidePrune([stale], new Set());
    expect(names(orphans)).toEqual(["Artist/Old Album/01.mpc"]);
  });

  it("keeps the cover of an album that still exists", () => {
    const live = entry("Artist/Album/01.mpc");
    const cover = entry("Artist/Album/cover.jpg");
    const { orphans } = decidePrune([live, cover], new Set([live.normalizedPath]));
    expect(orphans).toEqual([]);
  });

  it("removes the cover of an album that is gone", () => {
    const stale = entry("Artist/Old Album/01.mpc");
    const cover = entry("Artist/Old Album/cover.jpg");
    const { orphans } = decidePrune([stale, cover], new Set());
    expect(names(orphans)).toEqual([
      "Artist/Old Album/01.mpc",
      "Artist/Old Album/cover.jpg",
    ]);
  });

  it("keeps a live album's cover while pruning a stale sibling album", () => {
    const live = entry("Artist/Peter/01.mpc");
    const liveCover = entry("Artist/Peter/cover.jpg");
    const stale = entry("Artist/Donald/01.mpc");
    const staleCover = entry("Artist/Donald/cover.jpg");

    const { orphans } = decidePrune(
      [live, liveCover, stale, staleCover],
      new Set([live.normalizedPath])
    );
    expect(names(orphans)).toEqual([
      "Artist/Donald/01.mpc",
      "Artist/Donald/cover.jpg",
    ]);
  });

  it("keeps the cover when only SOME tracks of an album are stale", () => {
    // A partially re-encoded album must not lose its artwork.
    const live = entry("Artist/Album/01.mpc");
    const stale = entry("Artist/Album/02-old.mpc");
    const cover = entry("Artist/Album/cover.jpg");
    const { orphans } = decidePrune(
      [live, stale, cover],
      new Set([live.normalizedPath])
    );
    expect(names(orphans)).toEqual(["Artist/Album/02-old.mpc"]);
  });

  it("removes AppleDouble sidecars of files it would prune anyway", () => {
    const live = entry("Artist/Album/01.mpc");
    const sidecar = entry("Artist/Album/._01.mpc");
    const { orphans } = decidePrune([live, sidecar], new Set([live.normalizedPath]));
    expect(names(orphans)).toEqual(["Artist/Album/._01.mpc"]);
  });

  it("totals the bytes it would free", () => {
    const a = entry("Artist/Gone/01.mpc", 1000);
    const b = entry("Artist/Gone/cover.jpg", 250);
    const { bytes } = decidePrune([a, b], new Set());
    expect(bytes).toBe(1250);
  });

  it("deletes nothing when every file is claimed", () => {
    const a = entry("A/X/01.mpc");
    const b = entry("A/X/02.mpc");
    const cover = entry("A/X/cover.jpg");
    const { orphans, bytes } = decidePrune(
      [a, b, cover],
      new Set([a.normalizedPath, b.normalizedPath])
    );
    expect(orphans).toEqual([]);
    expect(bytes).toBe(0);
  });

  it("handles an empty tree", () => {
    expect(decidePrune([], new Set())).toEqual({ orphans: [], bytes: 0 });
  });
});

/**
 * The prune deletes files, and a shadow library is just a folder the user
 * picked — nothing stops them pointing one at a Documents folder or the root of
 * a drive they share with other data. So the classifier is bounded by what the
 * shadow builder can actually write: a transcode, or the `cover.jpg` generated
 * beside it. Everything else survives no matter what else is true of it.
 */
describe("decidePrune — files the shadow builder never wrote", () => {
  const KNOWN_NOTHING = new Set<string>();

  it("leaves a document alone even though its folder holds no live audio", () => {
    const doc = entry("Thesis.docx");
    expect(names(decidePrune([doc], KNOWN_NOTHING).orphans)).toEqual([]);
  });

  it("leaves unrelated data alone in a folder it is pruning audio from", () => {
    const stale = entry("Album/01.mp3");
    const receipt = entry("Album/receipt.pdf");
    const photo = entry("Album/holiday.heic");

    const { orphans } = decidePrune([stale, receipt, photo], KNOWN_NOTHING);
    expect(names(orphans)).toEqual(["Album/01.mp3"]);
  });

  it("does not count a spared file's bytes as reclaimed", () => {
    const doc = entry("Thesis.docx", 5000);
    expect(decidePrune([doc], KNOWN_NOTHING).bytes).toBe(0);
  });

  it("still prunes the one artwork name the builder does write", () => {
    const cover = entry("Album/cover.jpg");
    expect(names(decidePrune([cover], KNOWN_NOTHING).orphans)).toEqual([
      "Album/cover.jpg",
    ]);
  });

  it("spares artwork it did not write, sitting beside artwork it did", () => {
    const ours = entry("Album/cover.jpg");
    const theirs = entry("Album/back-scan.jpg");

    const { orphans } = decidePrune([ours, theirs], KNOWN_NOTHING);
    expect(names(orphans)).toEqual(["Album/cover.jpg"]);
  });

  it("spares the AppleDouble sidecar of a file it is sparing", () => {
    const doc = entry("Thesis.docx");
    const sidecar = entry("._Thesis.docx");

    expect(names(decidePrune([doc, sidecar], KNOWN_NOTHING).orphans)).toEqual([]);
  });

  it("deletes nothing at all from a folder holding none of its own files", () => {
    const entries = [
      entry("taxes.xlsx"),
      entry("Photos/img_0001.heic"),
      entry("Notes/todo.txt"),
      entry(".DS_Store"),
    ];
    expect(decidePrune(entries, KNOWN_NOTHING).orphans).toEqual([]);
  });
});
