import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../renderer/components/panels/SettingsPanel";

vi.mock("../renderer/ipc/api", () => ({
  getOpenRouterConfig: vi.fn(),
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

import {
  getOpenRouterConfig,
  testOpenRouterConnection,
  podcastGetSettings,
  podcastSearch,
} from "../renderer/ipc/api";

const DEFAULT_DIR = "/tmp/auto-podcasts";

function makePodcastSettings(hasApiKey = false, hasApiSecret = false) {
  return {
    hasApiKey,
    hasApiSecret,
    autoEnabled: false,
    intervalMin: 15,
    downloadDir: DEFAULT_DIR,
    downloadDirCustom: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(podcastGetSettings).mockResolvedValue(makePodcastSettings(false, false));
});

describe("SettingsPanel — OpenRouter Test Connection (issue #73)", () => {
  it("refuses to test when the input is empty and no key is stored", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    // Click Test with empty input and no stored key.
    fireEvent.click(screen.getAllByText("Test Connection")[0]);

    await waitFor(() => {
      expect(screen.getByText("Enter an API key first")).toBeTruthy();
    });
    // Crucially, "Connected" must NOT appear, and the IPC must not be hit.
    expect(screen.queryByText(/^Connected/)).toBeNull();
    expect(testOpenRouterConnection).not.toHaveBeenCalled();
  });

  it("shows 'Connected (using stored key)' when testing without retyping", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue({
      apiKey: "••••••••abcd",
      model: "anthropic/claude-sonnet-4.6",
    });
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    fireEvent.click(screen.getAllByText("Test Connection")[0]);

    await waitFor(() => {
      expect(screen.getByText(/Connected \(using stored key\)/)).toBeTruthy();
    });
    // Server gets null override → falls back to stored key.
    expect(testOpenRouterConnection).toHaveBeenCalledWith(null);
  });

  it("shows the 'click Save to persist' hint after testing a freshly typed key", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[0], { target: { value: "sk-or-new" } });

    fireEvent.click(screen.getAllByText("Test Connection")[0]);

    await waitFor(() => {
      expect(screen.getByText(/Connected — click Save to persist this key/)).toBeTruthy();
    });
    expect(testOpenRouterConnection).toHaveBeenCalledWith({
      apiKey: "sk-or-new",
      model: "anthropic/claude-sonnet-4.6",
    });
  });

  it("clears the 'Connected' badge when the user edits the API key after a successful test", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[0], { target: { value: "sk-or-new" } });
    fireEvent.click(screen.getAllByText("Test Connection")[0]);
    await waitFor(() => screen.getByText(/Connected/));

    // User edits the key — stale "Connected" should disappear.
    fireEvent.change(pwdInputs[0], { target: { value: "sk-or-other" } });
    expect(screen.queryByText(/Connected/)).toBeNull();
  });

  it("clears the 'Connected' badge when the user edits the model after a successful test", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[0], { target: { value: "sk-or-new" } });
    fireEvent.click(screen.getAllByText("Test Connection")[0]);
    await waitFor(() => screen.getByText(/Connected/));

    const modelInputs = document.querySelectorAll<HTMLInputElement>(
      'input[placeholder="anthropic/claude-sonnet-4.6"]',
    );
    fireEvent.change(modelInputs[0], { target: { value: "openai/gpt-4" } });
    expect(screen.queryByText(/Connected/)).toBeNull();
  });

  it("does not leak stale 'Connected' across close→reopen — the core issue #73 bug", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    const onClose = vi.fn();
    const { rerender } = render(<SettingsPanel open onClose={onClose} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    // 1) User types a key and successfully tests it.
    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[0], { target: { value: "sk-or-new" } });
    fireEvent.click(screen.getAllByText("Test Connection")[0]);
    await waitFor(() => screen.getByText(/Connected/));

    // 2) User closes the panel WITHOUT saving. App.tsx keeps SettingsPanel
    //    mounted; only the `open` prop flips, so state would normally persist.
    rerender(<SettingsPanel open={false} onClose={onClose} />);

    // 3) User reopens. Nothing was saved, so the load returns null again.
    rerender(<SettingsPanel open onClose={onClose} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    // The stale "Connected" badge must NOT be sitting next to an empty field.
    expect(screen.queryByText(/Connected/)).toBeNull();
    const reopened = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(reopened[0].value).toBe("");
  });

  it("surfaces a server error from the IPC without leaving a 'Connected' badge", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    vi.mocked(testOpenRouterConnection).mockResolvedValueOnce({
      ok: false,
      error: "OpenRouter error 401: invalid key",
    });
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("OpenRouter API"));

    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[0], { target: { value: "sk-or-bad" } });
    fireEvent.click(screen.getAllByText("Test Connection")[0]);

    await waitFor(() => {
      expect(screen.getByText(/invalid key/)).toBeTruthy();
    });
    expect(screen.queryByText(/Connected/)).toBeNull();
  });
});

describe("SettingsPanel — Podcast Test Connection", () => {
  it("refuses to test when no credentials are stored", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    vi.mocked(podcastGetSettings).mockResolvedValue(makePodcastSettings(false, false));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Auto Podcasts"));

    // Two "Test Connection" buttons: OpenRouter (0), Podcast (1).
    fireEvent.click(screen.getAllByText("Test Connection")[1]);

    await waitFor(() => {
      expect(screen.getByText("Enter API key and secret first")).toBeTruthy();
    });
    expect(podcastSearch).not.toHaveBeenCalled();
  });

  it("refuses to test when the user typed new creds — Save first", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    vi.mocked(podcastGetSettings).mockResolvedValue(makePodcastSettings(true, true));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Auto Podcasts"));

    // Type a new key, leaving secret blank (stored creds exist on disk).
    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[1], { target: { value: "new-key" } });

    fireEvent.click(screen.getAllByText("Test Connection")[1]);

    await waitFor(() => {
      expect(screen.getByText(/Save first — Test uses stored credentials/)).toBeTruthy();
    });
    expect(podcastSearch).not.toHaveBeenCalled();
  });

  it("tests stored credentials when both fields are blank", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    vi.mocked(podcastGetSettings).mockResolvedValue(makePodcastSettings(true, true));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Auto Podcasts"));

    fireEvent.click(screen.getAllByText("Test Connection")[1]);

    await waitFor(() => {
      expect(podcastSearch).toHaveBeenCalledWith("test");
      expect(screen.getByText("Connected")).toBeTruthy();
    });
  });

  it("clears the podcast 'Connected' badge when the user edits the key", async () => {
    vi.mocked(getOpenRouterConfig).mockResolvedValue(null);
    vi.mocked(podcastGetSettings).mockResolvedValue(makePodcastSettings(true, true));
    render(<SettingsPanel open onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Auto Podcasts"));

    fireEvent.click(screen.getAllByText("Test Connection")[1]);
    await waitFor(() => screen.getByText("Connected"));

    const pwdInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    fireEvent.change(pwdInputs[1], { target: { value: "replaced" } });
    expect(screen.queryByText("Connected")).toBeNull();
  });
});
