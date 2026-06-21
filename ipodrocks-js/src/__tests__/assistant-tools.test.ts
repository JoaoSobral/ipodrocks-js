/**
 * @vitest-environment node
 *
 * Tests for the Rocksy AI tool registry (src/main/assistant/tools.ts).
 *
 * Covers:
 *  - Read tools run inline and return data
 *  - write-safe tools run inline and mutate state
 *  - write-destructive tools are classified as such (not run by default in the loop)
 *  - Invalid args are rejected with a thrown error
 *  - buildToolDefinitions() produces valid OpenAI-compatible tool schemas
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AI_TOOLS,
  buildToolDefinitions,
  getToolByName,
  type AiToolContext,
} from "../main/assistant/tools";

// ---------------------------------------------------------------------------
// Minimal DB mock — enough for the tools that query the database directly
// ---------------------------------------------------------------------------

function makeDb(rows: Record<string, unknown[]> = {}) {
  const stmts: Record<string, unknown> = {};
  return {
    prepare: (sql: string) => {
      if (!stmts[sql]) {
        stmts[sql] = {
          all: (..._args: unknown[]) => rows[sql] ?? [],
          get: (_id: unknown) => (rows[sql] ?? []).find(() => true) ?? null,
          run: vi.fn(),
        };
      }
      return stmts[sql];
    },
  };
}

function makeCtx(overrides: Partial<AiToolContext> = {}): AiToolContext {
  // Stable singleton mocks — calling getLibrary()/getPlaylistCore() multiple
  // times returns the same object so spy assertions work across call sites.
  const libraryMock = {
    addLibraryFolder: vi.fn().mockReturnValue({ id: 1 }),
    removeLibraryFolder: vi.fn().mockReturnValue(true),
  } as unknown as ReturnType<AiToolContext["getLibrary"]>;

  const playlistCoreMock = {
    getAlbums: vi.fn().mockReturnValue([{ id: 1, title: "OK Computer", artist: "Radiohead" }]),
    getArtists: vi.fn().mockReturnValue([{ id: 1, name: "Radiohead" }]),
    getGenres: vi.fn().mockReturnValue([{ id: 1, name: "Rock" }]),
    createSmartPlaylist: vi.fn(),
    createGeniusPlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    getBrokenPlaylists: vi.fn().mockReturnValue([]),
    repairPlaylist: vi.fn(),
  } as unknown as ReturnType<AiToolContext["getPlaylistCore"]>;

  return {
    db: makeDb() as unknown as AiToolContext["db"],
    getLibrary: () => libraryMock,
    getPlaylistCore: () => playlistCoreMock,
    getDevicesCore: () => ({
      getDevices: vi.fn().mockReturnValue([
        { profile: { id: 1, name: "iPod Classic", mountPath: "/Volumes/IPOD", modelName: "iPod Classic", lastSyncDate: null } },
      ]),
      getDeviceById: vi.fn().mockReturnValue({ profile: { id: 1, name: "iPod Classic" } }),
    }) as unknown as ReturnType<AiToolContext["getDevicesCore"]>,
    getPodcastIndexConfig: vi.fn().mockReturnValue({ apiKey: "key", apiSecret: "secret" }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Registry structure
// ---------------------------------------------------------------------------

describe("AI_TOOLS registry", () => {
  it("has no duplicate tool names", () => {
    const names = AI_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every tool has name, description, parameters, kind, summarize, run", () => {
    for (const tool of AI_TOOLS) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(typeof tool.parameters).toBe("object");
      expect(["read", "write-safe", "write-destructive"]).toContain(tool.kind);
      expect(typeof tool.summarize).toBe("function");
      expect(typeof tool.run).toBe("function");
    }
  });
});

describe("getToolByName", () => {
  it("returns the tool for a known name", () => {
    expect(getToolByName("device_list")).toBeDefined();
  });

  it("returns undefined for an unknown name", () => {
    expect(getToolByName("nonexistent_tool")).toBeUndefined();
  });
});

describe("buildToolDefinitions", () => {
  it("returns one definition per tool", () => {
    const defs = buildToolDefinitions();
    expect(defs.length).toBe(AI_TOOLS.length);
  });

  it("each definition has the OpenAI-compatible shape", () => {
    for (const def of buildToolDefinitions()) {
      expect(def.type).toBe("function");
      expect(typeof def.function.name).toBe("string");
      expect(typeof def.function.description).toBe("string");
      expect(typeof def.function.parameters).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// Read tools — run inline, return data
// ---------------------------------------------------------------------------

describe("library_list_artists (read)", () => {
  it("returns artists from the playlist core", async () => {
    const ctx = makeCtx();
    const tool = getToolByName("library_list_artists")!;
    expect(tool.kind).toBe("read");
    const result = await tool.run({}, ctx);
    expect(result).toEqual([{ id: 1, name: "Radiohead" }]);
  });
});

describe("library_list_albums (read)", () => {
  it("returns all albums when no filter", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("library_list_albums")!.run({}, ctx);
    expect((result as unknown[]).length).toBeGreaterThan(0);
  });

  it("filters albums by artist name (case-insensitive)", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("library_list_albums")!.run({ artist_filter: "radio" }, ctx) as Array<{ artist: string }>;
    expect(result.every((a) => a.artist?.toLowerCase().includes("radio"))).toBe(true);
  });

  it("returns empty array when filter matches nothing", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("library_list_albums")!.run({ artist_filter: "ZZZ_NO_MATCH" }, ctx);
    expect(result).toEqual([]);
  });
});

describe("library_list_genres (read)", () => {
  it("returns genres", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("library_list_genres")!.run({}, ctx);
    expect(result).toEqual([{ id: 1, name: "Rock" }]);
  });
});

describe("device_list (read)", () => {
  it("returns serialised device list (no Device objects)", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("device_list")!.run({}, ctx) as Array<{ id: number; name: string }>;
    expect(result[0].id).toBe(1);
    expect(result[0].name).toBe("iPod Classic");
  });
});

describe("podcast_list_episodes (read)", () => {
  it("throws for invalid subscription_id", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("podcast_list_episodes")!.run({ subscription_id: -1 }, ctx)
    ).rejects.toThrow("Invalid subscription_id");
  });
});

// ---------------------------------------------------------------------------
// Write-safe tools
// ---------------------------------------------------------------------------

describe("playlist_create_smart (write-safe)", () => {
  it("is classified as write-safe", () => {
    expect(getToolByName("playlist_create_smart")!.kind).toBe("write-safe");
  });

  it("throws when name is empty", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("playlist_create_smart")!.run({ name: "", rules: [] }, ctx)
    ).rejects.toThrow("name");
  });

  it("throws when rules array is empty", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("playlist_create_smart")!.run({ name: "Test", rules: [] }, ctx)
    ).rejects.toThrow("rule");
  });

  it("throws when no rules pass ID validation", async () => {
    const ctx = makeCtx();
    // DB returns null for any id lookup — meaning invalid IDs
    await expect(
      getToolByName("playlist_create_smart")!.run({
        name: "Test",
        rules: [{ ruleType: "genre", targetId: 9999, targetLabel: "Fake" }],
      }, ctx)
    ).rejects.toThrow("No valid rule IDs");
  });
});

describe("playlist_create_genius (write-safe)", () => {
  it("throws for unknown genius_type", async () => {
    const ctx = makeCtx();
    // getAvailableGeniusTypes queries the DB; our minimal mock causes it to
    // fail or return [] — either way an invalid genius_type must be rejected.
    await expect(
      getToolByName("playlist_create_genius")!.run({ name: "Test", genius_type: "bogus" }, ctx)
    ).rejects.toThrow();
  });
});

describe("podcast_subscribe (write-safe)", () => {
  it("is classified as write-safe", () => {
    expect(getToolByName("podcast_subscribe")!.kind).toBe("write-safe");
  });
});

// ---------------------------------------------------------------------------
// Write-destructive tools — must NOT be auto-run; verify classification only
// ---------------------------------------------------------------------------

const DESTRUCTIVE_TOOLS = [
  "device_check",
  "device_remove",
  "device_sync",
  "library_scan",
  "podcast_download_now",
  "podcast_delete_episodes",
  "library_add_folder",
  "library_remove_folder",
  "playlist_delete",
];

describe("write-destructive classification", () => {
  for (const name of DESTRUCTIVE_TOOLS) {
    it(`${name} is write-destructive`, () => {
      expect(getToolByName(name)?.kind).toBe("write-destructive");
    });
  }
});

describe("device_remove (write-destructive)", () => {
  it("summarize mentions the device id", () => {
    expect(getToolByName("device_remove")!.summarize({ device_id: 3 })).toContain("3");
  });

  it("throws for invalid device_id", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("device_remove")!.run({ device_id: 0 }, ctx)
    ).rejects.toThrow("Invalid device_id");
  });

  it("throws when device not found", async () => {
    const ctx = makeCtx({
      getDevicesCore: () => ({
        getDevices: vi.fn().mockReturnValue([]),
        getDeviceById: vi.fn().mockReturnValue(undefined),
        deleteDevice: vi.fn().mockReturnValue(false),
      }) as unknown as ReturnType<AiToolContext["getDevicesCore"]>,
    });
    await expect(
      getToolByName("device_remove")!.run({ device_id: 99 }, ctx)
    ).rejects.toThrow("not found");
  });

  it("calls deleteDevice and returns { removed: true }", async () => {
    const deleteDevice = vi.fn().mockReturnValue(true);
    const ctx = makeCtx({
      getDevicesCore: () => ({
        getDevices: vi.fn().mockReturnValue([]),
        getDeviceById: vi.fn().mockReturnValue({ profile: { id: 1, name: "Test iPod" } }),
        deleteDevice,
      }) as unknown as ReturnType<AiToolContext["getDevicesCore"]>,
    });
    const result = await getToolByName("device_remove")!.run({ device_id: 1 }, ctx);
    expect(result).toMatchObject({ removed: true, name: "Test iPod" });
    expect(deleteDevice).toHaveBeenCalledWith(1);
  });
});

describe("device_sync (write-destructive)", () => {
  it("summarize mentions the device id", () => {
    expect(getToolByName("device_sync")!.summarize({ device_id: 2 })).toContain("2");
  });

  it("throws for invalid device_id", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("device_sync")!.run({ device_id: -1 }, ctx)
    ).rejects.toThrow("Invalid device_id");
  });

  it("throws when device not found", async () => {
    const ctx = makeCtx({
      getDevicesCore: () => ({
        getDevices: vi.fn().mockReturnValue([]),
        getDeviceById: vi.fn().mockReturnValue(undefined),
      }) as unknown as ReturnType<AiToolContext["getDevicesCore"]>,
    });
    await expect(
      getToolByName("device_sync")!.run({ device_id: 99 }, ctx)
    ).rejects.toThrow("not found");
  });

  it("returns ok:true and deviceName on success", async () => {
    vi.mock("electron", () => ({
      BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([{ webContents: { send: vi.fn() } }]) },
    }));
    const ctx = makeCtx();
    const result = await getToolByName("device_sync")!.run({ device_id: 1 }, ctx) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.deviceName).toBe("iPod Classic");
  });
});

describe("library_scan (write-destructive)", () => {
  it("summarize returns a non-empty string", () => {
    expect(getToolByName("library_scan")!.summarize({})).toBeTruthy();
  });

  it("returns ok:true", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("library_scan")!.run({}, ctx) as Record<string, unknown>;
    expect(result.ok).toBe(true);
  });
});

describe("device_check summarize", () => {
  it("produces human-readable summary", () => {
    const summary = getToolByName("device_check")!.summarize({ device_id: 1 });
    expect(summary).toContain("1");
  });
});

describe("podcast_delete_episodes (write-destructive)", () => {
  it("summarize shows episode count", () => {
    const summary = getToolByName("podcast_delete_episodes")!.summarize({ episode_ids: [1, 2, 3] });
    expect(summary).toContain("3");
  });
});

describe("library_remove_folder (write-destructive)", () => {
  it("run() removes folder and returns { removed: true }", async () => {
    const ctx = makeCtx();
    const result = await getToolByName("library_remove_folder")!.run({ folder_id: 1 }, ctx);
    expect(result).toEqual({ removed: true });
    expect(ctx.getLibrary().removeLibraryFolder).toHaveBeenCalledWith(1, true);
  });

  it("throws for non-integer folder_id", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("library_remove_folder")!.run({ folder_id: 0 }, ctx)
    ).rejects.toThrow("Invalid folder_id");
  });
});

describe("playlist_delete (write-destructive)", () => {
  it("run() deletes the playlist", async () => {
    const ctx = makeCtx();
    await getToolByName("playlist_delete")!.run({ playlist_id: 5 }, ctx);
    expect(ctx.getPlaylistCore().deletePlaylist).toHaveBeenCalledWith(5);
  });

  it("throws for invalid playlist_id", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("playlist_delete")!.run({ playlist_id: -1 }, ctx)
    ).rejects.toThrow("Invalid playlist_id");
  });
});

describe("playlist_list_broken (read)", () => {
  it("is classified as read", () => {
    expect(getToolByName("playlist_list_broken")!.kind).toBe("read");
  });

  it("calls getBrokenPlaylists and returns results", async () => {
    const broken = [{ id: 3, name: "Road Trip", typeName: "custom", missingCount: 2, totalCount: 10 }];
    const ctx = makeCtx({
      getPlaylistCore: () => ({
        ...makeCtx().getPlaylistCore(),
        getBrokenPlaylists: vi.fn().mockReturnValue(broken),
      } as unknown as ReturnType<AiToolContext["getPlaylistCore"]>),
    });
    const result = await getToolByName("playlist_list_broken")!.run({}, ctx);
    expect(result).toEqual(broken);
  });
});

describe("playlist_repair (write-safe)", () => {
  it("is classified as write-safe", () => {
    expect(getToolByName("playlist_repair")!.kind).toBe("write-safe");
  });

  it("calls repairPlaylist with the given id", async () => {
    const repairPlaylist = vi.fn();
    const ctx = makeCtx({
      getPlaylistCore: () => ({
        ...makeCtx().getPlaylistCore(),
        repairPlaylist,
      } as unknown as ReturnType<AiToolContext["getPlaylistCore"]>),
    });
    const result = await getToolByName("playlist_repair")!.run({ playlist_id: 7 }, ctx);
    expect(repairPlaylist).toHaveBeenCalledWith(7);
    expect(result).toMatchObject({ repaired: true });
  });

  it("throws for invalid playlist_id", async () => {
    const ctx = makeCtx();
    await expect(
      getToolByName("playlist_repair")!.run({ playlist_id: 0 }, ctx)
    ).rejects.toThrow("Invalid playlist_id");
  });

  it("summarize mentions the playlist id", () => {
    expect(getToolByName("playlist_repair")!.summarize({ playlist_id: 9 })).toContain("9");
  });
});
