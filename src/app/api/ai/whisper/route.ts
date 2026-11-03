import { NextRequest, NextResponse } from "next/server";
import Groq from "groq-sdk";
import { z } from "zod";

export const runtime = "nodejs";

const TranscriptWordSchema = z.object({
  word: z.string(),
  start: z.number().finite().nonnegative(),
  end: z.number().finite().nonnegative(),
}).refine((word) => word.end >= word.start);

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const audio = formData.get("audio");
    if (!(audio instanceof File) || audio.size === 0) {
      return NextResponse.json({ error: "A non-empty audio file is required." }, { status: 400 });
    }
    if (audio.size > 25 * 1024 * 1024) {
      return NextResponse.json({ error: "Audio file exceeds the 25 MB limit." }, { status: 413 });
    }
    if (!process.env.GROQ_API_KEY_EDIT) {
      return NextResponse.json({ error: "GROQ_API_KEY_EDIT is not configured." }, { status: 500 });
    }

    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY_EDIT });
    const transcription = await groq.audio.transcriptions.create({
      file: audio,
      model: "whisper-large-v3",
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
    });
    const transcriptWordsResult = z.array(TranscriptWordSchema).safeParse(
      "words" in transcription ? transcription.words : undefined,
    );
    if (!transcriptWordsResult.success || transcriptWordsResult.data.length === 0) {
      throw new Error("Whisper did not return valid word-level timestamps.");
    }
    const transcriptText = "text" in transcription ? transcription.text : "";
    if (!transcriptText.trim()) throw new Error("Whisper returned an empty transcript.");

    return NextResponse.json({
      transcriptText,
      transcriptWords: transcriptWordsResult.data,
    });
  } catch (error: unknown) {
    console.error("Audio transcription failed:", error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
