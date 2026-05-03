import { useState, useRef, useEffect } from "react";
import {
  sendAssistantChat,
  getOpenRouterConfig,
  clearAssistantHistory,
} from "../../ipc/api";
import { MarkdownContent } from "../common/MarkdownContent";
import { ErrorBox } from "../common/ErrorBox";

const OPENING_MESSAGE =
  "Hey! I'm Rocksy. How can I help? 😊 I know your library, understand iPodrocks, and can craft playlists in seconds.";

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

      const replyContent = result.playlistCreated
        ? `**Playlist created: "${result.playlistCreated}"**\n\n${result.reply}`
        : result.reply;
      const next = [
        ...messagesRef.current,
        { role: "assistant" as const, content: replyContent },
      ];
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
    <div
      className="shrink-0 border-l border-border bg-card flex flex-col overflow-hidden"
      style={{ width: open ? 320 : 36, transition: "width 300ms ease-in-out" }}
    >
      {!open ? (
        /* Collapsed tab strip */
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex flex-col items-center justify-start pt-8 gap-3 h-full w-full text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
          title="Ask Rocksy"
        >
          <span className="text-base">💬</span>
          <span
            className="text-[10px] font-medium tracking-widest uppercase text-muted-foreground"
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
          >
            Rocksy
          </span>
        </button>
      ) : (
        /* Expanded drawer */
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
            <div className="flex items-center gap-2">
              <span className="text-base">💬</span>
              <h3 className="text-sm font-semibold text-foreground">Rocksy</h3>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={async () => {
                  await clearAssistantHistory();
                  setMessages([]);
                }}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
                title="Clear conversation"
              >
                🗑
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="p-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50"
                title="Close"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Subtitle */}
          <div className="px-4 py-2 border-b border-border shrink-0">
            <p className="text-xs text-muted-foreground">
              Questions? I know iPodRocks inside out — docs, your library,
              tracks, and playlists.
            </p>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
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
                    className={`max-w-[85%] min-w-0 rounded-xl px-3 py-2 text-sm select-text [overflow-wrap:anywhere] ${
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
            <div className="px-4 py-2 shrink-0">
              <ErrorBox>{error}</ErrorBox>
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t border-border shrink-0">
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
    </div>
  );
}
