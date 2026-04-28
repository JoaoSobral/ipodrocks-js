/**
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as path from "path";

const TEMP_DIR = path.join(os.tmpdir(), "ipodrocks-player");

// vi.hoisted ensures these refs are available when the hoisted vi.mock factories run
const { capturedHandlerRef, mockRegisterSchemesAsPrivileged, mockFetch } = vi.hoisted(() => {
  const capturedHandlerRef: { current: ((req: { url: string }) => Response | Promise<Response>) | null } = { current: null };
  return {
    capturedHandlerRef,
    mockRegisterSchemesAsPrivileged: vi.fn(),
    mockFetch: vi.fn(),
  };
});

vi.mock("electron", () => ({
  protocol: {
    registerSchemesAsPrivileged: mockRegisterSchemesAsPrivileged,
    handle: (_scheme: string, handler: (req: { url: string }) => Response | Promise<Response>) => {
      capturedHandlerRef.current = handler;
    },
  },
  net: { fetch: mockFetch },
}));

vi.mock("../main/player/player-source", () => ({
  decodeUrlToPath: vi.fn(),
  getPlayerTempDir: vi.fn(() => TEMP_DIR),
  isAudioFilePath: vi.fn(),
}));

import { registerMediaScheme, registerMediaProtocol } from "../main/player/media-protocol";
import { decodeUrlToPath, getPlayerTempDir, isAudioFilePath } from "../main/player/player-source";

const mockDecode = vi.mocked(decodeUrlToPath);
const mockGetTempDir = vi.mocked(getPlayerTempDir);
const mockIsAudio = vi.mocked(isAudioFilePath);

describe("registerMediaScheme", () => {
  it("registers the media scheme as privileged with the expected flags", () => {
    registerMediaScheme();
    expect(mockRegisterSchemesAsPrivileged).toHaveBeenCalledWith([
      {
        scheme: "media",
        privileges: {
          secure: true,
          standard: true,
          supportFetchAPI: true,
          stream: true,
        },
      },
    ]);
  });
});

describe("registerMediaProtocol handler", () => {
  beforeEach(() => {
    capturedHandlerRef.current = null;
    mockFetch.mockReset();
    mockDecode.mockReset();
    mockGetTempDir.mockReturnValue(TEMP_DIR);
    mockIsAudio.mockReset();
    registerMediaProtocol();
    expect(capturedHandlerRef.current).not.toBeNull();
  });

  async function handle(url: string): Promise<Response> {
    return capturedHandlerRef.current!({ url });
  }

  it("returns 400 when decodeUrlToPath throws", async () => {
    mockDecode.mockImplementation(() => { throw new Error("bad base64"); });
    const res = await handle("media://local/!!!invalid!!!");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/bad request/i);
  });

  it("returns 403 when path is outside tempDir and not an audio file", async () => {
    mockDecode.mockReturnValue("/etc/passwd");
    mockIsAudio.mockReturnValue(false);
    const res = await handle("media://local/sometoken");
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/forbidden/i);
  });

  it("fetches when path is inside the player temp dir (non-audio extension)", async () => {
    const tempFile = path.join(TEMP_DIR, "abc123.ogg");
    mockDecode.mockReturnValue(tempFile);
    mockIsAudio.mockReturnValue(true); // .ogg is audio but we mainly care about tempDir here
    mockFetch.mockResolvedValue(new Response("audio data", { status: 200 }));
    const res = await handle("media://local/sometoken");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(path.resolve(tempFile).replace(/\\/g, "/")),
    );
  });

  it("fetches when path is a valid audio file outside tempDir", async () => {
    mockDecode.mockReturnValue("/Users/test/Music/song.mp3");
    mockIsAudio.mockReturnValue(true);
    mockFetch.mockResolvedValue(new Response("audio data", { status: 200 }));
    const res = await handle("media://local/sometoken");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalled();
  });

  it("fetches when path is inside tempDir even with no recognized audio extension", async () => {
    const tempFile = path.join(TEMP_DIR, "tmp-transcode-file");
    mockDecode.mockReturnValue(tempFile);
    mockIsAudio.mockReturnValue(false);
    mockFetch.mockResolvedValue(new Response("data", { status: 200 }));
    const res = await handle("media://local/sometoken");
    expect(res.status).toBe(200);
  });

  it("passes a file:// URL derived from the resolved path to net.fetch", async () => {
    mockDecode.mockReturnValue("/music/song.flac");
    mockIsAudio.mockReturnValue(true);
    mockFetch.mockResolvedValue(new Response("", { status: 200 }));
    await handle("media://local/sometoken");
    const [[fetchedUrl]] = mockFetch.mock.calls;
    expect(fetchedUrl).toMatch(/^file:\/\//);
    expect(fetchedUrl).toContain("song.flac");
  });

  it("does not call net.fetch when returning 403", async () => {
    mockDecode.mockReturnValue("/secret/data.bin");
    mockIsAudio.mockReturnValue(false);
    await handle("media://local/sometoken");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
