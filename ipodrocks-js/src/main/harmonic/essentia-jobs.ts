/**
 * Which library-wide Essentia job holds the analysis worker, if any.
 *
 * There is one worker (`essentia-analyzer.ts`), and both the harmonic backfill
 * and the lossless check terminate it to end a track that runs too long — so
 * two jobs sharing it would kill each other's tracks and record them as
 * failures. Each job claims this before it starts and refuses if it cannot.
 */
export type EssentiaJob = "harmonic analysis" | "lossless check";

let holder: EssentiaJob | null = null;

/** Claim the worker for `job`. Returns the job already holding it, or null on success. */
export function claimEssentiaJob(job: EssentiaJob): EssentiaJob | null {
  if (holder && holder !== job) return holder;
  holder = job;
  return null;
}

export function releaseEssentiaJob(job: EssentiaJob): void {
  if (holder === job) holder = null;
}

export function essentiaJobInProgress(): EssentiaJob | null {
  return holder;
}
