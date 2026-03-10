import { useState, useRef, useEffect } from "react";
import { sendAssistantChat, getOpenRouterConfig } from "../../ipc/api";

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
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);
    setError(null);

    try {
      const history = [...messages, userMsg];
      const result = await sendAssistantChat(history);

      if ("error" in result) {
        setError(result.error);
        return;
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: result.reply },
      ]);
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
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-[#4a9eff] text-white shadow-lg hover:bg-[#3a8eef] active:scale-95 transition-all flex items-center justify-center text-2xl"
        title={open ? "Close chat" : "Open chat"}
      >
        💬
      </button>

      {/* Chat panel - slides in from bottom-right */}
      {open && (
        <div
          className="fixed bottom-24 right-6 z-50 w-96 max-h-[480px] flex flex-col rounded-2xl border border-white/[0.12] bg-[#131626] shadow-2xl overflow-hidden [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0]"
          style={{ boxShadow: "0 8px 32px rgba(0,0,0,0.4)" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.08] [.theme-light_&]:border-[#e2e8f0]">
            <div className="flex items-center gap-2">
              <span className="text-lg">💬</span>
              <h3 className="text-sm font-semibold text-white [.theme-light_&]:text-[#1a1a1a]">
                Music Assistant
              </h3>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="p-1 rounded-lg text-[#5a5f68] hover:text-white hover:bg-white/5 [.theme-light_&]:hover:text-[#1a1a1a]"
              title="Minimize"
            >
              ▼
            </button>
          </div>

          {/* Greeting */}
          <div className="px-4 py-2 border-b border-white/[0.06] [.theme-light_&]:border-[#e2e8f0]">
            <p className="text-xs text-[#8a8f98] [.theme-light_&]:text-[#6b7280]">
              Questions? I know your library, tracks, and playlists.
            </p>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto min-h-[200px] max-h-[280px] p-4 space-y-3">
            {messages.length === 0 ? (
              <div className="flex justify-start">
                <div className="max-w-[85%] rounded-xl px-3 py-2 bg-white/[0.06] text-sm text-[#e0e0e0] [.theme-light_&]:bg-[#f3f4f6] [.theme-light_&]:text-[#374151]">
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
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap ${
                      m.role === "user"
                        ? "bg-[#4a9eff]/20 text-white"
                        : "bg-white/[0.06] text-[#e0e0e0] [.theme-light_&]:bg-[#f3f4f6] [.theme-light_&]:text-[#374151]"
                    }`}
                  >
                    {m.content}
                  </div>
                </div>
              ))
            )}
            {isLoading && (
              <div className="flex justify-start">
                <div className="rounded-xl px-3 py-2 bg-white/[0.06] text-sm text-[#5a5f68]">
                  <span className="animate-pulse">Thinking…</span>
                </div>
              </div>
            )}
            <div ref={scrollRef} />
          </div>

          {error && (
            <div className="px-4 py-2 text-xs text-[#ef4444] bg-[#ef4444]/10">
              {error}
            </div>
          )}

          {/* Input */}
          <div className="p-3 border-t border-white/[0.08] [.theme-light_&]:border-[#e2e8f0]">
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
                className="flex-1 rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-[#e0e0e0] placeholder:text-[#5a5f68] outline-none focus:border-[#4a9eff]/50 disabled:opacity-50 [.theme-light_&]:bg-white [.theme-light_&]:border-[#e2e8f0] [.theme-light_&]:text-[#1a1a1a]"
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!inputValue.trim() || isLoading}
                className="rounded-lg bg-[#4a9eff] text-white px-4 py-2 text-sm font-medium hover:bg-[#3a8eef] disabled:opacity-40 disabled:pointer-events-none"
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
