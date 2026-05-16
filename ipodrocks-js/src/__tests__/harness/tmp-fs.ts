/**
 * Tmp directory + audio fixture helpers for behavioral/regression tests.
 *
 * Audio fixtures are placeholder files. `music-metadata-mock` resolves the
 * metadata you declare here when `parseFile` is called against the path —
 * no real decoding ever happens.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { registerFixture, type FixtureMetadata } from "./music-metadata-mock";

export function createTmpDir(prefix = "ipr-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupTmp(dir: string | null | undefined): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export interface SeedAudioFileInput {
  /** Directory under which to write the file. */
  dir: string;
  /** Relative path under `dir` (may include subfolders). */
  relPath: string;
  /** Metadata that `parseFile` should resolve to for this file. */
  metadata: FixtureMetadata;
  /** Bytes to write to the placeholder file (default: 100 zero bytes). */
  contents?: Buffer;
}

/**
 * Writes a placeholder audio file and registers its metadata with the shared
 * music-metadata mock so subsequent `parseFile(path)` calls resolve correctly.
 */
export function seedAudioFile(input: SeedAudioFileInput): string {
  const fullPath = path.join(input.dir, input.relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, input.contents ?? Buffer.alloc(100));
  registerFixture(fullPath, input.metadata);
  return fullPath;
}

