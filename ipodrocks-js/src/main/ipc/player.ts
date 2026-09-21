import { handle as bridgeHandle } from "../host/bridge";
import { safe, getLibraryDb } from "./common";
import { prepareTrack, cancelPrepare } from "../player/player-source";
import type { Track } from "../../shared/types";

/**
 * **The path played is the one in the database, never the one in the request.**
 *
 * The renderer sends the whole `Track` it is holding, which is convenient and
 * was harmless while the only client was a trusted Electron renderer on the
 * user's own machine. Over the web server it is a remote client, and
 * `track.path` reaches two sinks that will do as they are told:
 *
 * - `encodePathToUrl()` mints a signed `/api/media/:token` for it. The route
 *   re-checks with `isServableMediaPath()`, whose middle arm is an extension
 *   test with no containment — so *any* file on the server ending `.mp3`,
 *   `.flac`, `.m4a`… would have been readable, and its existence probeable,
 *   by anyone on the allowlist.
 * - `ffmpeg -i <path>` on the transcode branch, which an attacker selects for
 *   free with `forceTranscode: true`. ffmpeg resolves a top-level `-i` as a
 *   *URL*, with no protocol allowlist: `http:`, `tcp:`, `concat:` and friends
 *   all work, so that argument was server-side request forgery from the
 *   daemon's network position.
 *
 * Both close the same way: take the id, read `path` and `codec` off the row.
 * The rest of the `Track` the client sent is display data the player never
 * uses. This restores the invariant `media-route.ts` states as its own
 * precondition — "the token alone would be enough only for as long as nobody
 * ever mints one from a path that came in over IPC".
 */
interface PlayableRow {
  path: string;
  codec: string | null;
}

export function registerPlayerHandlers(): void {
  bridgeHandle(
    "player:prepare",
    safe("player:prepare", async (event, track: Track, forceTranscode?: boolean) => {
      const id = Number(track?.id);
      if (!Number.isInteger(id) || id <= 0) {
        return { error: "That track cannot be played: it has no library id." };
      }
      // `tracks.codec_id` is a foreign key; the player wants the name, which is
      // what `pickStrategy()` matches against NATIVE_CODECS. Same join
      // `LibraryCore.getTracks()` does, and the same 'Unknown Codec' fallback,
      // which simply routes an unrecognised file down the transcode branch.
      const row = getLibraryDb()
        .prepare(
          "SELECT t.path AS path, COALESCE(c.name, 'Unknown Codec') AS codec " +
            "FROM tracks t LEFT JOIN codecs c ON c.id = t.codec_id " +
            "WHERE t.id = ?"
        )
        .get(id) as PlayableRow | undefined;
      if (!row) {
        return { error: "That track is no longer in the library." };
      }

      // The session is what scopes the transcode and, over the web server, what
      // the returned media token is bound to. Absent over Electron IPC, where
      // there is one window and the default key covers it.
      return prepareTrack(
        { path: row.path, codec: row.codec ?? "" },
        forceTranscode ?? false,
        event.sessionId
      );
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
