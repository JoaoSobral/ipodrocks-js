import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type Database from "better-sqlite3";
import type {
  PodcastSubscription,
  PodcastEpisode,
  PodcastSearchResult,
} from "../../shared/types";

interface RssFeedData {
  feedUrl: string;
  title: string;
  author: string | null;
  description: string | null;
  imageUrl: string | null;
  episodes: Array<{
    guid: string;
    title: string;
    description: string;
    enclosureUrl: string;
    enclosureLength: number;
    durationSeconds: number;
    publishedAt: number;
  }>;
}

interface SubRow {
  id: number;
  feed_id: number;
  title: string;
  author: string | null;
  description: string | null;
  image_url: string | null;
  feed_url: string;
  auto_count: number;
  last_refreshed_at: string | null;
  created_at: string;
}

interface EpRow {
  id: number;
  subscription_id: number;
  guid: string;
  title: string;
  description: string | null;
  enclosure_url: string;
  duration_seconds: number | null;
  published_at: string | null;
  file_size: number | null;
  local_path: string | null;
  download_state: string;
  download_error: string | null;
  manual_selected: number;
  created_at: string;
}

function rowToSub(r: SubRow, isUpToDate = false, latestEpisodeAt: string | null = null): PodcastSubscription {
  return {
    id: r.id,
    feedId: r.feed_id,
    title: r.title,
    author: r.author,
    description: r.description,
    imageUrl: r.image_url,
    feedUrl: r.feed_url,
    autoCount: r.auto_count,
    lastRefreshedAt: r.last_refreshed_at,
    createdAt: r.created_at,
    isUpToDate,
    latestEpisodeAt,
  };
}

function getLatestEpisodeAt(db: Database.Database, subId: number): string | null {
  const row = db
    .prepare(
      `SELECT MAX(published_at) AS latest FROM podcast_episodes WHERE subscription_id = ?`
    )
    .get(subId) as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

function computeIsUpToDate(db: Database.Database, sub: SubRow): boolean {
  if (sub.auto_count > 0) {
    const total = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM (
           SELECT id FROM podcast_episodes
           WHERE subscription_id = ? ORDER BY published_at DESC LIMIT ?
         )`
      )
      .get(sub.id, sub.auto_count) as { cnt: number }).cnt;
    if (total === 0) return false;
    const ready = (db
      .prepare(
        `SELECT COUNT(*) as cnt FROM (
           SELECT download_state FROM podcast_episodes
           WHERE subscription_id = ? ORDER BY published_at DESC LIMIT ?
         ) WHERE download_state = 'ready'`
      )
      .get(sub.id, sub.auto_count) as { cnt: number }).cnt;
    return ready === total;
  } else {
    const result = db
      .prepare(
        `SELECT COUNT(*) as total,
                SUM(CASE WHEN download_state = 'ready' THEN 1 ELSE 0 END) as ready
         FROM podcast_episodes WHERE subscription_id = ? AND manual_selected = 1`
      )
      .get(sub.id) as { total: number; ready: number | null };
    return result.total > 0 && result.total === (result.ready ?? 0);
  }
}

function rowToEp(r: EpRow): PodcastEpisode {
  return {
    id: r.id,
    subscriptionId: r.subscription_id,
    guid: r.guid,
    title: r.title,
    description: r.description,
    enclosureUrl: r.enclosure_url,
    durationSeconds: r.duration_seconds,
    publishedAt: r.published_at,
    fileSize: r.file_size,
    localPath: r.local_path,
    downloadState: r.download_state as PodcastEpisode["downloadState"],
    downloadError: r.download_error,
    manualSelected: !!r.manual_selected,
    createdAt: r.created_at,
  };
}

export function listSubscriptions(db: Database.Database): PodcastSubscription[] {
  const rows = db
    .prepare(
      `SELECT s.*,
              (SELECT MAX(published_at) FROM podcast_episodes WHERE subscription_id = s.id) AS latest_episode_at
       FROM podcast_subscriptions s
       ORDER BY s.created_at ASC`
    )
    .all() as Array<SubRow & { latest_episode_at: string | null }>;
  return rows.map((r) => rowToSub(r, computeIsUpToDate(db, r), r.latest_episode_at));
}

export function getSubscriptionById(db: Database.Database, id: number): PodcastSubscription | null {
  const row = db
    .prepare("SELECT * FROM podcast_subscriptions WHERE id = ?")
    .get(id) as SubRow | undefined;
  return row ? rowToSub(row, computeIsUpToDate(db, row), getLatestEpisodeAt(db, row.id)) : null;
}

export function subscribe(
  db: Database.Database,
  result: PodcastSearchResult
): PodcastSubscription {
  const existing = db
    .prepare("SELECT id FROM podcast_subscriptions WHERE feed_id = ?")
    .get(result.feedId) as { id: number } | undefined;
  if (existing) {
    return getSubscriptionById(db, existing.id)!;
  }

  const info = db
    .prepare(
      `INSERT INTO podcast_subscriptions (feed_id, title, author, description, image_url, feed_url, source, auto_count)
       VALUES (?, ?, ?, ?, ?, ?, 'podcastindex', 1)`
    )
    .run(
      result.feedId,
      result.title,
      result.author || null,
      result.description || null,
      result.imageUrl || null,
      result.feedUrl
    );

  return getSubscriptionById(db, Number(info.lastInsertRowid))!;
}

/** Deterministic negative 31-bit feed id for an RSS feed URL. Never collides with positive Podcast Index IDs. */
export function stableRssFeedId(feedUrl: string): number {
  const hash = crypto.createHash("md5").update(feedUrl).digest("hex");
  const n = parseInt(hash.slice(0, 8), 16) % 0x7fffffff;
  return -(n === 0 ? 1 : n);
}

export function subscribeRssFeed(
  db: Database.Database,
  feed: RssFeedData
): PodcastSubscription {
  const feedId = stableRssFeedId(feed.feedUrl);

  const existing = db
    .prepare("SELECT id FROM podcast_subscriptions WHERE feed_id = ?")
    .get(feedId) as { id: number } | undefined;

  let subId: number;
  if (existing) {
    subId = existing.id;
  } else {
    const info = db
      .prepare(
        `INSERT INTO podcast_subscriptions (feed_id, title, author, description, image_url, feed_url, source, auto_count)
         VALUES (?, ?, ?, ?, ?, ?, 'rss', 1)`
      )
      .run(feedId, feed.title, feed.author, feed.description, feed.imageUrl, feed.feedUrl);
    subId = Number(info.lastInsertRowid);
  }

  for (const ep of feed.episodes) {
    if (!ep.enclosureUrl) continue;
    upsertEpisode(db, subId, {
      guid: ep.guid,
      title: ep.title,
      description: ep.description,
      enclosureUrl: ep.enclosureUrl,
      durationSeconds: ep.durationSeconds,
      publishedAt: ep.publishedAt,
      fileSize: ep.enclosureLength,
    });
  }

  return getSubscriptionById(db, subId)!;
}

/** Delete local files and device copies for a set of episodes. DB records are untouched. */
function cleanupEpisodeArtifacts(db: Database.Database, episodeIds: number[]): void {
  if (episodeIds.length === 0) return;
  const ph = episodeIds.map(() => "?").join(",");

  const localRows = db
    .prepare(`SELECT local_path FROM podcast_episodes WHERE id IN (${ph}) AND local_path IS NOT NULL`)
    .all(...episodeIds) as { local_path: string }[];
  for (const row of localRows) {
    try { fs.unlinkSync(row.local_path); } catch { /* ignore */ }
  }

  const deviceRows = db
    .prepare(
      `SELECT ds.device_relative_path, d.mount_path
       FROM device_podcast_synced ds
       JOIN devices d ON d.id = ds.device_id
       WHERE ds.episode_id IN (${ph})`
    )
    .all(...episodeIds) as { device_relative_path: string; mount_path: string }[];
  for (const row of deviceRows) {
    try { fs.unlinkSync(path.join(row.mount_path, row.device_relative_path)); } catch { /* ignore */ }
  }
}

/**
 * Delete specific episodes: removes local files, removes copies from all synced
 * devices, and marks each episode as 'skipped' so it won't be re-downloaded.
 */
export function deleteEpisodes(db: Database.Database, episodeIds: number[]): void {
  if (episodeIds.length === 0) return;
  const ph = episodeIds.map(() => "?").join(",");
  cleanupEpisodeArtifacts(db, episodeIds);
  db.transaction(() => {
    db.prepare(`UPDATE podcast_episodes SET download_state = 'skipped', local_path = NULL WHERE id IN (${ph})`).run(...episodeIds);
    db.prepare(`DELETE FROM device_podcast_synced WHERE episode_id IN (${ph})`).run(...episodeIds);
  })();
}

export function unsubscribe(db: Database.Database, subId: number): void {
  const episodes = db
    .prepare("SELECT id FROM podcast_episodes WHERE subscription_id = ?")
    .all(subId) as { id: number }[];
  cleanupEpisodeArtifacts(db, episodes.map((e) => e.id));
  db.prepare("DELETE FROM podcast_subscriptions WHERE id = ?").run(subId);
}

export function setAutoCount(db: Database.Database, subId: number, count: number): void {
  db.prepare("UPDATE podcast_subscriptions SET auto_count = ? WHERE id = ?").run(count, subId);
}

export function setManualSelection(
  db: Database.Database,
  subId: number,
  episodeIds: number[]
): void {
  db.transaction(() => {
    db.prepare("UPDATE podcast_episodes SET manual_selected = 0 WHERE subscription_id = ?").run(subId);
    if (episodeIds.length > 0) {
      const ph = episodeIds.map(() => "?").join(",");
      db.prepare(`UPDATE podcast_episodes SET manual_selected = 1 WHERE id IN (${ph}) AND subscription_id = ?`).run(...episodeIds, subId);
    }
  })();
}

export function listEpisodes(db: Database.Database, subId: number): PodcastEpisode[] {
  const rows = db
    .prepare(
      "SELECT * FROM podcast_episodes WHERE subscription_id = ? ORDER BY published_at DESC"
    )
    .all(subId) as EpRow[];
  return rows.map(rowToEp);
}

export function upsertEpisode(
  db: Database.Database,
  subId: number,
  ep: {
    guid: string;
    title: string;
    description: string;
    enclosureUrl: string;
    durationSeconds: number;
    publishedAt: number;
    fileSize: number;
  }
): number {
  const existing = db
    .prepare("SELECT id, local_path, download_state FROM podcast_episodes WHERE subscription_id = ? AND guid = ?")
    .get(subId, ep.guid) as { id: number; local_path: string | null; download_state: string } | undefined;

  if (existing) {
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO podcast_episodes
       (subscription_id, guid, title, description, enclosure_url, duration_seconds, published_at, file_size, download_state)
       VALUES (?, ?, ?, ?, ?, ?, datetime(?, 'unixepoch'), ?, 'pending')`
    )
    .run(
      subId,
      ep.guid,
      ep.title,
      ep.description || null,
      ep.enclosureUrl,
      ep.durationSeconds || null,
      ep.publishedAt,
      ep.fileSize || null
    );

  return Number(info.lastInsertRowid);
}

export function markLastRefreshed(db: Database.Database, subId: number): void {
  db.prepare(
    "UPDATE podcast_subscriptions SET last_refreshed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(subId);
}
