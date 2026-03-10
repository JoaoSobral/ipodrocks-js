/**
 * Mood discovery chat — AI-guided conversation to build a rich mood profile
 * for Savant playlist generation. Max 6 exchanges, then summary + confirm.
 */

import { callOpenRouter, OpenRouterConfig, OpenRouterMessage } from "../llm/openRouterClient";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface MoodChatState {
  messages: ChatMessage[];
  exchangeCount: number;
  isComplete: boolean;
  moodSummary: string | null;
  internalNotes: string;
}

export interface MoodChatTurn {
  aiMessage: string;
  isComplete: boolean;
  moodSummary: string | null;
}

const MOOD_CHAT_SYSTEM_PROMPT = `You are a perceptive music curator helping someone discover what they want to listen to.
Your job is to have a short, natural conversation to understand their mood and musical needs.

RULES:
- Ask ONE question per message. Never two.
- Keep responses to 1–3 sentences. Be concise and direct.
- Use casual, warm language. You're a music friend, not a therapist or assistant.
- You may reference artists, albums, or genres naturally when it helps (e.g. "that sounds like a late-night Radiohead kind of mood").
- After 3 exchanges OR when you have enough signal, issue a SUMMARY using this exact format:

SUMMARY: <a rich 2–4 sentence mood description that captures energy level, emotional tone,
texture preferences, and context — written as a music brief, not a sentence about the user>

After the SUMMARY, ask: "Does that capture it?"

If the user says yes or confirms, respond ONLY with: CONFIRMED

If the user says no or wants to adjust, ask one clarifying question and try again.

INTERNAL TRACKING (never reveal this to the user):
Track what you've learned so far:
- Context (where/what they're doing)
- Energy level (low/medium/high)
- Emotional tone (positive/negative/complex)
- Texture preference (vocal/instrumental, dense/spacious)
- Any artist/album anchors mentioned
- Contradictions detected

You have a max of 6 user messages total. At message 6, always issue a SUMMARY and close
regardless of whether confirmed, using: CONFIRMED (AUTO)`;

function extractSummaryFromMessage(content: string): string | null {
  const match = content.match(/SUMMARY:\s*([\s\S]+?)(?:\n\nDoes that|\n\n|$)/i);
  return match?.[1]?.trim() ?? null;
}

function findLastSummaryInMessages(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      const summary = extractSummaryFromMessage(messages[i].content);
      if (summary) return summary;
    }
  }
  return null;
}

/**
 * Process one user message and return the AI response.
 */
export async function processMoodChatTurn(
  state: MoodChatState,
  userMessage: string,
  openRouterConfig: OpenRouterConfig
): Promise<MoodChatTurn> {
  state.messages.push({ role: "user", content: userMessage });
  state.exchangeCount++;

  const forceClose = state.exchangeCount >= 6;

  const systemContent =
    MOOD_CHAT_SYSTEM_PROMPT +
    (forceClose
      ? "\n\nNOTE: This is message 6. You MUST issue a SUMMARY and close now."
      : "");

  const llmMessages: OpenRouterMessage[] = [
    { role: "system", content: systemContent },
    ...state.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const raw = await callOpenRouter(llmMessages, openRouterConfig, false);
  state.messages.push({ role: "assistant", content: raw });

  const isConfirmed =
    raw.trim() === "CONFIRMED" || raw.includes("CONFIRMED (AUTO)");
  const summaryMatch = raw.match(/SUMMARY:\s*([\s\S]+?)(?:\n\nDoes that|$)/i);

  if (isConfirmed) {
    const extractedSummary =
      findLastSummaryInMessages(state.messages) ?? "Unresolved mood";
    state.isComplete = true;
    state.moodSummary = extractedSummary;

    return {
      aiMessage: raw,
      isComplete: true,
      moodSummary: extractedSummary,
    };
  }

  return {
    aiMessage: raw,
    isComplete: false,
    moodSummary: summaryMatch?.[1]?.trim() ?? null,
  };
}

/**
 * Start the mood discovery chat — AI asks the opening question.
 */
export async function startMoodChat(
  openRouterConfig: OpenRouterConfig
): Promise<{ state: MoodChatState; aiMessage: string }> {
  const state: MoodChatState = {
    messages: [],
    exchangeCount: 0,
    isComplete: false,
    moodSummary: null,
    internalNotes: "",
  };

  const openingPrompt: OpenRouterMessage[] = [
    {
      role: "system",
      content:
        MOOD_CHAT_SYSTEM_PROMPT +
        "\n\nThe user just opened the mood discovery chat. Ask your opening anchor question now. Nothing else.",
    },
    { role: "user", content: "__START__" },
  ];

  const raw = await callOpenRouter(openingPrompt, openRouterConfig, false);
  state.messages.push({ role: "assistant", content: raw });

  return { state, aiMessage: raw };
}
