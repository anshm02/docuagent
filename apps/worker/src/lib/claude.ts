import Anthropic from "@anthropic-ai/sdk";

const CLAUDE_MODEL = "claude-sonnet-4-6";

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY");
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

export async function claudeText(prompt: string, options?: {
  maxTokens?: number;
  temperature?: number;
  system?: string;
}): Promise<string> {
  const response = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0,
    ...(options?.system ? { system: options.system } : {}),
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }
  return textBlock.text;
}

export async function claudeVision(prompt: string, imageBase64: string, options?: {
  maxTokens?: number;
  temperature?: number;
  system?: string;
}): Promise<string> {
  const response = await getClient().messages.create({
    model: CLAUDE_MODEL,
    max_tokens: options?.maxTokens ?? 4096,
    temperature: options?.temperature ?? 0,
    ...(options?.system ? { system: options.system } : {}),
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: imageBase64 },
        },
        { type: "text", text: prompt },
      ],
    }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }
  return textBlock.text;
}

export function parseJsonResponse<T>(raw: string): T {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return JSON.parse(cleaned) as T;
}
