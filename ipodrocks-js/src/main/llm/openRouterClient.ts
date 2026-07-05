/**
 * OpenRouter API client for Savant playlist LLM calls.
 * Uses OpenAI-compatible chat completions endpoint.
 */

import type { OpenRouterConfig } from "../../shared/types";

export type { OpenRouterConfig };

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ToolCallResponse =
  | { kind: "text"; content: string }
  | { kind: "tool_calls"; calls: ToolCall[] };

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
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/**
 * Shared POST to the OpenRouter chat-completions endpoint. Centralizes the
 * auth/identity headers, request timeout, and error/timeout translation so the
 * individual call variants only differ by request body and response shape.
 */
async function postChatCompletion(
  config: OpenRouterConfig,
  body: Record<string, unknown>
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl ?? "app://electron",
        "X-Title": config.siteName ?? "iPodRocks",
      },
      body: JSON.stringify({ model: config.model, ...body }),
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
  return response;
}

export async function callOpenRouter(
  messages: OpenRouterMessage[],
  config: OpenRouterConfig,
  jsonMode = false
): Promise<string> {
  const response = await postChatCompletion(config, {
    messages,
    temperature: 0.7,
    max_tokens: 2000,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function callOpenRouterWithTools(
  messages: OpenRouterMessage[],
  config: OpenRouterConfig,
  tools: ToolDefinition[]
): Promise<ToolCallResponse> {
  const response = await postChatCompletion(config, {
    messages,
    temperature: 0.7,
    max_tokens: 2000,
    tools,
    tool_choice: "auto",
  });

  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: ToolCall[];
      };
      finish_reason?: string;
    }>;
  };

  const choice = data.choices?.[0];
  const msg = choice?.message;
  if (choice?.finish_reason === "tool_calls" || (msg?.tool_calls?.length ?? 0) > 0) {
    return { kind: "tool_calls", calls: msg?.tool_calls ?? [] };
  }
  return { kind: "text", content: msg?.content ?? "" };
}
