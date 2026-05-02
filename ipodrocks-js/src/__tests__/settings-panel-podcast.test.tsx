import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../renderer/components/panels/SettingsPanel";

vi.mock("../renderer/ipc/api", () => ({
  getOpenRouterConfig: vi.fn().mockResolvedValue({ apiKey: "", model: "" }),
  setOpenRouterConfig: vi.fn().mockResolvedValue(undefined),
  testOpenRouterConnection: vi.fn().mockResolvedValue({ ok: true }),
  checkSavantKeyData: vi.fn().mockResolvedValue({ totalCount: 0, keyedCount: 0, coveragePct: 0, bpmOnlyCount: 0 }),
  getHarmonicPrefs: vi.fn().mockResolvedValue({ scanHarmonicData: true, backfillPercent: 100, analyzeWithEssentia: false, analyzePercent: 10 }),
  setHarmonicPrefs: vi.fn().mockResolvedValue(undefined),
  podcastGetSettings: vi.fn(),
  podcastSetSettings: vi.fn().mockResolvedValue(undefined),
  podcastBrowseDownloadDir: vi.fn().mockResolvedValue(null),
  podcastRefreshAllForNewFolder: vi.fn().mockResolvedValue({ ok: true }),
  podcastSearch: vi.fn().mockResolvedValue([]),
}));

import { podcastGetSettings, podcastBrowseDownloadDir, podcastSetSettings, podcastRefreshAllForNewFolder } from "../renderer/ipc/api";

const DEFAULT_DIR = "/tmp/auto-podcasts";

function makeSettings(apiKey = "", apiSecret = "", downloadDirCustom: string | null = null) {
  return {
    hasApiKey: !!apiKey,
    hasSecret: !!apiSecret,
    apiKey,
    apiSecret,
    autoEnabled: false,
    intervalMin: 15,
    downloadDir: DEFAULT_DIR,
    downloadDirCustom,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SettingsPanel — podcast credentials UI", () => {
  it("pre-populates password fields with stored credentials", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings("mykey123", "mysecret456"));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => {
      // Three password inputs: OpenRouter key (0), podcast key (1), podcast secret (2)
      const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
      expect((pwdInputs[1] as HTMLInputElement).value).toBe("mykey123");
      expect((pwdInputs[2] as HTMLInputElement).value).toBe("mysecret456");
    });
  });

  it("leaves password fields empty when no credentials are stored", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings("", ""));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Auto Podcasts"));
    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect((pwdInputs[1] as HTMLInputElement).value).toBe("");
    expect((pwdInputs[2] as HTMLInputElement).value).toBe("");
  });

  it("shows the current download folder path", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings("", "", "/custom/podcasts"));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('input[value="/custom/podcasts"]');
      expect(input).not.toBeNull();
    });
  });

  it("shows Reset button when a custom folder is set and removes it on click", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings("", "", "/custom/podcasts"));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Reset"));

    fireEvent.click(screen.getByText("Reset"));
    await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>(`input[value="${DEFAULT_DIR}"]`);
      expect(input).not.toBeNull();
      expect(screen.queryByText("Reset")).toBeNull();
    });
  });

  it("updates folder when Browse returns a path", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings());
    vi.mocked(podcastBrowseDownloadDir).mockResolvedValue("/new/path");
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Browse…"));

    fireEvent.click(screen.getByText("Browse…"));
    await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('input[value="/new/path"]');
      expect(input).not.toBeNull();
    });
  });

  it("triggers refreshAllForNewFolder when folder changes on save", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings());
    vi.mocked(podcastBrowseDownloadDir).mockResolvedValue("/new/folder");
    vi.mocked(podcastSetSettings).mockResolvedValue(undefined);
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Browse…"));

    // Pick a new folder
    fireEvent.click(screen.getByText("Browse…"));
    await waitFor(() => {
      const input = document.querySelector<HTMLInputElement>('input[value="/new/folder"]');
      expect(input).not.toBeNull();
    });

    // Save
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => {
      expect(podcastRefreshAllForNewFolder).toHaveBeenCalled();
    });
  });

  it("does not trigger refreshAllForNewFolder when folder is unchanged on save", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings());
    vi.mocked(podcastSetSettings).mockResolvedValue(undefined);
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Save"));

    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(podcastSetSettings).toHaveBeenCalled());
    expect(podcastRefreshAllForNewFolder).not.toHaveBeenCalled();
  });

  it("updates the key field when the user types a new value", async () => {
    vi.mocked(podcastGetSettings).mockResolvedValue(makeSettings("oldkey", "oldsecret"));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => {
      const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
      expect((pwdInputs[1] as HTMLInputElement).value).toBe("oldkey");
    });

    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[1], { target: { value: "newkey" } });
    expect((pwdInputs[1] as HTMLInputElement).value).toBe("newkey");
  });
});
