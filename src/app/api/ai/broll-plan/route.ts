import { NextRequest, NextResponse } from "next/server";
import { generateGeminiJson } from "@/lib/ai/gemini";
import { freeQuotaResponse } from "@/lib/ai/provider-policy";
import { authorizeTeamRequest, readJsonBody } from "@/lib/api/team-api-auth";
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
}).strict();

const BrollPlanItemSchema = z.object({
  start: z.number().finite().nonnegative(),
  end: z.number().finite().positive(),
  layout: z.enum(["full", "split", "pip"]),
  type: z.enum(["image", "png", "illustration", "3d_render"]),
  prompt: z.string().trim().min(1).max(2_000),
  aspectRatio: z.string().trim().min(1).max(16),
}).refine((item) => item.end > item.start);

const BrollPlanSchema = z.array(BrollPlanItemSchema).min(3).max(5);
const BrollPlanResponseSchema = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          start: { type: "NUMBER" },
          end: { type: "NUMBER" },
          layout: { type: "STRING", enum: ["full", "split", "pip"] },
          type: { type: "STRING", enum: ["image", "png", "illustration", "3d_render"] },
          prompt: { type: "STRING" },
          aspectRatio: { type: "STRING" },
        },
        required: ["start", "end", "layout", "type", "prompt", "aspectRatio"],
      },
    },
  },
  required: ["items"],
} as const;

const SYSTEM_PROMPT = (videoFormat: string) => `You are an elite viral video editor. Analyze the transcript and suggest 3-5 B-Rolls. Return only a JSON object with an "items" array. Each item must have numeric "start" and "end" fields, a "layout" field, a "type" field, an "aspectRatio" field, and a detailed "prompt" field. Do not include markdown or extra text.
LAYOUT: full, split, or pip.
TYPE: image, png, illustration, or 3d_render.
Use ${videoFormat} for the aspect ratio of full and split layouts, and 1:1 for pip.
Make prompts highly detailed with style keywords, and use illustration, png, or 3d_render for most suggestions.
Example: {"items":[{"start":0.5,"end":3,"layout":"pip","type":"3d_render","aspectRatio":"1:1","prompt":"A hyper-realistic 3D render of a tired mother holding a glowing phone, cinematic lighting"}]}`;

export async function POST(request: NextRequest) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;
  const body = await readJsonBody(request, 8 * 1024 * 1024);
  if (!body.ok) return body.response;

  const parsedRequest = RequestSchema.safeParse(body.body);
  if (!parsedRequest.success) {
    return NextResponse.json({ error: "Provide script lines and a valid edited transcript." }, { status: 400 });
  }
  const { scriptLines, editedTranscript, videoFormat } = parsedRequest.data;
  try {
    const content = await generateGeminiJson(
      JSON.stringify({ scriptLines, editedTranscript }),
      SYSTEM_PROMPT(videoFormat),
      BrollPlanResponseSchema,
      request.signal,
    );
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || !("items" in parsed)) {
      throw new Error("AI returned an invalid B-Roll plan.");
    }
    const validatedPlan = BrollPlanSchema.safeParse(parsed.items);
    if (!validatedPlan.success) throw new Error("AI returned an invalid B-Roll plan.");
    return NextResponse.json(validatedPlan.data);
  } catch (error: unknown) {
    const quotaResponse = freeQuotaResponse(error);
    if (quotaResponse) return quotaResponse;
    console.error("B-Roll plan generation failed:", error);
    const message = error instanceof Error ? error.message : "AI returned no usable B-Roll plan.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
