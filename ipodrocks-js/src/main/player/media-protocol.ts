import * as fs from "fs";
import * as path from "path";
import { net, protocol } from "electron";
import { pathToFileURL } from "url";
import { getPlayerTempDir, isAudioFilePath } from "./player-source";

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
    const url = new URL(request.url);
    const encoded = url.pathname.slice(1); // strip leading /

    let filePath: string;
    try {
      filePath = Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const resolved = path.resolve(filePath);
    const tempDir = getPlayerTempDir();
    const sep = path.sep;

    const isInTempDir =
      resolved.startsWith(tempDir + sep) || resolved.startsWith(tempDir + "/");
    const isValidAudioFile = isAudioFilePath(resolved);

    if (!isInTempDir && !isValidAudioFile) {
      return new Response("Forbidden", { status: 403 });
    }

    if (!fs.existsSync(resolved)) {
      return new Response("Not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(resolved).toString());
  });
}
