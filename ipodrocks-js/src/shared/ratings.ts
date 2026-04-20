/** Convert Rockbox 0–10 rating to 0–5 star display value (half-star granularity). */
export function rocksToStars(r: number | null): number | null {
  return r == null ? null : r / 2;
}

/** Convert 0–5 star value (accepts 0.5 increments) to Rockbox 0–10 integer. */
export function starsToRocks(s: number | null): number | null {
  if (s == null) return null;
  const v = Math.round(s * 2);
  if (v < 0 || v > 10) throw new RangeError(`invalid stars value: ${s}`);
  return v;
}
