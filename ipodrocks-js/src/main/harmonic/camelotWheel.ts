/**
 * Camelot Wheel mapping for harmonic mixing.
 * Maps musical keys (TKEY ID3 tag) to Camelot wheel positions.
 * Compatible keys allow smooth DJ-style transitions.
 */

const KEY_TO_CAMELOT: Record<string, string> = {
  // Major keys (B position on Camelot wheel)
  B: "1B",
  Gb: "2B",
  "F#": "2B",
  Db: "3B",
  "C#": "3B",
  Ab: "4B",
  "G#": "4B",
  Eb: "5B",
  "D#": "5B",
  Bb: "6B",
  "A#": "6B",
  F: "7B",
  C: "8B",
  G: "9B",
  D: "10B",
  A: "11B",
  E: "12B",
  // Minor keys (A position on Camelot wheel)
  Abm: "1A",
  "G#m": "1A",
  Ebm: "2A",
  "D#m": "2A",
  Bbm: "3A",
  "A#m": "3A",
  Fm: "4A",
  Cm: "5A",
  Gm: "6A",
  Dm: "7A",
  Am: "8A",
  Em: "9A",
  Bm: "10A",
  "F#m": "11A",
  Gbm: "11A",
  "C#m": "12A",
  Dbm: "12A",
};

/**
 * Returns all Camelot keys harmonically compatible with a given key.
 * Compatible = same number ±1, or same number with opposite letter (A↔B).
 */
export function getCompatibleKeys(camelot: string): string[] {
  const num = parseInt(camelot.slice(0, -1), 10);
  const letter = camelot.slice(-1) as "A" | "B";
  const prev = num === 1 ? 12 : num - 1;
  const next = num === 12 ? 1 : num + 1;
  const opposite = letter === "A" ? "B" : "A";
  return [
    `${num}${letter}`,
    `${prev}${letter}`,
    `${next}${letter}`,
    `${num}${opposite}`,
  ];
}

/**
 * Normalize raw TKEY tag value to a consistent key string.
 * Handles "A minor" → "Am", "A major" → "A" style tags.
 */
export function normalizeKey(raw: string | undefined | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = raw
    .trim()
    .replace(/\s+minor$/i, "m")
    .replace(/\s+major$/i, "")
    .replace(/\s/g, "");
  return KEY_TO_CAMELOT[cleaned] ? cleaned : null;
}

/**
 * Map a normalized key string to its Camelot wheel code.
 */
export function toCamelot(key: string | null): string | null {
  if (!key) return null;
  return KEY_TO_CAMELOT[key] ?? null;
}
