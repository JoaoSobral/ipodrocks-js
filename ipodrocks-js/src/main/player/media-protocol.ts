import * as path from "path";
import { net, protocol } from "electron";
import { pathToFileURL } from "url";
import { decodeUrlToPath, getPlayerTempDir, isAudioFilePath } from "./player-source";
import { getAudiobooksRoot } from "../audiobooks/audiobook-storage";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

function isAudiobookCoverPath(resolvedPath: string): boolean {
  const root = getAudiobooksRoot();
  const ext = path.extname(resolvedPath).toLowerCase();
  return (
    IMAGE_EXTS.has(ext) &&
    (resolvedPath.startsWith(root + path.sep) || resolvedPath.startsWith(root + "/"))
  );
}

/** Call before app.whenReady() to register the media:// scheme as privileged. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "media",
      privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

/** Call inside app.whenReady() to attach the media:// request handler. */
export function registerMediaProtocol(): void {
  protocol.handle("media", (request) => {
    let filePath: string;
    try {
      filePath = decodeUrlToPath(request.url);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const resolved = path.resolve(filePath);
    const tempDir = getPlayerTempDir();
    const sep = path.sep;

    const isInTempDir =
      resolved.startsWith(tempDir + sep) || resolved.startsWith(tempDir + "/");
    const isValidAudioFile = isAudioFilePath(resolved);

    if (!isInTempDir && !isValidAudioFile && !isAudiobookCoverPath(resolved)) {
      return new Response("Forbidden", { status: 403 });
    }

    return net.fetch(pathToFileURL(resolved).toString());
  });
}
