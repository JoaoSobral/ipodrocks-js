import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import {
  listServerDirectory,
  setFolderPickerFallback,
  type DirectoryListing,
} from "../../ipc/api";

/**
 * The folder picker for a host with no screen.
 *
 * Mounted once, unconditionally. It registers itself as `pickFolder()`'s
 * fallback and is only ever reached when the host reports that it has no
 * native dialogs — so under Electron this component exists and never opens.
 *
 * It browses the **server's** filesystem, which is where library folders
 * genuinely are. `app:listDirectory` is gated by the same `validateFolderPath()`
 * that gates `library:addFolder`, so anything shown here is something the user
 * could actually add; a picker that could reach further would be a filesystem
 * enumeration oracle and nothing more useful.
 */
export function ServerFolderPicker() {
  const [open, setOpen] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [manualPath, setManualPath] = useState("");
  const [loading, setLoading] = useState(false);

  // The promise `pickFolder()` is waiting on. Held in a ref because it is
  // resolved from event handlers that must not close over a stale render.
  const resolverRef = useRef<((path: string | null) => void) | null>(null);

  const browse = useCallback(async (path: string | null) => {
    setLoading(true);
    try {
      const next = await listServerDirectory(path);
      setListing(next);
      if (!next.error) setManualPath(next.path);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setFolderPickerFallback(() => {
      setOpen(true);
      void browse(null);
      return new Promise<string | null>((resolve) => {
        resolverRef.current = resolve;
      });
    });
    return () => setFolderPickerFallback(null);
  }, [browse]);

  function finish(result: string | null) {
    setOpen(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    // Always resolve. A picker that is dismissed without settling leaves the
    // caller awaiting forever, and the caller here is a button in a form.
    resolve?.(result);
  }

  return (
    <Modal
      open={open}
      onClose={() => finish(null)}
      title="Choose a folder on the server"
      width="max-w-xl"
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          These are folders on the machine running iPodRocks, not on this
          computer — that is where your library lives.
        </p>

        {listing && listing.roots.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {listing.roots.map((root) => (
              <Button
                key={root.path}
                size="sm"
                variant="ghost"
                onClick={() => void browse(root.path)}
              >
                {root.name}
              </Button>
            ))}
          </div>
        )}

        <div className="flex gap-2">
          <Input
            className="flex-1"
            value={manualPath}
            onChange={(e) => setManualPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void browse(manualPath);
            }}
            placeholder="/path/on/the/server"
          />
          <Button size="sm" onClick={() => void browse(manualPath)}>
            Go
          </Button>
        </div>

        {listing?.error && (
          <p className="text-xs text-destructive">{listing.error}</p>
        )}

        <div className="max-h-72 overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {listing?.parent && (
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-sm text-muted-foreground hover:bg-accent/50"
              onClick={() => void browse(listing.parent)}
            >
              ‹ Up one level
            </button>
          )}
          {listing?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="w-full text-left px-3 py-2 text-sm text-foreground hover:bg-accent/50"
              onClick={() => void browse(entry.path)}
            >
              {entry.name}
            </button>
          ))}
          {listing && !listing.error && listing.entries.length === 0 && (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No subfolders here. Choose this folder, or go up a level.
            </p>
          )}
          {loading && !listing && (
            <p className="px-3 py-3 text-xs text-muted-foreground">Loading…</p>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button variant="secondary" onClick={() => finish(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!listing || !!listing.error}
            onClick={() => finish(listing?.path ?? null)}
          >
            Choose this folder
          </Button>
        </div>
      </div>
    </Modal>
  );
}
