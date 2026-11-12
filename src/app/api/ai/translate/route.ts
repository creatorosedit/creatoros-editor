import { NextResponse } from "next/server";
import { z } from "zod";
import { authorizeTeamRequest, readJsonBody } from "@/lib/api/team-api-auth";
import { generateGeminiJson, parseGeminiJson } from "@/lib/ai/gemini";
import { freeQuotaResponse } from "@/lib/ai/provider-policy";

const RequestSchema = z.object({
  chunks: z.array(z.string().trim().min(1).max(4_000)).min(1).max(500),
  targetLang: z.enum(["hinglish", "english"]),
}).strict();

const TranslationResponseSchema = z.object({
  translated: z.array(z.string().trim().min(1).max(4_000)).min(1).max(500),
}).strict();

const GeminiTranslationSchema = {
  type: "OBJECT",
  properties: {
    translated: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["translated"],
} as const;

export async function POST(request: Request) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;
  const body = await readJsonBody(request, 2 * 1024 * 1024);
  if (!body.ok) return body.response;

  const parsed = RequestSchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide text chunks and a supported translation language." }, { status: 400 });
  }

  const { chunks, targetLang } = parsed.data;
  const systemPrompt = targetLang === "hinglish"
    ? 'Translate each input segment from Hindi to Hinglish (Hindi in Roman script). Return a JSON object with a "translated" array containing exactly one string per input segment. Do not merge or split segments.'
    : 'Translate each input segment from Hindi to clean English. Return a JSON object with a "translated" array containing exactly one string per input segment. Do not merge or split segments.';

  try {
    const responseText = await generateGeminiJson(
      JSON.stringify(chunks),
      systemPrompt,
      GeminiTranslationSchema,
      request.signal,
    );
    const result = parseGeminiJson(responseText, (value) => TranslationResponseSchema.parse(value));
    if (result.translated.length !== chunks.length) {
      return NextResponse.json({ error: "Translation response did not preserve the input segment count." }, { status: 502 });
    }
    return NextResponse.json({ translatedChunks: result.translated });
  } catch (error: unknown) {
    const quotaResponse = freeQuotaResponse(error);
    if (quotaResponse) return quotaResponse;
    console.error("Translation failed:", error);
    const message = error instanceof Error ? error.message : "Translation failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
