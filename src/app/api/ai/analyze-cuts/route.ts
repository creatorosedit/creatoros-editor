import { NextResponse } from "next/server";
import { generateGeminiJson, parseGeminiJson } from "@/lib/ai/gemini";
import { freeQuotaResponse } from "@/lib/ai/provider-policy";
import { resolveWordIndexRange, throwIfAborted } from "@/lib/video/auto-cut";
import { authorizeTeamRequest, readJsonBody } from "@/lib/api/team-api-auth";
import { z } from "zod";

export const runtime = "nodejs";

const TranscriptSegmentSchema = z.object({
  text: z.string().trim().min(1).max(500),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
}).refine((segment) => segment.end > segment.start);

const RequestSchema = z.object({
  script: z.string().trim().min(1).max(50_000),
  transcript: z.array(TranscriptSegmentSchema).min(1).max(100_000),
}).strict();

const GeminiCutsSchema = z.object({
  cuts: z.array(z.object({
    startSegmentIndex: z.number().int().nonnegative(),
    endSegmentIndex: z.number().int().nonnegative(),
    reason: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1),
  }).strict()).max(100),
}).strict();

const GeminiCutsResponseSchema = {
  type: "OBJECT",
  properties: {
    cuts: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          startSegmentIndex: { type: "INTEGER" },
          endSegmentIndex: { type: "INTEGER" },
          reason: { type: "STRING" },
          confidence: { type: "NUMBER" },
        },
        required: ["startSegmentIndex", "endSegmentIndex", "reason", "confidence"],
      },
    },
  },
  required: ["cuts"],
} as const;

const CHUNK_SIZE = 120;
const MAX_TRANSCRIPT_SEGMENTS = 720;

export async function POST(request: Request) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;
  const body = await readJsonBody(request, 8 * 1024 * 1024);
  if (!body.ok) return body.response;

  const parsed = RequestSchema.safeParse(body.body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide a script and timestamped transcript segments." }, { status: 400 });
  }

  const {script, transcript} = parsed.data;
  const transcriptDuration = transcript.reduce((latest, segment) => Math.max(latest, segment.end), 0);
  if (transcript.some((segment, index) =>
    index > 0 && segment.start < (transcript[index - 1]?.start ?? 0),
  )) {
    return NextResponse.json({error: "Transcript segments must be in timestamp order."}, {status: 400});
  }
  const wordsToReview = transcript.slice(0, MAX_TRANSCRIPT_SEGMENTS);
  const candidateCuts: Array<{start: number; end: number; reason: string}> = [];

  try {
    for (let chunkStart = 0; chunkStart < wordsToReview.length;) {
      throwIfAborted(request.signal);
      const chunkEnd = Math.min(wordsToReview.length, chunkStart + CHUNK_SIZE);
      const prompt = [
        "Compare this transcript excerpt with the original script. Find only clear fillers, false starts, inferior retakes, or repeated sentences.",
        "Understand Hindi, Hinglish, and English. Prefer no cut when uncertain.",
        "Return indexes into the supplied transcript segments, never timestamps. The server will resolve timestamps from those exact segments.",
        `Script:\n${script.slice(0, 6_000)}`,
        `Transcript segments:\n${JSON.stringify(wordsToReview.slice(chunkStart, chunkEnd).map((segment, offset) => ({
          index: chunkStart + offset,
          text: segment.text,
        })))}`,
      ].join("\n\n");
      const responseText = await generateGeminiJson(
        prompt,
        "You are a cautious multilingual video editor. Suggest reviewable cuts, not automatic deletions.",
        GeminiCutsResponseSchema,
        request.signal,
      );
      throwIfAborted(request.signal);
      const result = parseGeminiJson(
        responseText,
        (value) => GeminiCutsSchema.parse(value),
      );

      for (const cut of result.cuts) {
        if (
          cut.confidence < 0.65 ||
          cut.startSegmentIndex < chunkStart ||
          cut.endSegmentIndex < cut.startSegmentIndex ||
          cut.endSegmentIndex >= chunkEnd ||
          cut.endSegmentIndex - cut.startSegmentIndex > 60
        ) {
          continue;
        }
        const range = resolveWordIndexRange(
          transcript,
          cut.startSegmentIndex,
          cut.endSegmentIndex,
          transcriptDuration,
        );
        if (!range) continue;
        candidateCuts.push({...range, reason: cut.reason});
      }

      if (chunkEnd === wordsToReview.length) break;
      chunkStart = chunkEnd - 12;
    }

    const cuts: Array<{start: number; end: number; reason: string}> = [];
    for (const cut of candidateCuts.sort((first, second) => first.start - second.start)) {
      const previous = cuts[cuts.length - 1];
      if (previous && cut.start < previous.end) continue;
      cuts.push(cut);
    }
    return NextResponse.json({
      cuts,
      ...(wordsToReview.length < transcript.length
        ? {warning: `Gemini reviewed the first ${wordsToReview.length} transcript segments.`}
        : {}),
    });
  } catch (error: unknown) {
    if (request.signal.aborted) {
      return NextResponse.json({error: "Cut analysis was cancelled."}, {status: 499});
    }
    const quotaResponse = freeQuotaResponse(error);
    if (quotaResponse) return quotaResponse;
    console.error("Analyze cuts failed:", error);
    const message = error instanceof Error ? error.message : "Could not analyze cuts.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
