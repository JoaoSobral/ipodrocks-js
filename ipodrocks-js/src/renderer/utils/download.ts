/**
 * Save text the renderer built as a file. A Blob and an `<a download>` work the
 * same in the Electron window and in a browser, so exports never need a native
 * save dialog (which a web client may not have — see `blockWebClientDialog`).
 */
export function downloadTextFile(filename: string, mime: string, text: string): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** RFC 4180 quoting: every cell quoted, embedded quotes doubled. */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows
    .map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(","))
    .join("\n");
}
