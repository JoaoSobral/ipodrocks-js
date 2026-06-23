import * as fs from "fs";
import type Database from "better-sqlite3";
import { getEpisodes } from "./podcast-index-client";
import {
  listSubscriptions,
  upsertEpisode,
  markLastRefreshed,
  listEpisodes,
} from "./podcast-subscriptions";
import { fetchAndParseFeed } from "./podcast-feed-import";
import { downloadEpisode } from "./podcast-downloader";
import { getPodcastsRoot } from "./podcast-storage";

const MAX_STORED_EPISODES = 10;

interface SubRow {
  id: number;
  feed_id: number;
  feed_url: string;
  source: string;
  auto_count: number;
}

/** Select target episode IDs, download missing ones, and prune old ones. */
async function downloadAndPruneTargets(
  db: Database.Database,
  subId: number,
  feedId: number,
  autoCount: number
): Promise<void> {
  let targetIds: number[];

  if (autoCount > 0) {
    const rows = db
      .prepare(
        `SELECT id FROM podcast_episodes
         WHERE subscription_id = ?
         ORDER BY published_at DESC
         LIMIT ?`
      )
      .all(subId, autoCount) as { id: number }[];
    targetIds = rows.map((r) => r.id);
  } else {
    const rows = db
      .prepare(
        `SELECT id FROM podcast_episodes
         WHERE subscription_id = ? AND manual_selected = 1
         ORDER BY published_at DESC
         LIMIT 5`
      )
      .all(subId) as { id: number }[];
    targetIds = rows.map((r) => r.id);
  }

  const currentRoot = getPodcastsRoot();
  for (const epId of targetIds) {
    const ep = db
      .prepare("SELECT download_state, local_path FROM podcast_episodes WHERE id = ?")
      .get(epId) as { download_state: string; local_path: string | null } | undefined;
    if (!ep) continue;
    const alreadyDone =
      ep.download_state === "ready" &&
      ep.local_path !== null &&
      ep.local_path.startsWith(currentRoot);
    if (alreadyDone) continue;
    await downloadEpisode(db, epId, feedId);
  }

  if (autoCount > 0) {
    pruneOldEpisodes(db, subId);
  }
}

async function refreshPodcastIndexSubscription(
  db: Database.Database,
  sub: SubRow,
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const MAX_FETCH = 50;
  let episodes;
  try {
    episodes = await getEpisodes(sub.feed_id, MAX_FETCH, apiKey, apiSecret);
  } catch (err) {
    console.error(`[podcasts] PI refresh failed for sub ${sub.id}:`, err);
    return;
  }

  for (const ep of episodes) {
    if (!ep.guid || !ep.enclosureUrl) continue;
    upsertEpisode(db, sub.id, {
      guid: ep.guid,
      title: ep.title,
      description: ep.description,
      enclosureUrl: ep.enclosureUrl,
      durationSeconds: ep.duration,
      publishedAt: ep.datePublished,
      fileSize: ep.enclosureLength,
    });
  }

  markLastRefreshed(db, sub.id);
  await downloadAndPruneTargets(db, sub.id, sub.feed_id, sub.auto_count);
}

async function refreshRssSubscription(
  db: Database.Database,
  sub: SubRow
): Promise<void> {
  let parsed;
  try {
    parsed = await fetchAndParseFeed(sub.feed_url);
  } catch (err) {
    console.error(`[podcasts] RSS refresh failed for sub ${sub.id}:`, err);
    return;
  }

  for (const ep of parsed.episodes) {
    if (!ep.enclosureUrl) continue;
    upsertEpisode(db, sub.id, {
      guid: ep.guid,
      title: ep.title,
      description: ep.description,
      enclosureUrl: ep.enclosureUrl,
      durationSeconds: ep.durationSeconds,
      publishedAt: ep.publishedAt,
      fileSize: ep.enclosureLength,
    });
  }

  markLastRefreshed(db, sub.id);
  await downloadAndPruneTargets(db, sub.id, sub.feed_id, sub.auto_count);
}

/**
 * Fetch the latest episodes for a single subscription, upsert them to DB,
 * then queue downloads for the target set.
 *
 * Target set:
 *   - auto_count > 0  → the N most recent episodes by published_at
 *   - auto_count = 0  → episodes with manual_selected = 1 (max 5)
 */
export async function refreshSubscription(
  db: Database.Database,
  subId: number,
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const sub = db
    .prepare("SELECT id, feed_id, feed_url, source, auto_count FROM podcast_subscriptions WHERE id = ?")
    .get(subId) as SubRow | undefined;
  if (!sub) return;

  if (sub.source === "rss") {
    await refreshRssSubscription(db, sub);
  } else {
    await refreshPodcastIndexSubscription(db, sub, apiKey, apiSecret);
  }
}

function pruneOldEpisodes(db: Database.Database, subId: number): void {
  const readyEps = db
    .prepare(
      `SELECT id, local_path FROM podcast_episodes
       WHERE subscription_id = ? AND download_state = 'ready'
       ORDER BY published_at DESC`
    )
    .all(subId) as { id: number; local_path: string | null }[];

  if (readyEps.length <= MAX_STORED_EPISODES) return;

  const toRemove = readyEps.slice(MAX_STORED_EPISODES);
  for (const ep of toRemove) {
    if (ep.local_path) {
      try { fs.unlinkSync(ep.local_path); } catch { /* ignore */ }
    }
    db.prepare(
      `UPDATE podcast_episodes SET download_state = 'skipped', local_path = NULL WHERE id = ?`
    ).run(ep.id);
  }
}

export async function refreshAll(
  db: Database.Database,
  apiKey: string,
  apiSecret: string
): Promise<void> {
  const subs = listSubscriptions(db);
  for (const sub of subs) {
    await refreshSubscription(db, sub.id, apiKey, apiSecret);
  }
}

/**
 * Re-download all episodes after a download folder change.
 * Resets ready/failed episodes to pending (clearing their old local_path)
 * so refreshAll re-fetches everything into the new folder.
 * Skipped episodes are left alone — they were intentionally excluded.
 */
export async function refreshAllForNewFolder(
  db: Database.Database,
  apiKey: string,
  apiSecret: string
): Promise<void> {
  db.prepare(
    `UPDATE podcast_episodes SET download_state = 'pending', local_path = NULL
     WHERE download_state IN ('ready', 'failed')`
  ).run();
  await refreshAll(db, apiKey, apiSecret);
}

/** Get the list of episode IDs that are ready and in the target set for a subscription. */
export function getReadyTargetEpisodes(
  db: Database.Database,
  subId: number
): Array<{ id: number; feedId: number; localPath: string }> {
  const sub = db
    .prepare("SELECT id, feed_id, feed_url, source, auto_count FROM podcast_subscriptions WHERE id = ?")
    .get(subId) as SubRow | undefined;
  if (!sub) return [];

  let rows: Array<{ id: number; local_path: string }>;
  if (sub.auto_count > 0) {
    rows = db
      .prepare(
        `SELECT id, local_path FROM podcast_episodes
         WHERE subscription_id = ? AND download_state = 'ready' AND local_path IS NOT NULL
         ORDER BY published_at DESC
         LIMIT ?`
      )
      .all(subId, sub.auto_count) as Array<{ id: number; local_path: string }>;
  } else {
    rows = db
      .prepare(
        `SELECT id, local_path FROM podcast_episodes
         WHERE subscription_id = ? AND manual_selected = 1 AND download_state = 'ready' AND local_path IS NOT NULL
         ORDER BY published_at DESC
         LIMIT 5`
      )
      .all(subId) as Array<{ id: number; local_path: string }>;
  }

  return rows.map((r) => ({ id: r.id, feedId: sub.feed_id, localPath: r.local_path }));
}

/** Fetch just the episode list (fresh from Podcast Index) for display purposes. */
export async function fetchEpisodesForDisplay(
  feedId: number,
  apiKey: string,
  apiSecret: string
): Promise<import("./podcast-index-client").PodcastIndexEpisode[]> {
  return getEpisodes(feedId, 50, apiKey, apiSecret);
}
