/**
 * Escape LIKE special chars (% _ \) so folder paths are safe in LIKE patterns.
 * Callers must pair this with an explicit `ESCAPE '\'` clause.
 */
export function escapeLike(s: string): string {
  return s.replace(/[%_\\]/g, (c) => "\\" + c);
}
