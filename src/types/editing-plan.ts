import { z } from "zod";

export type EditingIntensity = "subtle" | "professional" | "dynamic";

export interface ARollOperation {
  id: string;
  start_time: number;
  end_time: number;
  track: "v1";
  effect: "zoom_in" | "zoom_out" | "punch_in" | "punch_out";
  from_scale: number;
  to_scale: number;
  easing?: "linear" | "ease" | "bezier";
}

export interface BRollOperation {
  id: string;
  start_time: number;
  end_time: number;
  track: "v2";
  asset_type: "png" | "photo" | "illustration" | "stock_video";
  search_query: string;
  position?: { x: number; y: number };
  scale?: number;
  opacity?: number;
  animation?:
    | "zoom_in"
    | "zoom_out"
    | "slide_in"
    | "slide_out"
    | "pop_up"
    | "fade"
    | "pan_left"
    | "pan_right"
    | "parallax"
    | "none";
}

export interface PngOverlayOperation {
  id: string;
  start_time: number;
  end_time: number;
  track: "v2";
  asset_reference?: string;
  search_query: string;
  position: { x: number; y: number };
  scale?: number;
  opacity?: number;
  animation?: string;
}

export interface MotionGraphicOperation {
  id: string;
  start_time: number;
  end_time: number;
  track: "v2";
  graphic_type:
    | "arrow"
    | "highlight"
    | "circle"
    | "underline"
    | "callout"
    | "counter"
    | "label"
    | "icon";
  text?: string;
  position: { x: number; y: number };
  animation?: string;
}

export interface AudioOperation {
  id: string;
  start_time: number;
  end_time: number;
  track: "a1" | "a2";
  audio_type: "music" | "sfx";
  search_query: string;
  volume: number;
  fade_in?: number;
  fade_out?: number;
  ducking?: boolean;
}

export interface SoundEffectOperation {
  id: string;
  start_time: number;
  end_time: number;
  track: "a1";
  sfx_keyword: string;
  search_query: string;
  volume: number;
}

export interface TransitionOperation {
  id: string;
  at_time: number;
  from_clip_id?: string;
  to_clip_id?: string;
  transition_type:
    | "fade"
    | "slide"
    | "zoom"
    | "whip"
    | "cross_dissolve"
    | "none";
  duration: number;
}

export interface ColorGradingOperation {
  id: string;
  start_time: number;
  end_time: number;
  lut_name?: string;
  lut_intensity?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  temperature?: number;
}

export interface AssetRequirement {
  id: string;
  operation_id: string;
  asset_type: string;
  description: string;
  status: "required" | "available" | "searched";
}

export interface QualityCheck {
  check: string;
  passed: boolean;
  severity: "warning" | "error" | "info";
  message?: string;
}

export interface UniversalEditingPlan {
  project: {
    duration: number;
    aspect_ratio: string;
    video_profile: "short_form" | "long_form";
    intensity: EditingIntensity;
  };
  timeline_operations: Array<{
    id: string;
    type: "zoom" | "broll" | "sfx" | "music" | "text" | "transition";
    start_time: number;
    end_time: number;
    track: "v1" | "v2" | "a1" | "a2" | "t1";
    details: Record<string, unknown>;
  }>;
  global_settings?: {
    color_style?: string;
    music_style?: string;
    visual_density?: "low" | "medium" | "high";
    dialogue_priority?: "low" | "normal" | "maximum";
  };
  a_roll_operations?: ARollOperation[];
  b_roll_operations?: BRollOperation[];
  png_overlays?: PngOverlayOperation[];
  motion_graphics?: MotionGraphicOperation[];
  audio_operations?: AudioOperation[];
  sound_effects?: SoundEffectOperation[];
  transitions?: TransitionOperation[];
  color_grading?: ColorGradingOperation[];
  asset_requirements?: AssetRequirement[];
  quality_checks?: QualityCheck[];
}

// Legacy plans containing only project and timeline_operations remain valid.
const TimelineOperationSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(["zoom", "broll", "sfx", "music", "text", "transition"]),
  start_time: z.number().finite().nonnegative(),
  end_time: z.number().finite().positive(),
  track: z.enum(["v1", "v2", "a1", "a2", "t1"]),
  details: z.record(z.unknown()),
}).passthrough().refine((operation) => operation.end_time > operation.start_time, {
  message: "An operation must end after it starts.",
  path: ["end_time"],
});

export const EditingPlanSchema = z.object({
  project: z.object({
    duration: z.number().finite().positive(),
    aspect_ratio: z.string().trim().min(1),
    video_profile: z.enum(["short_form", "long_form"]),
    intensity: z.enum(["subtle", "professional", "dynamic"]),
  }).passthrough(),
  timeline_operations: z.array(TimelineOperationSchema),
  global_settings: z.object({
    color_style: z.string().optional(),
    music_style: z.string().optional(),
    visual_density: z.enum(["low", "medium", "high"]).optional(),
    dialogue_priority: z.enum(["low", "normal", "maximum"]).optional(),
  }).passthrough().optional(),
  a_roll_operations: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    track: z.literal("v1"),
    effect: z.enum(["zoom_in", "zoom_out", "punch_in", "punch_out"]),
    from_scale: z.number(),
    to_scale: z.number(),
    easing: z.enum(["linear", "ease", "bezier"]).optional(),
  }).passthrough()).optional(),
  b_roll_operations: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    track: z.literal("v2"),
    asset_type: z.enum(["png", "photo", "illustration", "stock_video"]),
    search_query: z.string(),
    position: z.object({ x: z.number(), y: z.number() }).passthrough().optional(),
    scale: z.number().optional(),
    opacity: z.number().optional(),
    animation: z.enum([
      "zoom_in",
      "zoom_out",
      "slide_in",
      "slide_out",
      "pop_up",
      "fade",
      "pan_left",
      "pan_right",
      "parallax",
      "none",
    ]).optional(),
  }).passthrough()).optional(),
  png_overlays: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    track: z.literal("v2"),
    asset_reference: z.string().optional(),
    search_query: z.string(),
    position: z.object({ x: z.number(), y: z.number() }).passthrough(),
    scale: z.number().optional(),
    opacity: z.number().optional(),
    animation: z.string().optional(),
  }).passthrough()).optional(),
  motion_graphics: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    track: z.literal("v2"),
    graphic_type: z.enum([
      "arrow",
      "highlight",
      "circle",
      "underline",
      "callout",
      "counter",
      "label",
      "icon",
    ]),
    text: z.string().optional(),
    position: z.object({ x: z.number(), y: z.number() }).passthrough(),
    animation: z.string().optional(),
  }).passthrough()).optional(),
  audio_operations: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    track: z.enum(["a1", "a2"]),
    audio_type: z.enum(["music", "sfx"]),
    search_query: z.string(),
    volume: z.number(),
    fade_in: z.number().optional(),
    fade_out: z.number().optional(),
    ducking: z.boolean().optional(),
  }).passthrough()).optional(),
  sound_effects: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    track: z.literal("a1"),
    sfx_keyword: z.string(),
    search_query: z.string(),
    volume: z.number(),
  }).passthrough()).optional(),
  transitions: z.array(z.object({
    id: z.string(),
    at_time: z.number(),
    from_clip_id: z.string().optional(),
    to_clip_id: z.string().optional(),
    transition_type: z.enum([
      "fade",
      "slide",
      "zoom",
      "whip",
      "cross_dissolve",
      "none",
    ]),
    duration: z.number(),
  }).passthrough()).optional(),
  color_grading: z.array(z.object({
    id: z.string(),
    start_time: z.number(),
    end_time: z.number(),
    lut_name: z.string().optional(),
    lut_intensity: z.number().optional(),
    brightness: z.number().optional(),
    contrast: z.number().optional(),
    saturation: z.number().optional(),
    temperature: z.number().optional(),
  }).passthrough()).optional(),
  asset_requirements: z.array(z.object({
    id: z.string(),
    operation_id: z.string(),
    asset_type: z.string(),
    description: z.string(),
    status: z.enum(["required", "available", "searched"]),
  }).passthrough()).optional(),
  quality_checks: z.array(z.object({
    check: z.string(),
    passed: z.boolean(),
    severity: z.enum(["warning", "error", "info"]),
    message: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough().superRefine((plan, context) => {
  const ids = new Set<string>();

  plan.timeline_operations.forEach((operation, index) => {
    if (ids.has(operation.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeline_operations", index, "id"],
        message: "Operation IDs must be unique.",
      });
    }
    ids.add(operation.id);

    if (operation.end_time > plan.project.duration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeline_operations", index, "end_time"],
        message: "An operation cannot end after the project duration.",
      });
    }
  });
});
