import { AI_PROVIDER_POLICY, FreeQuotaExhaustedError } from "./provider-policy.ts";

export const GEMINI_AUTO_CUT_MODEL = AI_PROVIDER_POLICY.model;

type GeminiSchema = Record<string, unknown>;

export const GEMINI_MODEL = AI_PROVIDER_POLICY.model;

function isQuotaOrBillingError(status: number, message: string, apiStatus: string): boolean {
  return status === 402 ||
    status === 429 ||
    /quota|resource_exhausted|billing|payment|required billing|free tier/iu.test(`${apiStatus} ${message}`);
}

function getErrorDetails(value: unknown): { message: string; status: string } {
  if (typeof value !== "object" || value === null || !("error" in value) ||
      typeof value.error !== "object" || value.error === null) {
    return { message: "", status: "" };
  }
  const error = value.error;
  return {
    message: "message" in error && typeof error.message === "string" ? error.message : "",
    status: "status" in error && typeof error.status === "string" ? error.status : "",
  };
}

async function requestGemini(
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing.");
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted.", "AbortError");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(45_000),
      ]),
    },
  );

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    if (!response.ok) throw new Error(`Gemini API request failed (HTTP ${response.status}).`);
    throw new Error("Gemini returned an invalid response.");
  }

  if (!response.ok) {
    const details = getErrorDetails(result);
    if (isQuotaOrBillingError(response.status, details.message, details.status)) {
      throw new FreeQuotaExhaustedError();
    }
    throw new Error(
      `Gemini API request failed (HTTP ${response.status})${details.message ? `: ${details.message}` : "."}`,
    );
  }
  return result;
}

function getCandidateText(result: unknown): string {
  if (typeof result !== "object" || result === null || !("candidates" in result) || !Array.isArray(result.candidates)) {
    if (getErrorDetails(result).status === "RESOURCE_EXHAUSTED") throw new FreeQuotaExhaustedError();
    throw new Error("Gemini returned an invalid response.");
  }
  const candidate = result.candidates[0];
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    !("content" in candidate) ||
    typeof candidate.content !== "object" ||
    candidate.content === null ||
    !("parts" in candidate.content) ||
    !Array.isArray(candidate.content.parts)
  ) {
    throw new Error("Gemini returned no structured response.");
  }
  const text = candidate.content.parts
    .flatMap((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("")
    .trim();
  if (!text) throw new Error("Gemini returned an empty response.");
  return text;
}

export function parseGeminiJson<T>(
  content: string,
  validate: (value: unknown) => T,
): T {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error("Gemini returned invalid JSON.", {cause: error});
  }
  try {
    return validate(value);
  } catch (error: unknown) {
    throw new Error("Gemini returned data that failed schema validation.", {cause: error});
  }
}

export async function generateGeminiJson(
  prompt: string,
  systemInstruction: string,
  responseSchema: GeminiSchema,
  signal?: AbortSignal,
): Promise<string> {
  const result = await requestGemini({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema,
    },
  }, signal);
  return getCandidateText(result);
}

export async function generateGeminiText(
  prompt: string,
  systemInstruction: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await requestGemini({
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2 },
  }, signal);
  return getCandidateText(result);
}
