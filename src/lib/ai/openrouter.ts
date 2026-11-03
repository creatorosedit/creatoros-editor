import Groq from "groq-sdk";
import OpenAI from "openai";

export const openrouter = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY || "OPENROUTER_API_KEY_NOT_CONFIGURED",
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": process.env.NEXT_PUBLIC_APP_URL || "https://creatoros-edit.vercel.app",
    "X-Title": "CreatorOS Edit",
  },
});

export const OPENROUTER_MODEL = "zhipu/glm-4.5-air";
const GROQ_FALLBACK_MODEL = "openai/gpt-oss-120b";

type CompletionOptions = {
  temperature: number;
  json?: boolean;
  preferredProvider?: "groq" | "openrouter";
};

type TextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export async function createTextCompletion(
  messages: TextMessage[],
  options: CompletionOptions,
  validate?: (content: string) => void,
): Promise<string> {
  const providers = options.preferredProvider
    ? [options.preferredProvider, options.preferredProvider === "groq" ? "openrouter" : "groq"] as const
    : ["openrouter", "groq"] as const;
  let lastError: unknown = null;

  for (const provider of providers) {
    try {
      let content: string | null | undefined;
      if (provider === "openrouter") {
        if (!process.env.OPENROUTER_API_KEY) {
          throw new Error("OPENROUTER_API_KEY is not configured.");
        }
        const completion = await openrouter.chat.completions.create({
          model: OPENROUTER_MODEL,
          messages,
          temperature: options.temperature,
          ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
        });
        content = completion.choices[0]?.message?.content;
      } else {
        if (!process.env.GROQ_API_KEY_EDIT) {
          throw new Error("GROQ_API_KEY_EDIT is not configured.");
        }
        const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_EDIT });
        const completion = await groq.chat.completions.create({
          model: GROQ_FALLBACK_MODEL,
          messages,
          temperature: options.temperature,
          max_tokens: 4096,
          ...(options.json ? { response_format: { type: "json_object" as const } } : {}),
        });
        content = completion.choices[0]?.message?.content;
      }

      if (!content?.trim()) throw new Error(`${provider} returned an empty response.`);
      validate?.(content);
      console.info(`[AI] Using ${provider === "openrouter" ? "OpenRouter" : "Groq"}: ${provider === "openrouter" ? OPENROUTER_MODEL : GROQ_FALLBACK_MODEL}.`);
      return content;
    } catch (error: unknown) {
      lastError = error;
      const nextProvider = providers[providers.indexOf(provider) + 1];
      if (nextProvider) {
        console.warn(`[AI] ${provider} request failed; trying ${nextProvider} fallback.`, error);
      }
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new Error("Neither OpenRouter nor Groq could generate a response.");
}
