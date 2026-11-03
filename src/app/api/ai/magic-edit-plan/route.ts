import { NextRequest, NextResponse } from "next/server";
import { createTextCompletion } from "@/lib/ai/openrouter";
import { SUPPORTED_CAPABILITIES } from "@/lib/video/capabilities";
import { EditingPlanSchema, type EditingIntensity } from "@/types/editing-plan";
import { z } from "zod";

export const runtime = "nodejs";

const RequestSchema = z.object({
  scriptLines: z.array(z.string().trim().min(1).max(2_000)).min(1).max(2_000),
  transcript: z.array(z.unknown()).max(100_000),
  duration: z.number().finite().positive().max(86_400),
  intensity: z.enum(["subtle", "professional", "dynamic"]),
  aiModel: z.enum(["groq", "openrouter"]),
  currentPlan: z.unknown().optional(),
  userMessage: z.string().trim().min(1).max(2_000).optional(),
}).strict();

const ZoomDetailsSchema = z.object({
  effect: z.enum(["zoom_in", "zoom_out", "punch_in"]),
  scale: z.number().finite().min(1).max(2),
}).strict();

const BrollDetailsSchema = z.object({
  layout: z.enum(["full", "split", "pip"]),
  searchQuery: z.string().trim().min(1).max(200),
  assetType: z.enum(["png", "image"]),
}).strict();

const SfxDetailsSchema = z.object({
  searchQuery: z.string().trim().min(1).max(200),
  volume: z.number().finite().min(0).max(100),
}).strict();

const MusicDetailsSchema = z.object({
  mood: z.string().trim().min(1).max(100),
  searchQuery: z.string().trim().min(1).max(200),
  volume: z.number().finite().min(0).max(100),
}).strict();

class PlanValidationError extends Error {
  constructor(readonly details: unknown) {
    super("AI returned an invalid editing plan.");
    this.name = "PlanValidationError";
  }
}

const SYSTEM_PROMPT = (intensity: EditingIntensity, duration: number) => `ROLE: You are an advanced AI Video Editing Director and Professional Film Editor.
TASK: Analyze the transcript and generate a professional editing plan.
INTENSITY PROFILE: ${intensity} (Subtle = minimal, Professional = balanced, Dynamic = aggressive).
CAPABILITIES: You can ONLY use these features: A-Roll Zooms (V1), B-Roll PNG/Images/PIP (V2), Background Music (A2), SFX (A1).
RULES:
- Do NOT generate text or captions.
- The video duration is ${duration} seconds. All timestamps MUST be within 0 to ${duration}.
- Choose B-Roll search queries that match the spoken context.
- Output ONLY a valid JSON object matching the UniversalEditingPlan schema.
Schema:
{
  "project": { "duration": ${duration}, "aspect_ratio": "9:16", "video_profile": "short_form", "intensity": "${intensity}" },
  "timeline_operations": [
    { "id": "1", "type": "zoom", "start_time": 0, "end_time": 2, "track": "v1", "details": { "effect": "punch_in", "scale": 1.15 } },
    { "id": "2", "type": "broll", "start_time": 2, "end_time": 5, "track": "v2", "details": { "layout": "pip", "searchQuery": "tired mother", "assetType": "png" } },
    { "id": "3", "type": "sfx", "start_time": 2, "end_time": 2.5, "track": "a1", "details": { "searchQuery": "whoosh", "volume": 50 } },
    { "id": "4", "type": "music", "start_time": 0, "end_time": ${duration}, "track": "a2", "details": { "mood": "emotional", "searchQuery": "soft piano", "volume": 20 } }
  ]
}`;

function validateCapabilities(plan: z.infer<typeof EditingPlanSchema>, duration: number, intensity: EditingIntensity) {
  const issues: Array<{ path: Array<string | number>; message: string }> = [];
  if (plan.project.duration !== duration) {
    issues.push({ path: ["project", "duration"], message: "Project duration must match the source video duration." });
  }
  if (plan.project.intensity !== intensity) {
    issues.push({ path: ["project", "intensity"], message: "Project intensity must match the requested intensity." });
  }

  plan.timeline_operations.forEach((operation, index) => {
    const addIssue = (path: string, message: string) => {
      issues.push({ path: ["timeline_operations", index, path], message });
    };

    switch (operation.type) {
      case "zoom": {
        if (operation.track !== "v1") addIssue("track", "Zoom operations must use track v1.");
        const details = ZoomDetailsSchema.safeParse(operation.details);
        if (!details.success) {
          details.error.issues.forEach((issue) => issues.push({
            path: ["timeline_operations", index, "details", ...issue.path],
            message: issue.message,
          }));
        } else if (!SUPPORTED_CAPABILITIES.aRoll.includes(details.data.effect)) {
          addIssue("details.effect", "This zoom effect is not supported.");
        }
        break;
      }
      case "broll": {
        if (operation.track !== "v2") addIssue("track", "B-roll operations must use track v2.");
        const details = BrollDetailsSchema.safeParse(operation.details);
        if (!details.success) {
          details.error.issues.forEach((issue) => issues.push({
            path: ["timeline_operations", index, "details", ...issue.path],
            message: issue.message,
          }));
        } else {
          const overlayCapability = details.data.assetType === "png" ? "png_overlay" : "image_overlay";
          if (!SUPPORTED_CAPABILITIES.bRoll.includes(overlayCapability)) {
            addIssue("details.assetType", "This B-roll asset type is not supported.");
          }
          const layoutCapability = details.data.layout === "pip" ? "pip_layout"
            : details.data.layout === "split" ? "split_layout" : null;
          if (layoutCapability && !SUPPORTED_CAPABILITIES.bRoll.includes(layoutCapability)) {
            addIssue("details.layout", "This B-roll layout is not supported.");
          }
        }
        break;
      }
      case "sfx": {
        if (operation.track !== "a1") addIssue("track", "SFX operations must use track a1.");
        const details = SfxDetailsSchema.safeParse(operation.details);
        if (!details.success) {
          details.error.issues.forEach((issue) => issues.push({
            path: ["timeline_operations", index, "details", ...issue.path],
            message: issue.message,
          }));
        } else if (!SUPPORTED_CAPABILITIES.audio.includes("sfx_short")) {
          addIssue("type", "Short sound effects are not supported.");
        }
        break;
      }
      case "music": {
        if (operation.track !== "a2") addIssue("track", "Music operations must use track a2.");
        const details = MusicDetailsSchema.safeParse(operation.details);
        if (!details.success) {
          details.error.issues.forEach((issue) => issues.push({
            path: ["timeline_operations", index, "details", ...issue.path],
            message: issue.message,
          }));
        } else if (!SUPPORTED_CAPABILITIES.audio.includes("background_music")) {
          addIssue("type", "Background music is not supported.");
        }
        break;
      }
      case "text":
      case "transition":
        addIssue("type", "Text and transition operations are not supported by this AI plan.");
        break;
    }
  });

  return issues;
}

function parsePlan(response: string, duration: number, intensity: EditingIntensity) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    throw new PlanValidationError([{ path: [], message: "Response was not valid JSON." }]);
  }

  const result = EditingPlanSchema.safeParse(parsed);
  if (!result.success) throw new PlanValidationError(result.error.issues);

  const capabilityIssues = validateCapabilities(result.data, duration, intensity);
  if (capabilityIssues.length > 0) throw new PlanValidationError(capabilityIssues);
  return result.data;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const parsedRequest = RequestSchema.safeParse(body);
  if (!parsedRequest.success) {
    return NextResponse.json({
      error: "Provide script lines, transcript data, a valid duration, intensity, and AI model.",
      details: parsedRequest.error.issues,
    }, { status: 400 });
  }

  const { scriptLines, transcript, duration, intensity, aiModel, currentPlan, userMessage } = parsedRequest.data;
  const userContext = {
    scriptLines,
    transcript,
    duration,
    ...(currentPlan ? { currentPlan } : {}),
    ...(userMessage ? { userMessage } : {}),
  };
  try {
    const content = await createTextCompletion([
      { role: "system", content: SYSTEM_PROMPT(intensity, duration) },
      { role: "user", content: JSON.stringify(userContext) },
    ], { temperature: 0.2, json: true, preferredProvider: aiModel }, (response) => {
      parsePlan(response, duration, intensity);
    });
    return NextResponse.json(parsePlan(content, duration, intensity));
  } catch (error: unknown) {
    if (error instanceof PlanValidationError) {
      return NextResponse.json({ error: error.message, details: error.details }, { status: 400 });
    }
    console.error("Magic Edit plan generation failed:", error);
    const message = error instanceof Error ? error.message : "AI returned no usable Magic Edit plan.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
