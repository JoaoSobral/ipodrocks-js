/**
 * OpenRouter API client for Savant playlist LLM calls.
 * Uses OpenAI-compatible chat completions endpoint.
 */

import type { OpenRouterConfig } from "../../shared/types";

export type { OpenRouterConfig };

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ---------------------------------------------------------------------------
// F4: Per-channel rate limiter — max 10 calls per 60 seconds per channel
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_CALLS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateLimitMap = new Map<string, number[]>();

/**
 * Returns true if the call is allowed, false if rate limit exceeded.
 * Tracks call timestamps per channel within a sliding window.
 */
export function checkRateLimit(channel: string): boolean {
  const now = Date.now();
  const timestamps = rateLimitMap.get(channel) ?? [];
  // Remove timestamps outside the window
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX_CALLS) {
    rateLimitMap.set(channel, recent);
    return false;
  }
  recent.push(now);
  rateLimitMap.set(channel, recent);
  return true;
}

// ---------------------------------------------------------------------------
// F18: 30-second timeout on all OpenRouter requests
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

export async function callOpenRouter(
  messages: OpenRouterMessage[],
  config: OpenRouterConfig,
  jsonMode = false
): Promise<string> {
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl ?? "app://electron",
        "X-Title": config.siteName ?? "iPodRocks",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.7,
        max_tokens: 2000,
        ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      }),
    });
  } catch (err) {
    // Distinguish timeout from other network errors
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new Error(`OpenRouter request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw err;
  }

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}
