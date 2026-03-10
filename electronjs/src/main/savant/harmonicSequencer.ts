/**
 * Harmonic sequencer for Savant playlists.
 * Reorders tracks using Camelot wheel compatibility for smooth key transitions.
 */

import { getCompatibleKeys } from "../harmonic/camelotWheel";

export interface SequencerTrack {
  id: number;
  camelot: string | null;
  bpm: number | null;
}

/**
 * Reorder tracks harmonically using greedy Camelot chain.
 * Tracks with key data are sequenced; unkeyed tracks are appended at the end.
 */
export function harmonicSequence(tracks: SequencerTrack[]): SequencerTrack[] {
  const keyed = tracks.filter((t) => t.camelot !== null && t.camelot !== "");
  const unkeyed = tracks.filter((t) => t.camelot === null || t.camelot === "");

  if (keyed.length === 0) return tracks;

  const sequenced: SequencerTrack[] = [];
  const remaining = [...keyed];

  const startIdx = remaining.findIndex((t) => t.camelot === "8A");
  const startAt = startIdx >= 0 ? startIdx : 0;
  sequenced.push(...remaining.splice(startAt, 1));

  while (remaining.length > 0) {
    const current = sequenced[sequenced.length - 1];
    const compatible = getCompatibleKeys(current.camelot!);

    let bestScore = -Infinity;
    let bestIdx = 0;

    remaining.forEach((track, idx) => {
      let score = 0;
      if (track.camelot && compatible.includes(track.camelot)) score += 10;
      if (track.camelot === current.camelot) score += 2;
      if (track.bpm != null && current.bpm != null) {
        const bpmDiff = Math.abs(track.bpm - current.bpm);
        score += Math.max(0, 5 - bpmDiff / 2);
      }
      if (score > bestScore) {
        bestScore = score;
        bestIdx = idx;
      }
    });

    sequenced.push(...remaining.splice(bestIdx, 1));
  }

  return [...sequenced, ...unkeyed];
}
