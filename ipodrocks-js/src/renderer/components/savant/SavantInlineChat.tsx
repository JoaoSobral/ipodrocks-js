import { useState, useRef, useEffect, useCallback } from "react";
import {
  startSavantPlaylistChat,
  sendSavantPlaylistChatTurn,
  skipSavantPlaylistChat,
  getOpenRouterConfig,
  type SavantPlaylistIntent,
} from "../../ipc/api";
import { Button } from "../common/Button";
import { MarkdownContent } from "../common/MarkdownContent";
import { ErrorBox } from "../common/ErrorBox";

function stripSavantIntentBlock(content: string): string {
  return content.replace(/SAVANT_INTENT:\s*[\s\S]+$/i, "").trim();
}

export interface SavantInlineChatIntent extends SavantPlaylistIntent {
  chatHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

interface SavantInlineChatProps {
  onIntentReady: (intent: SavantInlineChatIntent) => void;
  onIntentClear: () => void;
}

export function SavantInlineChat({
  onIntentReady,
  onIntentClear,
}: SavantInlineChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string }>
  >([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    getOpenRouterConfig().then((c) => setHasApiKey(!!c?.apiKey?.trim()));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  const handleStart = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await startSavantPlaylistChat();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSessionId(result.sessionId);
      setMessages([{ role: "assistant", content: result.aiMessage }]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleSend = useCallback(async () => {
    if (!sessionId || !inputValue.trim() || isLoading) return;
    const userMsg = inputValue.trim();
    setInputValue("");
    const withUser = [...messagesRef.current, { role: "user" as const, content: userMsg }];
    messagesRef.current = withUser;
    setMessages(withUser);
    setIsLoading(true);
    setError(null);
    try {
      const result = await sendSavantPlaylistChatTurn(sessionId, userMsg);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const displayContent =
        stripSavantIntentBlock(result.aiMessage) ||
        "Ready to create your playlist!";
      const withAssistant = [
        ...messagesRef.current,
        { role: "assistant" as const, content: displayContent },
      ];
      messagesRef.current = withAssistant;
      setMessages(withAssistant);
      if (result.isComplete && result.intent) {
        const base = messagesRef.current.slice(0, -1);
        const fullHistory = [
          ...base.map((m) => ({ role: m.role, content: m.content })),
          { role: "assistant" as const, content: result.aiMessage },
        ];
        onIntentReady({
          ...result.intent,
          chatHistory: fullHistory,
        });
        setSessionId(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, inputValue, isLoading, messages, onIntentReady]);

  const handleSkip = useCallback(() => {
    if (sessionId) skipSavantPlaylistChat(sessionId);
    setSessionId(null);
    setMessages([]);
    onIntentClear();
  }, [sessionId, onIntentClear]);

  if (hasApiKey === false) {
    return (
      <p className="text-xs text-muted-foreground">
        Add your OpenRouter API key in Settings to use the Savant chat.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!sessionId && messages.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <p className="text-sm text-muted-foreground">
            Chat with Savant to describe your mood, adventure level, seed artist,
            and more. I&apos;ll build the perfect playlist.
          </p>
          <Button
            variant="primary"
            size="sm"
            onClick={handleStart}
            disabled={isLoading}
          >
            {isLoading ? "Starting…" : "Start Chat"}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-y-auto min-h-[180px] max-h-[280px] p-3 rounded-lg border border-border bg-muted/30 space-y-3">
            {messages.map((m, i) => (
              <div
                key={i}
                className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm select-text ${
                    m.role === "user"
                      ? "bg-muted text-foreground"
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
            ))}
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
            <ErrorBox>{error}</ErrorBox>
          )}

          {sessionId && (
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
                placeholder="Type your answer…"
                disabled={isLoading}
                className="flex-1 rounded-lg bg-input border border-border px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground outline-none focus:border-primary/50 disabled:opacity-50"
              />
              <Button
                variant="primary"
                size="sm"
                onClick={handleSend}
                disabled={!inputValue.trim() || isLoading}
              >
                Send
              </Button>
            </div>
          )}

          {sessionId && (
            <button
              type="button"
              onClick={handleSkip}
              className="text-[10px] text-muted-foreground hover:text-foreground self-start"
            >
              Start over
            </button>
          )}
        </>
      )}
    </div>
  );
}
