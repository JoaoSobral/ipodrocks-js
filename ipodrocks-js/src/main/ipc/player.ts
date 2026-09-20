import { handle as bridgeHandle } from "../host/bridge";
import { safe } from "./common";
import { prepareTrack, cancelPrepare } from "../player/player-source";
import type { Track } from "../../shared/types";

export function registerPlayerHandlers(): void {
  bridgeHandle(
    "player:prepare",
    safe("player:prepare", async (_event, track: Track, forceTranscode?: boolean) => {
      return prepareTrack(track, forceTranscode ?? false);
    })
  );
  bridgeHandle(
    "player:cancel",
    safe("player:cancel", async () => {
      await cancelPrepare();
      return undefined;
    })
  );
}
