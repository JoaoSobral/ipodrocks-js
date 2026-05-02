import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { PodcastSearchModal } from "../renderer/components/modals/PodcastSearchModal";

vi.mock("../renderer/ipc/api", () => ({
  podcastListSubs: vi.fn().mockResolvedValue([]),
  podcastSubscribeFeed: vi.fn().mockResolvedValue({ id: 1, feedId: 42, title: "Test", author: null, description: null, imageUrl: null, feedUrl: "", autoCount: 1, lastRefreshedAt: null, createdAt: "" }),
  podcastUnsubscribe: vi.fn().mockResolvedValue(undefined),
  podcastSetAutoCount: vi.fn().mockResolvedValue(undefined),
  podcastListEpisodes: vi.fn().mockResolvedValue([]),
  podcastSetManualSelection: vi.fn().mockResolvedValue(undefined),
  podcastDownloadNow: vi.fn().mockResolvedValue({ ok: true }),
  podcastSearch: vi.fn().mockResolvedValue([]),
  podcastGetSettings: vi.fn().mockResolvedValue({ hasApiKey: false, hasSecret: false, apiKey: "", apiSecret: "", autoEnabled: false, intervalMin: 15, downloadDir: "/tmp/auto-podcasts", downloadDirCustom: null }),
  podcastSetSettings: vi.fn().mockResolvedValue(undefined),
  podcastSetDeviceAutoPodcasts: vi.fn().mockResolvedValue(undefined),
}));

import { podcastSearch } from "../renderer/ipc/api";
import { usePodcastsStore } from "../renderer/stores/podcasts-store";

function makeSearchResult(id: number, title: string) {
  return { feedId: id, title, author: "Author", description: "", imageUrl: "", feedUrl: "https://example.com/feed.xml", episodeCount: 5 };
}

beforeEach(() => {
  vi.clearAllMocks();
  usePodcastsStore.setState({
    subscriptions: [],
    episodesBySub: {},
    searchResults: [],
    searching: false,
    searchError: null,
    subscribedFeedIds: new Set(),
    loading: false,
    error: null,
  });
});

describe("PodcastSearchModal", () => {
  it("renders the search input when open", () => {
    render(<PodcastSearchModal open onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByPlaceholderText("Search for podcasts…")).toBeInTheDocument();
  });

  it("does not render when closed", () => {
    render(<PodcastSearchModal open={false} onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByPlaceholderText("Search for podcasts…")).not.toBeInTheDocument();
  });

  it("shows no-creds banner when search returns NO_CREDS error", async () => {
    vi.mocked(podcastSearch).mockResolvedValue({ error: "NO_CREDS" });

    render(<PodcastSearchModal open onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search for podcasts…");

    await act(async () => {
      fireEvent.change(input, { target: { value: "tech" } });
      // advance debounce
      await new Promise((r) => setTimeout(r, 350));
    });

    await waitFor(() => {
      expect(screen.getByText(/API credentials are not configured/i)).toBeInTheDocument();
    });
  });

  it("renders search results when API returns feeds", async () => {
    vi.mocked(podcastSearch).mockResolvedValue([
      makeSearchResult(1, "Podcast Alpha"),
      makeSearchResult(2, "Podcast Beta"),
    ]);

    render(<PodcastSearchModal open onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search for podcasts…");

    await act(async () => {
      fireEvent.change(input, { target: { value: "tech" } });
      await new Promise((r) => setTimeout(r, 350));
    });

    await waitFor(() => {
      expect(screen.getByText("Podcast Alpha")).toBeInTheDocument();
      expect(screen.getByText("Podcast Beta")).toBeInTheDocument();
    });
  });

  it("shows Subscribed badge for already-subscribed feeds", async () => {
    usePodcastsStore.setState({ subscribedFeedIds: new Set([1]) } as never);
    vi.mocked(podcastSearch).mockResolvedValue([makeSearchResult(1, "Existing Pod")]);

    render(<PodcastSearchModal open onClose={vi.fn()} onOpenSettings={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search for podcasts…");

    await act(async () => {
      fireEvent.change(input, { target: { value: "pod" } });
      await new Promise((r) => setTimeout(r, 350));
    });

    await waitFor(() => {
      expect(screen.getByText("✓ Subscribed")).toBeInTheDocument();
    });
  });
});
