import { NextRequest, NextResponse } from "next/server";
import { createTextCompletion } from "@/lib/ai/openrouter";
import { z } from "zod";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scriptLines: z.array(z.string().trim().min(1)).min(1).max(2_000),
  editedTranscript: z.array(z.object({
    text: z.string().trim().min(1).max(10_000),
    start: z.number().finite().nonnegative(),
    end: z.number().finite().positive(),
  }).refine((segment) => segment.end > segment.start)).min(1).max(100_000),
  videoFormat: z.string().trim().min(1).max(16).default("9:16"),
});

const BrollPlanItemSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  layout: z.enum(["full", "split", "pip"]),
  type: z.enum(["image", "png", "illustration", "3d_render"]),
  prompt: z.string().trim().min(1).max(2_000),
  aspectRatio: z.string().trim().min(1).max(16),
}).refine((item) => item.end > item.start);

const BrollPlanSchema = z.array(BrollPlanItemSchema).min(3).max(5);

const SYSTEM_PROMPT = (videoFormat: string) => `You are an elite viral video editor. Analyze the transcript and suggest 3-5 B-Rolls. Return only a JSON object with an "items" array. Each item must have numeric "start" and "end" fields, a "layout" field, a "type" field, an "aspectRatio" field, and a detailed "prompt" field. Do not include markdown or extra text.
LAYOUT: full, split, or pip.
TYPE: image, png, illustration, or 3d_render.
Use ${videoFormat} for the aspect ratio of full and split layouts, and 1:1 for pip.
Make prompts highly detailed with style keywords, and use illustration, png, or 3d_render for most suggestions.
Example: {"items":[{"start":0.5,"end":3,"layout":"pip","type":"3d_render","aspectRatio":"1:1","prompt":"A hyper-realistic 3D render of a tired mother holding a glowing phone, cinematic lighting"}]}`;

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const parsedRequest = RequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return NextResponse.json({ error: "Provide script lines and a valid edited transcript." }, { status: 400 });
  }
  const { scriptLines, editedTranscript, videoFormat } = parsedRequest.data;
  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT(videoFormat) },
    { role: "user" as const, content: JSON.stringify({ scriptLines, editedTranscript }) },
  ];

  try {
    const content = await createTextCompletion(messages, { temperature: 0.2, json: true }, (response) => {
      const parsed: unknown = JSON.parse(response);
      const items = typeof parsed === "object" && parsed !== null && "items" in parsed
        ? parsed.items
        : undefined;
      if (!Array.isArray(items) || !BrollPlanSchema.safeParse(items).success) {
        throw new Error("AI returned an invalid B-Roll plan.");
      }
    });
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || !("items" in parsed)) {
      throw new Error("AI returned an invalid B-Roll plan.");
    }
    const validatedPlan = BrollPlanSchema.safeParse(parsed.items);
    if (!validatedPlan.success) throw new Error("AI returned an invalid B-Roll plan.");
    return NextResponse.json(validatedPlan.data);
  } catch (error: unknown) {
    console.error("B-Roll plan generation failed:", error);
    const message = error instanceof Error ? error.message : "AI returned no usable B-Roll plan.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
