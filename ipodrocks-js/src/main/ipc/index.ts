import { getLibraryDb } from "./common";
import { registerAppHandlers } from "./app";
import { registerLibraryHandlers, resumeInterruptedShadowBuilds } from "./library";
import { registerGeniusHandlers } from "./genius";
import { registerDeviceHandlers } from "./devices";
import { registerSyncHandlers } from "./sync";
import { registerPlaylistHandlers } from "./playlists";
import { registerSavantHandlers, startSavantSessionCleanup } from "./savant";
import { registerAssistantHandlers } from "./assistant";
import { registerSettingsHandlers } from "./settings";
import { registerRatingsHandlers } from "./ratings";
import { registerPlayerHandlers } from "./player";
import { registerPodcastHandlers } from "./podcasts";
import { registerAudiobookHandlers } from "./audiobooks";

export { getLibraryDb, resumeInterruptedShadowBuilds };

/**
 * Registers every IPC handler, grouped by channel prefix into per-domain
 * modules under `src/main/ipc/`. Each `registerXHandlers()` owns its own
 * channels (and any domain-local state such as abort controllers); shared
 * singletons and helpers live in `./common`.
 */
export function registerIpcHandlers(): void {
  startSavantSessionCleanup();

  registerAppHandlers();
  registerGeniusHandlers();
  registerLibraryHandlers();
  registerDeviceHandlers();
  registerSyncHandlers();
  registerPlaylistHandlers();
  registerSavantHandlers();
  registerAssistantHandlers();
  registerSettingsHandlers();
  registerRatingsHandlers();
  registerPlayerHandlers();
  registerPodcastHandlers();
  registerAudiobookHandlers();
}
