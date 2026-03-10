import * as fs from "fs";
import * as path from "path";

function getSyncErrorLogPath(): string {
  return path.join(process.cwd(), "sync_error.log");
}

export function appendSyncError(
  srcPath: string,
  destPath: string | null,
  errorMessage: string,
  conversionLogLines?: string[]
): void {
  const logPath = getSyncErrorLogPath();
  const ts = new Date().toISOString();
  const lines: string[] = [
    "",
    `[${ts}] SYNC ERROR`,
    `  source:      ${srcPath}`,
    `  destination: ${destPath ?? "(unknown)"}`,
    `  error:       ${errorMessage}`,
  ];
  if (conversionLogLines?.length) {
    lines.push("  conversion log:");
    for (const line of conversionLogLines) {
      lines.push(`    ${line.trimEnd()}`);
    }
  }
  lines.push("");

  try {
    fs.appendFileSync(logPath, lines.join("\n"), "utf-8");
  } catch {
    // silently ignore write failures
  }
}
