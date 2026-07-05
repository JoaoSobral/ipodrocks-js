import { ipcMain } from "electron";
import { safe } from "./common";
import { prepareTrack, cancelPrepare } from "../player/player-source";
import type { Track } from "../../shared/types";

export function registerPlayerHandlers(): void {
  ipcMain.handle(
    "player:prepare",
    safe("player:prepare", async (_event, track: Track, forceTranscode?: boolean) => {
      return prepareTrack(track, forceTranscode ?? false);
    })
  );
  ipcMain.handle(
    "player:cancel",
    safe("player:cancel", async () => {
      await cancelPrepare();
      return undefined;
    })
  );
}
