import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import { Modal } from "../common/Modal";
import { Button } from "../common/Button";
import { setUpdateSnooze, openExternal, fetchChangelogSection } from "../../ipc/api";

interface UpdateAvailableModalProps {
  open: boolean;
  onClose: () => void;
  current: string;
  latest: string;
  htmlUrl: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

type ChangelogState =
  | { status: "loading" }
  | { status: "ready"; markdown: string }
  | { status: "empty" };

export function UpdateAvailableModal({
  open,
  onClose,
  current,
  latest,
  htmlUrl,
}: UpdateAvailableModalProps) {
  const [snooze, setSnooze] = useState(false);
  const [changelog, setChangelog] = useState<ChangelogState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setChangelog({ status: "loading" });
    fetchChangelogSection(latest)
      .then((res) => {
        if (cancelled) return;
        if (res.markdown && res.markdown.trim().length > 0) {
          setChangelog({ status: "ready", markdown: res.markdown });
        } else {
          setChangelog({ status: "empty" });
        }
      })
      .catch(() => {
        if (!cancelled) setChangelog({ status: "empty" });
      });
    return () => {
      cancelled = true;
    };
  }, [latest]);

  const handleClose = async () => {
    if (snooze) await setUpdateSnooze(Date.now() + THIRTY_DAYS_MS);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Update available" closeOnBackdropClick wide>
      <div className="space-y-4">
        <p className="text-sm text-foreground">
          Version <strong>{latest}</strong> is available. You are running{" "}
          <strong>{current}</strong>.
        </p>

        {changelog.status === "loading" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <svg
              className="animate-spin h-3.5 w-3.5"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
            </svg>
            Loading release notes…
          </div>
        )}

        {changelog.status === "ready" && (
          <div>
            <p className="text-xs font-medium text-muted-foreground mb-1.5">
              What's New in v{latest}
            </p>
            <div className="max-h-[26rem] overflow-auto overscroll-contain rounded-md border border-border bg-muted/30 px-3 py-2 text-sm text-foreground break-words">
              <ReactMarkdown
                rehypePlugins={[rehypeSanitize]}
                components={{
                  h3: ({ children }) => (
                    <h3 className="text-sm font-semibold text-foreground mt-3 first:mt-0 mb-1">{children}</h3>
                  ),
                  h4: ({ children }) => (
                    <h4 className="text-xs font-semibold text-foreground mt-2 first:mt-0 mb-1">{children}</h4>
                  ),
                  p: ({ children }) => (
                    <p className="text-xs text-foreground leading-relaxed my-1.5 break-words">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="text-xs text-foreground list-disc pl-5 my-1.5 space-y-1">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="text-xs text-foreground list-decimal pl-5 my-1.5 space-y-1">{children}</ol>
                  ),
                  li: ({ children }) => <li className="leading-relaxed break-words">{children}</li>,
                  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
                  code: ({ children }) => (
                    <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono break-all">{children}</code>
                  ),
                  pre: ({ children }) => (
                    <pre className="my-2 overflow-x-auto rounded bg-muted/60 p-2 text-[11px] font-mono">{children}</pre>
                  ),
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline break-all"
                    >
                      {children}
                    </a>
                  ),
                }}
              >
                {changelog.markdown}
              </ReactMarkdown>
            </div>
          </div>
        )}

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={snooze}
            onChange={(e) => setSnooze(e.target.checked)}
            className="h-4 w-4 rounded border-border bg-muted/50 accent-primary"
          />
          <span className="text-sm text-muted-foreground">
            Don't check for updates for the next 30 days
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
          <Button variant="primary" onClick={() => openExternal(htmlUrl)}>
            Go to Releases
          </Button>
        </div>
      </div>
    </Modal>
  );
}
