import { useState, useRef, useEffect } from "react";
import { Button } from "../common/Button";
import { Input } from "../common/Input";
import {
  startMoodChat,
  sendMoodChatTurn,
  skipMoodChat,
} from "../../ipc/api";

const MAX_EXCHANGES = 6;

function extractSummary(content: string): string | null {
  const match = content.match(/SUMMARY:\s*([\s\S]+?)(?:\n\nDoes that|\n\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

function extractContentWithoutSummary(content: string): string {
  const summary = extractSummary(content);
  if (summary) {
    const before = content.split(/SUMMARY:/i)[0]?.trim() ?? "";
    return before || content;
  }
  return content;
}

interface MoodChatProps {
  onConfirm: (moodSummary: string, chatHistory: Array<{ role: "user" | "assistant"; content: string }>) => void;
  onSkip: () => void;
  /** Called when chat expands (session started) or collapses (skip/confirm). */
  onExpandedChange?: (expanded: boolean) => void;
}

export function MoodChat({ onConfirm, onSkip, onExpandedChange }: MoodChatProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<
    Array<{ role: "user" | "assistant"; content: string; isSummary?: boolean }>
  >([]);
  const [exchangeCount, setExchangeCount] = useState(0);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingSummary, setPendingSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  async function handleStart() {
    setError(null);
    setIsLoading(true);
    try {
      const result = await startMoodChat();
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSessionId(result.sessionId);
      setMessages([{ role: "assistant", content: result.aiMessage }]);
      setExchangeCount(0);
      onExpandedChange?.(true);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSend() {
    if (!sessionId || !inputValue.trim() || isLoading) return;
    const userMsg = inputValue.trim();
    setInputValue("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setExchangeCount((c) => c + 1);
    setIsLoading(true);
    setError(null);
    try {
      const result = await sendMoodChatTurn(sessionId, userMsg);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      const summary = extractSummary(result.aiMessage);
      if (summary) {
        setPendingSummary(summary);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: result.aiMessage,
            isSummary: true,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: result.aiMessage },
        ]);
      }
      if (result.isComplete && result.moodSummary) {
        const fullHistory: Array<{ role: "user" | "assistant"; content: string }> = [
          ...messages.map((m) => ({ role: m.role, content: m.content })),
          { role: "user", content: userMsg },
          { role: "assistant", content: result.aiMessage },
        ];
        onExpandedChange?.(false);
        onConfirm(result.moodSummary, fullHistory);
      }
    } finally {
      setIsLoading(false);
    }
  }

  function handleConfirmSummary() {
    if (pendingSummary && sessionId) {
      const fullHistory = messages.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      skipMoodChat(sessionId);
      onExpandedChange?.(false);
      onConfirm(pendingSummary, fullHistory);
    }
  }

  function handleNotQuite() {
    setPendingSummary(null);
    setInputValue("");
  }

  function handleSkip() {
    if (sessionId) skipMoodChat(sessionId);
    onExpandedChange?.(false);
    onSkip();
  }

  if (sessionId === null) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={handleStart}
        disabled={isLoading}
        className="w-full"
      >
        {isLoading ? "Starting…" : "💬 Help me find my vibe"}
      </Button>
    );
  }

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#131626] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/[0.06]">
        <span className="text-xs font-medium text-[#8a8f98]">
          💬 Find your vibe
        </span>
        <div className="flex gap-1">
          {Array.from({ length: MAX_EXCHANGES }).map((_, i) => (
            <span
              key={i}
              className={`w-1.5 h-1.5 rounded-full ${
                i < exchangeCount
                  ? "bg-[#4a9eff]"
                  : "bg-white/[0.15]"
              }`}
            />
          ))}
        </div>
      </div>

      <div className="max-h-[220px] overflow-y-auto p-4 space-y-3">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-[#4a9eff]/20 text-white"
                  : m.isSummary
                    ? "bg-[#4a9eff]/10 border border-[#4a9eff]/30 text-white"
                    : "bg-white/[0.06] text-[#e0e0e0]"
              }`}
            >
              {m.isSummary ? (
                <>
                  <p className="text-[10px] font-semibold text-[#4a9eff] mb-1.5">
                    🎵 Here&apos;s what I&apos;m hearing:
                  </p>
                  <p className="text-xs whitespace-pre-wrap">
                    {extractSummary(m.content) ?? m.content}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleConfirmSummary}
                    >
                      ✓ That&apos;s it
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleNotQuite}
                    >
                      Not quite
                    </Button>
                  </div>
                </>
              ) : (
                <p className="whitespace-pre-wrap">
                  {m.role === "assistant"
                    ? extractContentWithoutSummary(m.content)
                    : m.content}
                </p>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-white/[0.06] rounded-lg px-3 py-2 text-sm text-[#5a5f68]">
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

      {!pendingSummary && exchangeCount < MAX_EXCHANGES && (
        <div className="p-3 border-t border-white/[0.06] flex gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type your answer…"
            className="flex-1"
          />
          <Button
            size="sm"
            variant="primary"
            disabled={!inputValue.trim() || isLoading}
            onClick={handleSend}
          >
            Send
          </Button>
        </div>
      )}

      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={handleSkip}
          className="text-[10px] text-[#5a5f68] hover:text-[#8a8f98]"
        >
          Skip — just pick mood
        </button>
      </div>
    </div>
  );
}
