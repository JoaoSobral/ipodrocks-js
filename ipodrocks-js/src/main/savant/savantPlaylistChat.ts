/**
 * Savant playlist chat — AI-guided conversation to collect mood, adventure
 * level, seed artist, and 1–2 creative questions for playlist generation.
 */

import Database from "better-sqlite3";
import {
  callOpenRouter,
  OpenRouterConfig,
  OpenRouterMessage,
} from "../llm/openRouterClient";
import { buildSavantChatContext } from "./moodChat";

export interface SavantPlaylistChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SavantExtractedIntent {
  mood: string;
  seedArtist?: string;
  adventureLevel: "conservative" | "mixed" | "adventurous";
}

export interface SavantPlaylistChatState {
  messages: SavantPlaylistChatMessage[];
  exchangeCount: number;
  isComplete: boolean;
  extractedIntent: SavantExtractedIntent | null;
}

export interface SavantPlaylistChatTurn {
  aiMessage: string;
  isComplete: boolean;
  intent?: SavantExtractedIntent;
}

const MAX_EXCHANGES = 8;

const SAVANT_PLAYLIST_SYSTEM_PROMPT = `You are a perceptive music curator helping someone build the perfect playlist.
Your job is to have a short, natural conversation to understand:
1. MOOD — What vibe or energy do they want? (context, emotional tone, energy level)
2. ADVENTURE LEVEL — How much discovery?
   - "conservative" = Stay close — only tracks they've played before
   - "mixed" = Mix surprises — played + some new discoveries
   - "adventurous" = Take me somewhere new — full library exploration
3. SEED ARTIST (optional) — Any artist to lean on or anchor the mix?
4. 1–2 CREATIVE questions — e.g. setting (road trip, dinner party), energy arc
   (build up vs steady), genre/era lean, time of day, etc.

RULES:
- Ask ONE question per message. Never two.
- Keep responses to 1–3 sentences. Be concise and direct.
- Use casual, warm language. You're a music friend.
- After 4–6 exchanges OR when you have enough signal, output the SAVANT_INTENT block.
- At exchange ${MAX_EXCHANGES}, you MUST output SAVANT_INTENT regardless.

When ready to close, output EXACTLY this format (no other text before or after):

SAVANT_INTENT:
mood: "<rich 2–4 sentence mood description — music brief, not about the user>"
seedArtist: "<artist name>" or null
adventureLevel: conservative|mixed|adventurous`;

function parseSavantIntent(content: string): SavantExtractedIntent | null {
  const block = content.match(/SAVANT_INTENT:\s*([\s\S]+?)(?:\n\n|$)/i);
  if (!block) return null;

  const text = block[1].trim();
  const moodMatch = text.match(/mood:\s*"([^"]+)"/i);
  const seedMatch = text.match(/seedArtist:\s*"([^"]+)"|seedArtist:\s*null/i);
  const advMatch = text.match(
    /adventureLevel:\s*(conservative|mixed|adventurous)/i
  );

  const mood = moodMatch?.[1]?.trim() ?? "Chill";
  const seedArtist = seedMatch?.[1]
    ? seedMatch[1].trim()
    : undefined;
  const adventureLevel = (advMatch?.[1]?.toLowerCase() ??
    "mixed") as SavantExtractedIntent["adventureLevel"];
  if (
    !["conservative", "mixed", "adventurous"].includes(adventureLevel)
  ) {
    return null;
  }

  return { mood, seedArtist, adventureLevel };
}

function buildSystemContent(
  db: Database.Database | null,
  forceClose: boolean
): string {
  let content = SAVANT_PLAYLIST_SYSTEM_PROMPT;
  if (db) {
    const ctx = buildSavantChatContext(db);
    content += `\n\n<context>\n${ctx}\n</context>\n\nUse this context to tailor your questions. Reference their artists, genres, or listening habits when relevant.`;
  }
  if (forceClose) {
    content += `\n\nNOTE: This is exchange ${MAX_EXCHANGES}. You MUST output the SAVANT_INTENT block now.`;
  }
  return content;
}

/**
 * Process one user message and return the AI response.
 */
export async function processSavantPlaylistChatTurn(
  state: SavantPlaylistChatState,
  userMessage: string,
  openRouterConfig: OpenRouterConfig,
  db: Database.Database | null = null
): Promise<SavantPlaylistChatTurn> {
  state.messages.push({ role: "user", content: userMessage });
  state.exchangeCount++;

  const forceClose = state.exchangeCount >= MAX_EXCHANGES;
  const systemContent = buildSystemContent(db, forceClose);

  const llmMessages: OpenRouterMessage[] = [
    { role: "system", content: systemContent },
    ...state.messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  const raw = await callOpenRouter(llmMessages, openRouterConfig, false);
  state.messages.push({ role: "assistant", content: raw });

  const intent = parseSavantIntent(raw);
  if (intent) {
    state.isComplete = true;
    state.extractedIntent = intent;
    return { aiMessage: raw, isComplete: true, intent };
  }

  return { aiMessage: raw, isComplete: false };
}

/**
 * Start the Savant playlist chat — AI asks the opening question.
 */
export async function startSavantPlaylistChat(
  openRouterConfig: OpenRouterConfig,
  db: Database.Database | null = null
): Promise<{ state: SavantPlaylistChatState; aiMessage: string }> {
  const state: SavantPlaylistChatState = {
    messages: [],
    exchangeCount: 0,
    isComplete: false,
    extractedIntent: null,
  };

  const openingInstruction =
    "\n\nThe user just opened the playlist chat. Ask your opening question " +
    "about mood or vibe. Nothing else.";
  let systemContent = SAVANT_PLAYLIST_SYSTEM_PROMPT + openingInstruction;
  if (db) {
    const ctx = buildSavantChatContext(db);
    systemContent += `\n\n<context>\n${ctx}\n</context>\n\nUse this context to tailor your opening question.`;
  }

  const openingPrompt: OpenRouterMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: "__START__" },
  ];

  const raw = await callOpenRouter(openingPrompt, openRouterConfig, false);
  state.messages.push({ role: "assistant", content: raw });

  return { state, aiMessage: raw };
}
