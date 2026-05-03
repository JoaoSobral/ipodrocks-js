import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AutoPodcastsPanel } from "../renderer/components/panels/AutoPodcastsPanel";

vi.mock("../renderer/ipc/api", () => ({
  podcastListSubs: vi.fn().mockResolvedValue([]),
  podcastSubscribeFeed: vi.fn().mockResolvedValue(undefined),
  podcastUnsubscribe: vi.fn().mockResolvedValue(undefined),
  podcastSetAutoCount: vi.fn().mockResolvedValue(undefined),
  podcastListEpisodes: vi.fn().mockResolvedValue([]),
  podcastSetManualSelection: vi.fn().mockResolvedValue(undefined),
  podcastDownloadNow: vi.fn().mockResolvedValue({ ok: true }),
  podcastSearch: vi.fn().mockResolvedValue([]),
  podcastGetSettings: vi.fn().mockResolvedValue({ hasApiKey: false, hasApiSecret: false, autoEnabled: false, intervalMin: 15, downloadDir: "/tmp/auto-podcasts", downloadDirCustom: null }),
  podcastSetSettings: vi.fn().mockResolvedValue(undefined),
  podcastSetDeviceAutoPodcasts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../renderer/stores/ui-store", () => ({
  useUIStore: (sel: (s: { openSettings: null }) => unknown) =>
    sel({ openSettings: null }),
}));

import { podcastListSubs } from "../renderer/ipc/api";
import { usePodcastsStore } from "../renderer/stores/podcasts-store";

function makeSub(id: number, title: string) {
  return {
    id,
    feedId: id * 100,
    title,
    author: "Author",
    description: null,
    imageUrl: null,
    feedUrl: "https://example.com/feed.xml",
    autoCount: 2,
    lastRefreshedAt: null,
    createdAt: new Date().toISOString(),
    isUpToDate: false,
  };
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

describe("AutoPodcastsPanel", () => {
  it("shows empty state when no subscriptions", async () => {
    vi.mocked(podcastListSubs).mockResolvedValue([]);
    render(<AutoPodcastsPanel />);
    await waitFor(() => {
      expect(screen.getByText("No subscriptions yet")).toBeInTheDocument();
    });
  });

  it("renders subscription cards", async () => {
    vi.mocked(podcastListSubs).mockResolvedValue([
      makeSub(1, "My Podcast"),
      makeSub(2, "Another Show"),
    ]);
    render(<AutoPodcastsPanel />);
    await waitFor(() => {
      expect(screen.getByText("My Podcast")).toBeInTheDocument();
      expect(screen.getByText("Another Show")).toBeInTheDocument();
    });
  });

  it("shows search & subscribe button", () => {
    render(<AutoPodcastsPanel />);
    expect(screen.getByText(/Search & Subscribe/)).toBeInTheDocument();
  });

  it("paginates when there are more than 24 subscriptions", async () => {
    const subs = Array.from({ length: 25 }, (_, i) => makeSub(i + 1, `Podcast ${i + 1}`));
    vi.mocked(podcastListSubs).mockResolvedValue(subs);
    render(<AutoPodcastsPanel />);
    await waitFor(() => {
      expect(screen.getByText("1 / 2")).toBeInTheDocument();
    });
    // Navigate to page 2
    fireEvent.click(screen.getByText(/Next/));
    await waitFor(() => {
      expect(screen.getByText("2 / 2")).toBeInTheDocument();
    });
  });

  it("shows subscription count in header", async () => {
    vi.mocked(podcastListSubs).mockResolvedValue([makeSub(1, "P1"), makeSub(2, "P2")]);
    render(<AutoPodcastsPanel />);
    await waitFor(() => {
      expect(screen.getByText("2 subscriptions")).toBeInTheDocument();
    });
  });

  it("renders podcast artwork img when imageUrl is set", async () => {
    const sub = { ...makeSub(1, "Art Podcast"), imageUrl: "https://example.com/art.jpg" };
    vi.mocked(podcastListSubs).mockResolvedValue([sub]);
    render(<AutoPodcastsPanel />);
    await waitFor(() => {
      const img = document.querySelector('img[src="https://example.com/art.jpg"]');
      expect(img).not.toBeNull();
    });
  });

  it("episode modal select reflects live autoCount from store after update", async () => {
    const sub = makeSub(1, "Live Podcast");
    vi.mocked(podcastListSubs).mockResolvedValue([sub]);
    render(<AutoPodcastsPanel />);
    await waitFor(() => screen.getByText("Live Podcast"));

    // Open episode modal
    fireEvent.click(screen.getByText("Live Podcast"));
    await waitFor(() => screen.getByText("Last 2 episodes"));

    // Simulate autoCount update via store (what setAutoCount does internally)
    usePodcastsStore.setState({
      subscriptions: [{ ...sub, autoCount: 4 }],
    });
    await waitFor(() => expect(screen.getByText("Last 4 episodes")).toBeInTheDocument());
  });
});
