import { useEffect, useRef, useState, type JSX } from "react";
import { clearDevLog, getDevLogStatus, readDevLog, type DevLogEntry } from "../../ipc/api";

/** Keeps the panel from growing without bound while it is left open. */
const MAX_LINES = 3000;
const POLL_MS = 1000;

function formatLine(e: DevLogEntry): string {
  return `${new Date(e.at).toLocaleTimeString()} [${e.scope}] ${e.message}`;
}

/**
 * The developer log, in the app.
 *
 * Exists so a client of a remote server can see what the *server* decided —
 * what it found on the device, why each track counts as synced or to-sync,
 * which device requests failed — without a shell on that machine. Renders
 * nothing unless the server runs with `IPODROCKS_DEV_LOGS=1` and the caller is
 * its owner (`app:devLog:status` answers both). It polls only while open.
 */
export function DevConsole(): JSX.Element | null {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DevLogEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getDevLogStatus().then((on) => {
      if (!cancelled) setAvailable(on);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const page = await readDevLog(lastSeq.current);
        if (cancelled) return;
        if ("error" in page) {
          setError(page.error);
          return;
        }
        setError(null);
        // The ring was cleared or the server restarted: start over.
        if (page.lastSeq < lastSeq.current) {
          lastSeq.current = 0;
          setEntries([]);
          return;
        }
        if (page.entries.length > 0) {
          lastSeq.current = page.entries[page.entries.length - 1].seq;
          setEntries((prev) => {
            const next = prev.concat(page.entries);
            return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
          });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, open]);

  if (!available) return null;

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? entries.filter((e) => formatLine(e).toLowerCase().includes(needle))
    : entries;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="dev-console-toggle"
        className="fixed left-4 bottom-24 z-40 rounded-lg border border-border bg-card/90 px-3 py-1.5 text-xs font-mono text-muted-foreground shadow-lg hover:text-foreground cursor-default"
        title="Developer log (IPODROCKS_DEV_LOGS is on)"
      >
        dev log
      </button>
    );
  }

  return (
    <div
      data-testid="dev-console"
      className="fixed inset-x-4 bottom-4 z-40 flex h-72 flex-col rounded-xl border border-border bg-card shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span className="font-mono font-medium text-foreground">Developer log</span>
        <span className="text-muted-foreground">{shown.length} line(s)</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter"
          aria-label="Filter developer log"
          className="ml-auto w-48 rounded-md border border-border bg-background px-2 py-1 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => void navigator.clipboard?.writeText(shown.map(formatLine).join("\n"))}
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground cursor-default"
        >
          Copy
        </button>
        <button
          type="button"
          onClick={() => {
            void clearDevLog().then(() => {
              lastSeq.current = 0;
              setEntries([]);
            });
          }}
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground cursor-default"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close developer log"
          className="rounded-md px-2 py-1 text-muted-foreground hover:bg-accent/50 hover:text-foreground cursor-default"
        >
          ✕
        </button>
      </div>
      <div
        ref={scroller}
        className="flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground"
      >
        {error && <div className="text-destructive">{error}</div>}
        {shown.length === 0 && !error && (
          <div className="text-muted-foreground">
            Nothing yet. Run a device check or a sync and the server's diagnostics appear here.
          </div>
        )}
        {shown.map((e) => (
          <div key={e.seq} data-testid="dev-console-line" className="whitespace-pre-wrap break-all">
            {formatLine(e)}
          </div>
        ))}
      </div>
    </div>
  );
}
