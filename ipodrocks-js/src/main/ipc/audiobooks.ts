import { ipcMain } from "electron";
import { safe, getLibrary } from "./common";
import { searchAudiobooks } from "../audiobooks/librivox-client";
import {
  listSubscriptions as listAudiobookSubs,
  subscribe as audiobookSubscribeFn,
  unsubscribe as audiobookUnsubscribeFn,
  listChapters,
} from "../audiobooks/audiobook-subscriptions";
import {
  downloadCover as downloadAudiobookCover,
  downloadCoverFromUrl as downloadAudiobookCoverFromUrl,
} from "../audiobooks/audiobook-cover";
import { searchCoverCandidates } from "../audiobooks/cover-client";
import { logActivity } from "../activity/activity-logger";
import { invalidateAssistantCache } from "../assistant/assistantChat";
import type { LibrivoxSearchResult } from "../../shared/types";

export function registerAudiobookHandlers(): void {
  ipcMain.handle(
    "audiobook:search",
    safe("audiobook:search", async (_event, term: string) => {
      return searchAudiobooks(term);
    })
  );

  ipcMain.handle(
    "audiobook:listSubs",
    safe("audiobook:listSubs", async () => {
      const db = getLibrary().getConnection();
      return listAudiobookSubs(db);
    })
  );

  ipcMain.handle(
    "audiobook:subscribe",
    safe("audiobook:subscribe", async (event, result: LibrivoxSearchResult) => {
      const db = getLibrary().getConnection();
      const sub = await audiobookSubscribeFn(db, result, (updated) => {
        // Cover finished downloading after we returned — push it to the renderer.
        if (!event.sender.isDestroyed()) event.sender.send("audiobook:coverUpdated", updated);
      });
      invalidateAssistantCache();
      logActivity(db, "audiobook_subscribed", `Added audiobook: ${result.title}`);
      return sub;
    })
  );

  ipcMain.handle(
    "audiobook:unsubscribe",
    safe("audiobook:unsubscribe", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      audiobookUnsubscribeFn(db, subId);
      invalidateAssistantCache();
      return undefined;
    })
  );

  ipcMain.handle(
    "audiobook:listChapters",
    safe("audiobook:listChapters", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      return listChapters(db, subId);
    })
  );

  ipcMain.handle(
    "audiobook:refreshCover",
    safe("audiobook:refreshCover", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      await downloadAudiobookCover(db, subId);
      return listAudiobookSubs(db).find((s) => s.id === subId) ?? null;
    })
  );

  ipcMain.handle(
    "audiobook:searchCoverCandidates",
    safe("audiobook:searchCoverCandidates", async (_event, subId: number) => {
      const db = getLibrary().getConnection();
      const sub = listAudiobookSubs(db).find((s) => s.id === subId);
      if (!sub) return [];
      return searchCoverCandidates(sub.title, sub.author);
    })
  );

  ipcMain.handle(
    "audiobook:setCoverFromUrl",
    safe("audiobook:setCoverFromUrl", async (_event, subId: number, url: string) => {
      const db = getLibrary().getConnection();
      const localPath = await downloadAudiobookCoverFromUrl(db, subId, url);
      if (!localPath) return null;
      return listAudiobookSubs(db).find((s) => s.id === subId) ?? null;
    })
  );
}
