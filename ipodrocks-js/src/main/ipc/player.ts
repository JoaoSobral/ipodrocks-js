import { handle as bridgeHandle } from "../host/bridge";
import { safe } from "./common";
import { prepareTrack, cancelPrepare } from "../player/player-source";
import type { Track } from "../../shared/types";

export function registerPlayerHandlers(): void {
  bridgeHandle(
    "player:prepare",
    safe("player:prepare", async (event, track: Track, forceTranscode?: boolean) => {
      // The session is what scopes the transcode and, over the web server, what
      // the returned media token is bound to. Absent over Electron IPC, where
      // there is one window and the default key covers it.
      return prepareTrack(track, forceTranscode ?? false, event.sessionId);
    })
  );
  bridgeHandle(
    "player:cancel",
    safe("player:cancel", async (event) => {
      await cancelPrepare(event.sessionId);
      return undefined;
    })
  );
}
