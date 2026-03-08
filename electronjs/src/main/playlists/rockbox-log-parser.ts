import fs from "fs";
import path from "path";

import { PlayEvent } from "../../shared/types";

/**
 * Parse a Rockbox playback.log file into structured play events.
 *
 * Log format per data line:
 *   ``<unix_timestamp>:<elapsed_ms>:<total_ms>:<file_path>``
 *
 * Comment lines starting with ``#`` are skipped.
 *
 * :param deviceMountPath: Root mount path of the device.
 * :returns: Array of parsed PlayEvent objects.
 * :raises Error: If the log file is missing or contains no parseable lines.
 */
export function parseRockboxPlaybackLog(
  deviceMountPath: string
): PlayEvent[] {
  const logPath = path.join(deviceMountPath, ".rockbox", "playback.log");

  if (!fs.existsSync(logPath)) {
    throw new Error(
      "Playback history not found on this device. " +
      "Make sure the device has been used with Rockbox " +
      "and the playback log is enabled."
    );
  }

  const raw = fs.readFileSync(logPath, "utf-8");
  const lines = raw.split(/\r?\n/);
  const events: PlayEvent[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const firstColon = trimmed.indexOf(":");
    if (firstColon < 0) continue;
    const secondColon = trimmed.indexOf(":", firstColon + 1);
    if (secondColon < 0) continue;
    const thirdColon = trimmed.indexOf(":", secondColon + 1);
    if (thirdColon < 0) continue;

    const timestamp = Number(trimmed.slice(0, firstColon));
    const elapsedMs = Number(trimmed.slice(firstColon + 1, secondColon));
    const totalMs = Number(trimmed.slice(secondColon + 1, thirdColon));
    const filePath = trimmed.slice(thirdColon + 1);

    if (isNaN(timestamp) || isNaN(elapsedMs) || isNaN(totalMs) || !filePath) {
      continue;
    }

    const completionRatio = totalMs > 0
      ? Math.min(Math.max(elapsedMs / totalMs, 0), 1)
      : 0;

    events.push({ timestamp, elapsedMs, totalMs, filePath, completionRatio });
  }

  if (events.length === 0) {
    throw new Error(
      "Playback log is empty. Start listening on your device first."
    );
  }

  return events;
}
