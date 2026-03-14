import { useState, useRef, useEffect } from "react";
import {
  sendAssistantChat,
  getOpenRouterConfig,
  clearAssistantHistory,
} from "../../ipc/api";
import { MarkdownContent } from "../common/MarkdownContent";
import { ErrorBox } from "../common/ErrorBox";

const OPENING_MESSAGE =
  "How can I help with your music library? I know your tracks, playlists, and artists.";

export function FloatChat() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    getOpenRouterConfig().then((c) => setHasApiKey(!!c?.apiKey?.trim()));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function handleSend() {
    const text = inputValue.trim();
    if (!text || isLoading) return;

    setInputValue("");
    const userMsg = { role: "user" as const, content: text };
    const history = [...messagesRef.current, userMsg];
    messagesRef.current = history;
    setMessages(history);
    setIsLoading(true);
    setError(null);

    try {
      const result = await sendAssistantChat(text);

      if ("error" in result) {
        setError(result.error);
        return;
      }

      const replyContent =
        result.playlistCreated
          ? `**Playlist created: "${result.playlistCreated}"**\n\n${result.reply}`
          : result.reply;
      const next = [...messagesRef.current, { role: "assistant", content: replyContent }];
      messagesRef.current = next;
      setMessages(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }

  if (hasApiKey === false) return null;

  return (
    <>
      {/* Toggle button - always visible when collapsed */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:scale-95 transition-all flex items-center justify-center text-2xl"
        title={open ? "Close chat" : "Music Assistant"}
      >
        💬
      </button>

      {/* Chat panel - slides in from bottom-right */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 w-96 max-h-[480px] flex flex-col rounded-2xl border border-border bg-card shadow-2xl overflow-hidden"
          style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-lg">💬</span>
              <h3 className="text-sm font-semibold text-foreground">
                Music Assistant
              </h3>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={async () => {
                  await clearAssistantHistory();
                  setMessages([]);
                }}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
                title="Clear memory (hidden past context)"
              >
                🗑
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
                title="Minimize"
              >
                ▼
              </button>
            </div>
          </div>

          {/* Greeting */}
          <div className="px-4 py-2 border-b border-border">
            <p className="text-xs text-muted-foreground">
              Questions? I know your library, tracks, and playlists.
            </p>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[280px] p-4 space-y-3">
            {messages.length === 0 ? (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-xl px-3 py-2 bg-muted/50 text-sm text-foreground select-text">
                  {OPENING_MESSAGE}
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <div
                  key={i}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm select-text ${
                      m.role === "user"
                        ? "bg-muted text-foreground whitespace-pre-wrap"
                        : "bg-muted/50 text-foreground"
                    }`}
                  >
                    {m.role === "assistant" ? (
                      <MarkdownContent content={m.content} />
                    ) : (
                      <span className="whitespace-pre-wrap">{m.content}</span>
                    )}
                  </div>
                </div>
              ))
            )}
            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-xl px-3 py-2 bg-muted/50 text-sm text-muted-foreground">
                  <span className="animate-pulse">Thinking…</span>
                </div>
              </div>
            )}
            <div ref={scrollRef} />
          </div>

          {error && (
            <div className="px-4 py-2">
              <ErrorBox>{error}</ErrorBox>
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t border-border">
            <div className="flex gap-2">
              <input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Ask about your library…"
                disabled={isLoading}
                className="flex-1 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!inputValue.trim() || isLoading}
                className="rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 disabled:opacity-40 disabled:pointer-events-none"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
