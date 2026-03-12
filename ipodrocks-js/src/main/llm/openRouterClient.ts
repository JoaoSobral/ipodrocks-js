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

export async function callOpenRouter(
  messages: OpenRouterMessage[],
  config: OpenRouterConfig,
  jsonMode = false
): Promise<string> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
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

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`OpenRouter error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}
