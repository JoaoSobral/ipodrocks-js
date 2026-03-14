/**
 * @vitest-environment node
 *
 * Tests for backfill logic in LibraryScanner — verifies that
 * already-processed tracks are never re-analyzed, cancellation
 * preserves partial results, and counters reflect remaining work.
 *
 * Uses an in-memory mock database so the tests work regardless of
 * which Node version better-sqlite3 is compiled for (system vs Electron).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { LibraryScanner } from "../main/library/library-scanner";

vi.mock("../main/library/metadata-extractor", () => {
  return {
    MetadataExtractor: vi.fn().mockImplementation(() => ({
      extractMetadata: vi.fn().mockResolvedValue({
        title: "Test",
        artist: "Artist",
        album: "Album",
        genre: "Rock",
        trackNumber: "1",
        discNumber: "1",
      }),
      extractAudioInfo: vi.fn().mockResolvedValue({
        duration: 180,
        bitrate: 320000,
        bitsPerSample: 16,
        codec: "MP3",
        sampleRate: 44100,
      }),
      extractAudioFeatures: vi.fn().mockResolvedValue({
        key: null,
        bpm: 120,
        camelot: null,
      }),
    })),
  };
});

vi.mock("../main/harmonic/essentia-analyzer", () => ({
  analyzeAudioWithEssentia: vi.fn().mockResolvedValue({
    key: "C major",
    bpm: 128,
    camelot: "8B",
  }),
}));

vi.mock("../main/library/hash-manager", () => ({
  HashManager: vi.fn().mockImplementation(() => ({})),
}));

interface MockTrack {
  id: number;
  path: string;
  content_type: string;
  features_scanned: number;
  key: string | null;
  bpm: number | null;
  camelot: string | null;
  genre_id: number;
}

/**
 * Lightweight in-memory database mock that simulates the SQL
 * queries used by LibraryScanner's backfill methods. Avoids
 * needing the better-sqlite3 native module.
 */
function createMockDb(tracks: MockTrack[]) {
  const store = [...tracks];

  function findTrack(id: number) {
    return store.find((t) => t.id === id);
  }

  /** Route SQL strings to the right in-memory operation. */
  function mockPrepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (
      normalized.includes("features_scanned = 0") &&
      normalized.includes("LIMIT")
    ) {
      return {
        all: (limit: number) =>
          store
            .filter(
              (t) =>
                t.content_type === "music" && t.features_scanned === 0
            )
            .slice(0, limit)
            .map((t) => ({ id: t.id, path: t.path })),
        get: () => null,
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    }

    if (
      normalized.includes("camelot IS NULL") &&
      normalized.includes("genre_id")
    ) {
      return {
        all: () =>
          store
            .filter(
              (t) =>
                t.content_type === "music" && t.camelot === null
            )
            .map((t) => ({
              id: t.id,
              path: t.path,
              genre_id: t.genre_id,
            })),
        get: () => null,
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    }

    if (
      normalized.includes("COUNT(*)") &&
      normalized.includes("content_type = 'music'")
    ) {
      return {
        get: () => ({
          c: store.filter((t) => t.content_type === "music").length,
        }),
        all: () => [],
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    }

    if (
      normalized.includes("UPDATE tracks SET features_scanned = 1 WHERE id")
    ) {
      return {
        run: (id: number) => {
          const t = findTrack(id);
          if (t) t.features_scanned = 1;
          return { changes: 1, lastInsertRowid: 0 };
        },
        get: () => null,
        all: () => [],
      };
    }

    if (
      normalized.includes("UPDATE tracks SET key") &&
      normalized.includes("features_scanned = 1")
    ) {
      return {
        run: (
          key: string | null,
          bpm: number | null,
          camelot: string | null,
          id: number
        ) => {
          const t = findTrack(id);
          if (t) {
            t.key = key;
            t.bpm = bpm;
            t.camelot = camelot;
            t.features_scanned = 1;
          }
          return { changes: 1, lastInsertRowid: 0 };
        },
        get: () => null,
        all: () => [],
      };
    }

    return {
      get: () => null,
      all: () => [],
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
    };
  }

  return {
    prepare: vi.fn(mockPrepare),
    exec: vi.fn(),
    _store: store,
  };
}

function makeTracks(
  count: number,
  opts?: {
    scannedIds?: number[];
    camelotIds?: number[];
    bpmOnlyIds?: number[];
    contentType?: string;
  }
): MockTrack[] {
  const tracks: MockTrack[] = [];
  for (let i = 1; i <= count; i++) {
    tracks.push({
      id: i,
      path: `/test/track${i}.mp3`,
      content_type: opts?.contentType ?? "music",
      features_scanned: 0,
      key: null,
      bpm: null,
      camelot: null,
      genre_id: 1,
    });
  }
  if (opts?.scannedIds) {
    for (const id of opts.scannedIds) {
      const t = tracks.find((tr) => tr.id === id);
      if (t) t.features_scanned = 1;
    }
  }
  if (opts?.camelotIds) {
    for (const id of opts.camelotIds) {
      const t = tracks.find((tr) => tr.id === id);
      if (t) {
        t.features_scanned = 1;
        t.key = "C major";
        t.bpm = 128;
        t.camelot = "8B";
      }
    }
  }
  if (opts?.bpmOnlyIds) {
    for (const id of opts.bpmOnlyIds) {
      const t = tracks.find((tr) => tr.id === id);
      if (t) {
        t.features_scanned = 1;
        t.bpm = 120;
      }
    }
  }
  return tracks;
}

/**
 * Collect unique file paths from "analyzing" progress callbacks.
 */
function collectAnalyzedPaths(): {
  paths: Set<string>;
  callback: (p: { path: string; status: string }) => void;
} {
  const paths = new Set<string>();
  const callback = (p: { path: string; status: string }) => {
    if (p.status === "analyzing" && p.path) paths.add(p.path);
  };
  return { paths, callback };
}

describe("backfillFeatures (tag-based)", () => {
  let db: ReturnType<typeof createMockDb>;
  let scanner: LibraryScanner;

  function setup(
    count: number,
    opts?: Parameters<typeof makeTracks>[1]
  ) {
    const tracks = makeTracks(count, opts);
    db = createMockDb(tracks);
    scanner = new LibraryScanner(db as never);
  }

  beforeEach(() => {
    setup(5);
  });

  it("selects only tracks with features_scanned = 0", async () => {
    setup(5, { scannedIds: [1, 2, 3] });

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeatures(100, callback);

    expect(paths.size).toBe(2);
    expect(paths.has("/test/track4.mp3")).toBe(true);
    expect(paths.has("/test/track5.mp3")).toBe(true);

    const allScanned = db._store.every(
      (t) => t.features_scanned === 1
    );
    expect(allScanned).toBe(true);
  });

  it("does NOT re-select BPM-only tracks (features_scanned=1, camelot=NULL)", async () => {
    setup(5, { bpmOnlyIds: [1, 2, 3] });

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeatures(100, callback);

    expect(paths.size).toBe(2);
    expect(paths.has("/test/track1.mp3")).toBe(false);
    expect(paths.has("/test/track2.mp3")).toBe(false);
    expect(paths.has("/test/track3.mp3")).toBe(false);
  });

  it("does NOT re-select tracks that already have camelot data", async () => {
    setup(5, { camelotIds: [1, 2] });

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeatures(100, callback);

    expect(paths.size).toBe(3);
    expect(paths.has("/test/track1.mp3")).toBe(false);
    expect(paths.has("/test/track2.mp3")).toBe(false);
  });

  it("processes zero tracks when all are already scanned", async () => {
    setup(5, { scannedIds: [1, 2, 3, 4, 5] });

    const result = await scanner.backfillFeatures(100);
    expect(result).toBe(0);
  });

  it("respects maxTracks limit", async () => {
    setup(20);

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeatures(5, callback);

    expect(paths.size).toBe(5);
  });

  it("preserves partial results after cancellation", async () => {
    setup(10);

    const controller = new AbortController();
    let callCount = 0;
    await scanner.backfillFeatures(
      100,
      () => {
        callCount++;
        if (callCount >= 6) controller.abort();
      },
      controller.signal
    );

    const processed = db._store.filter(
      (t) => t.features_scanned === 1
    );
    expect(processed.length).toBeGreaterThan(0);
    expect(processed.length).toBeLessThan(10);
  });

  it("re-run after cancel only processes remaining tracks", async () => {
    setup(10);

    const controller = new AbortController();
    let callCount = 0;
    await scanner.backfillFeatures(
      100,
      () => {
        callCount++;
        if (callCount >= 6) controller.abort();
      },
      controller.signal
    );

    const scannedAfterFirst = db._store.filter(
      (t) => t.features_scanned === 1
    ).length;
    expect(scannedAfterFirst).toBeGreaterThan(0);
    expect(scannedAfterFirst).toBeLessThan(10);

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeatures(100, callback);

    expect(paths.size).toBe(10 - scannedAfterFirst);

    const allScanned = db._store.every(
      (t) => t.features_scanned === 1
    );
    expect(allScanned).toBe(true);
  });
});

describe("backfillFeaturesWithEssentia", () => {
  let db: ReturnType<typeof createMockDb>;
  let scanner: LibraryScanner;

  function setup(
    count: number,
    opts?: Parameters<typeof makeTracks>[1]
  ) {
    const tracks = makeTracks(count, opts);
    db = createMockDb(tracks);
    scanner = new LibraryScanner(db as never);
  }

  beforeEach(() => {
    setup(10);
  });

  it("only samples tracks where camelot IS NULL", async () => {
    setup(10, { camelotIds: [1, 2, 3, 4, 5] });

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeaturesWithEssentia(100, callback);

    for (const p of paths) {
      expect(p).not.toMatch(/track[1-5]\.mp3$/);
    }
    expect(paths.size).toBe(5);
  });

  it("processes zero tracks when all have camelot data", async () => {
    setup(5, { camelotIds: [1, 2, 3, 4, 5] });

    const result = await scanner.backfillFeaturesWithEssentia(100);
    expect(result).toBe(0);
  });

  it("total count reflects only tracks needing analysis", async () => {
    setup(20, {
      camelotIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });

    let reportedTotal = 0;
    await scanner.backfillFeaturesWithEssentia(100, (p) => {
      reportedTotal = p.total;
    });

    expect(reportedTotal).toBeLessThanOrEqual(10);
    expect(reportedTotal).toBeGreaterThan(0);
  });

  it("preserves partial results after cancellation", async () => {
    setup(20);

    const controller = new AbortController();
    let callCount = 0;
    await scanner.backfillFeaturesWithEssentia(
      100,
      () => {
        callCount++;
        if (callCount >= 10) controller.abort();
      },
      controller.signal
    );

    const withCamelot = db._store.filter(
      (t) => t.camelot !== null
    );
    expect(withCamelot.length).toBeGreaterThan(0);
    expect(withCamelot.length).toBeLessThan(20);
  });

  it("re-run after cancel only processes remaining tracks", async () => {
    setup(20);

    const controller = new AbortController();
    let callCount = 0;
    await scanner.backfillFeaturesWithEssentia(
      100,
      () => {
        callCount++;
        if (callCount >= 10) controller.abort();
      },
      controller.signal
    );

    const camelotAfterFirst = db._store.filter(
      (t) => t.camelot !== null
    ).length;
    expect(camelotAfterFirst).toBeGreaterThan(0);
    expect(camelotAfterFirst).toBeLessThan(20);

    let secondTotal = 0;
    await scanner.backfillFeaturesWithEssentia(100, (p) => {
      secondTotal = p.total;
    });

    expect(secondTotal).toBe(20 - camelotAfterFirst);

    const allHaveCamelot = db._store
      .filter((t) => t.content_type === "music")
      .every((t) => t.camelot !== null);
    expect(allHaveCamelot).toBe(true);
  });

  it("does not re-analyze tracks that already have camelot from a previous run", async () => {
    setup(10, { bpmOnlyIds: [1, 2, 3] });

    await scanner.backfillFeaturesWithEssentia(100);

    const allHaveCamelot = db._store.every(
      (t) => t.camelot !== null
    );
    expect(allHaveCamelot).toBe(true);

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeaturesWithEssentia(100, callback);

    expect(paths.size).toBe(0);
  });

  it("respects percent parameter — only analyzes subset", async () => {
    setup(100);

    const { paths, callback } = collectAnalyzedPaths();
    await scanner.backfillFeaturesWithEssentia(10, callback);

    expect(paths.size).toBe(10);
  });

  it("skips non-music content types", async () => {
    const tracks = makeTracks(5, { contentType: "podcast" });
    db = createMockDb(tracks);
    scanner = new LibraryScanner(db as never);

    const result = await scanner.backfillFeaturesWithEssentia(100);
    expect(result).toBe(0);
  });
});

describe("backfill interaction between tag-based and Essentia", () => {
  it("tag backfill marks features_scanned=1, Essentia still picks up null-camelot tracks", async () => {
    const tracks = makeTracks(5);
    const db = createMockDb(tracks);
    const scanner = new LibraryScanner(db as never);

    await scanner.backfillFeatures(100);

    expect(db._store.every((t) => t.features_scanned === 1)).toBe(
      true
    );
    expect(db._store.every((t) => t.camelot === null)).toBe(true);

    await scanner.backfillFeaturesWithEssentia(100);

    expect(db._store.every((t) => t.camelot !== null)).toBe(true);
  });

  it("Essentia-processed tracks are skipped by both methods on re-run", async () => {
    const tracks = makeTracks(5);
    const db = createMockDb(tracks);
    const scanner = new LibraryScanner(db as never);

    await scanner.backfillFeaturesWithEssentia(100);

    const { paths: tagPaths, callback: tagCb } =
      collectAnalyzedPaths();
    await scanner.backfillFeatures(100, tagCb);
    expect(tagPaths.size).toBe(0);

    const { paths: essentiaPaths, callback: essentiaCb } =
      collectAnalyzedPaths();
    await scanner.backfillFeaturesWithEssentia(100, essentiaCb);
    expect(essentiaPaths.size).toBe(0);
  });
});
