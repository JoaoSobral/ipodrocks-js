import * as fs from "fs";
import * as path from "path";
import { encodePathToUrl } from "../player/media-url";
import type Database from "better-sqlite3";
import type { AudiobookSubscription, AudiobookChapter, LibrivoxSearchResult } from "../../shared/types";
import { fetchAndParseFeed } from "../podcasts/podcast-feed-import";
import { assertLibrivoxId, getAudiobooksRoot, getChapterDir } from "./audiobook-storage";
import { downloadCover } from "./audiobook-cover";

interface SubRow {
  id: number;
  librivox_id: number;
  title: string;
  author: string | null;
  description: string | null;
  image_url: string | null;
  rss_url: string;
  language: string | null;
  num_sections: number;
  total_seconds: number;
  last_refreshed_at: string | null;
  created_at: string;
}

interface ChapterRow {
  id: number;
  subscription_id: number;
  guid: string;
  chapter_number: number | null;
  title: string;
  enclosure_url: string;
  duration_seconds: number | null;
  file_size: number | null;
  local_path: string | null;
  download_state: string;
  download_error: string | null;
  created_at: string;
}

/**
 * Cover art is an absolute server path in the database and a URL in the API
 * response. It goes through the shared encoder so that under the web server it
 * becomes an `/api/media/` token like everything else — before, this was a
 * second hand-rolled `media://` string and would have been the one image
 * source that stayed pointed at a scheme the browser has never heard of.
 */
function localPathToMediaUrl(p: string): string | null {
  // Only a cover *this app downloaded* may become a capability. `image_url`
  // can also hold whatever string a client sent to `audiobook:subscribe`, and
  // minting a token for that is exactly the "token from a path that came in
  // over IPC" that `media-route.ts` names as its own precondition: the middle
  // arm of `isServableMediaPath()` is a bare extension test with no
  // containment, so the mint site is the containment.
  const root = path.resolve(getAudiobooksRoot());
  const resolved = path.resolve(p);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return encodePathToUrl(p);
}

function rowToSub(r: SubRow): AudiobookSubscription {
  return {
    id: r.id,
    librivoxId: r.librivox_id,
    title: r.title,
    author: r.author,
    description: r.description,
    imageUrl: r.image_url
      ? (path.isAbsolute(r.image_url) ? localPathToMediaUrl(r.image_url) : r.image_url)
      : null,
    rssUrl: r.rss_url,
    language: r.language,
    numSections: r.num_sections,
    totalSeconds: r.total_seconds,
    lastRefreshedAt: r.last_refreshed_at,
    createdAt: r.created_at,
  };
}

function rowToChapter(r: ChapterRow): AudiobookChapter {
  return {
    id: r.id,
    subscriptionId: r.subscription_id,
    guid: r.guid,
    chapterNumber: r.chapter_number,
    title: r.title,
    enclosureUrl: r.enclosure_url,
    durationSeconds: r.duration_seconds,
    fileSize: r.file_size,
    localPath: r.local_path,
    downloadState: r.download_state as AudiobookChapter["downloadState"],
    downloadError: r.download_error,
    createdAt: r.created_at,
  };
}

export function listSubscriptions(db: Database.Database): AudiobookSubscription[] {
  const rows = db
    .prepare("SELECT * FROM audiobook_subscriptions ORDER BY created_at DESC")
    .all() as SubRow[];
  return rows.map(rowToSub);
}

export async function subscribe(
  db: Database.Database,
  result: LibrivoxSearchResult,
  onCoverReady?: (sub: AudiobookSubscription) => void
): Promise<AudiobookSubscription> {
  // `result` is the request body; its TypeScript type is erased at runtime.
  // The id becomes a directory name (see assertLibrivoxId), and a cover the
  // caller supplies is always a remote URL -- never a path on this machine,
  // which `rowToSub` would otherwise turn into a media capability.
  const librivoxId = assertLibrivoxId(result.librivoxId);
  const clientImageUrl =
    typeof result.imageUrl === "string" && !path.isAbsolute(result.imageUrl)
      ? result.imageUrl
      : null;

  const existing = db
    .prepare("SELECT * FROM audiobook_subscriptions WHERE librivox_id = ?")
    .get(librivoxId) as SubRow | undefined;
  if (existing) return rowToSub(existing);

  const info = db
    .prepare(
      `INSERT INTO audiobook_subscriptions
         (librivox_id, title, author, description, image_url, rss_url, language, num_sections, total_seconds)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      librivoxId,
      result.title,
      result.author ?? null,
      result.description ?? null,
      clientImageUrl,
      result.rssUrl,
      result.language ?? null,
      result.numSections,
      result.totalSeconds
    );
  const subId = info.lastInsertRowid as number;

  // Fetch chapter list from the RSS feed and bulk-insert as pending
  try {
    const parsed = await fetchAndParseFeed(result.rssUrl);
    const insert = db.prepare(
      `INSERT OR IGNORE INTO audiobook_chapters
         (subscription_id, guid, chapter_number, title, enclosure_url, duration_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insertAll = db.transaction((chapters: typeof parsed.episodes) => {
      chapters.forEach((ep, idx) => {
        insert.run(
          subId,
          ep.guid || `${librivoxId}-${idx}`,
          idx + 1,
          ep.title,
          ep.enclosureUrl,
          ep.durationSeconds ?? null
        );
      });
    });
    insertAll(parsed.episodes);
  } catch (err) {
    console.warn("[audiobooks] failed to fetch chapters for", result.rssUrl, err);
  }

  // Fire-and-forget cover fetch — never blocks or fails the subscription.
  // Notify the caller once it lands so the UI can swap the placeholder for the
  // real cover without a manual refresh.
  void downloadCover(db, subId)
    .then((localPath) => {
      if (!localPath || !onCoverReady) return;
      const updated = db
        .prepare("SELECT * FROM audiobook_subscriptions WHERE id = ?")
        .get(subId) as SubRow | undefined;
      if (updated) onCoverReady(rowToSub(updated));
    })
    .catch(() => {});

  const row = db
    .prepare("SELECT * FROM audiobook_subscriptions WHERE id = ?")
    .get(subId) as SubRow;
  return rowToSub(row);
}

export function unsubscribe(db: Database.Database, subId: number): void {
  const sub = db
    .prepare("SELECT librivox_id FROM audiobook_subscriptions WHERE id = ?")
    .get(subId) as { librivox_id: number } | undefined;

  // Clean up local files
  if (sub) {
    // getChapterDir throws on a malformed id rather than resolving outside the
    // audiobooks root; a row that predates that validation must not take the
    // delete with it, so the row is still removed below.
    try {
      fs.rmSync(getChapterDir(sub.librivox_id), { recursive: true, force: true });
    } catch { /* ignore */ }
  }

  db.prepare("DELETE FROM audiobook_subscriptions WHERE id = ?").run(subId);
}

export function listChapters(db: Database.Database, subId: number): AudiobookChapter[] {
  const rows = db
    .prepare(
      "SELECT * FROM audiobook_chapters WHERE subscription_id = ? ORDER BY chapter_number ASC, id ASC"
    )
    .all(subId) as ChapterRow[];
  return rows.map(rowToChapter);
}

/** Returns label used for SyncPanel matching: "Title — Author" or just "Title". */
export function subLabel(sub: Pick<AudiobookSubscription, "title" | "author">): string {
  return sub.author ? `${sub.title} — ${sub.author}` : sub.title;
}
