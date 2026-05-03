import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PodcastEpisodeModal } from "../renderer/components/modals/PodcastEpisodeModal";
import type { PodcastSubscription, PodcastEpisode } from "../renderer/ipc/api";

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

import { podcastListEpisodes, podcastSetAutoCount, podcastDownloadNow } from "../renderer/ipc/api";
import { usePodcastsStore } from "../renderer/stores/podcasts-store";

function makeSub(autoCount = 2): PodcastSubscription {
  return {
    id: 1,
    feedId: 100,
    title: "Test Podcast",
    author: "Author",
    description: null,
    imageUrl: null,
    feedUrl: "https://example.com/feed.xml",
    autoCount,
    lastRefreshedAt: null,
    createdAt: new Date().toISOString(),
    isUpToDate: false,
  };
}

function makeEp(id: number, state: PodcastEpisode["downloadState"] = "pending", manualSelected = false): PodcastEpisode {
  return {
    id,
    subscriptionId: 1,
    guid: `guid-${id}`,
    title: `Episode ${id}`,
    description: null,
    enclosureUrl: `https://example.com/ep${id}.mp3`,
    durationSeconds: 3600,
    publishedAt: new Date().toISOString(),
    fileSize: null,
    localPath: null,
    downloadState: state,
    downloadError: null,
    manualSelected,
    createdAt: new Date().toISOString(),
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

describe("PodcastEpisodeModal", () => {
  it("does not render when open=false", () => {
    render(<PodcastEpisodeModal open={false} subscription={makeSub()} onClose={vi.fn()} />);
    expect(screen.queryByText("Test Podcast")).not.toBeInTheDocument();
  });

  it("shows subscription title and episodes", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([makeEp(1), makeEp(2)]);
    render(<PodcastEpisodeModal open subscription={makeSub()} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText("Test Podcast")).toBeInTheDocument();
      expect(screen.getByText("Episode 1")).toBeInTheDocument();
      expect(screen.getByText("Episode 2")).toBeInTheDocument();
    });
  });

  it("shows checkboxes in manual mode (autoCount=0)", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([makeEp(1), makeEp(2), makeEp(3)]);
    render(<PodcastEpisodeModal open subscription={makeSub(0)} onClose={vi.fn()} />);
    await waitFor(() => {
      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes.length).toBeGreaterThanOrEqual(3);
    });
  });

  it("does not show checkboxes in auto mode", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([makeEp(1), makeEp(2)]);
    render(<PodcastEpisodeModal open subscription={makeSub(2)} onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    });
  });

  it("calls download handler on button click", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([makeEp(1)]);
    render(<PodcastEpisodeModal open subscription={makeSub()} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Episode 1"));

    fireEvent.click(screen.getByText("Download now"));
    expect(podcastDownloadNow).toHaveBeenCalledWith(1);
  });

  it("calls unsubscribe on button click and closes", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([]);
    const onClose = vi.fn();
    render(<PodcastEpisodeModal open subscription={makeSub()} onClose={onClose} />);
    await waitFor(() => screen.getByText("Unsubscribe"));

    fireEvent.click(screen.getByText("Unsubscribe"));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("renders artwork img when imageUrl is set", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([]);
    const sub = { ...makeSub(), imageUrl: "https://example.com/art.jpg" };
    render(<PodcastEpisodeModal open subscription={sub} onClose={vi.fn()} />);
    await waitFor(() => screen.getByText("Test Podcast"));
    const img = document.querySelector('img[src="https://example.com/art.jpg"]');
    expect(img).not.toBeNull();
  });

  it("shows autoCount value in select", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([]);
    render(<PodcastEpisodeModal open subscription={makeSub(3)} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Last 3 episodes")).toBeInTheDocument());
  });

  it("shows updated autoCount when re-rendered with new subscription prop", async () => {
    vi.mocked(podcastListEpisodes).mockResolvedValue([]);
    const sub2 = makeSub(2);
    const sub5 = { ...makeSub(5), id: 1 };
    const { rerender } = render(
      <PodcastEpisodeModal open subscription={sub2} onClose={vi.fn()} />
    );
    await waitFor(() => screen.getByText("Last 2 episodes"));

    rerender(<PodcastEpisodeModal open subscription={sub5} onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Last 5 episodes")).toBeInTheDocument());
  });
});
