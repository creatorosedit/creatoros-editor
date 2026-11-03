import { z } from "zod";

export type EditingIntensity = "subtle" | "professional" | "dynamic";

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
}

const TimelineOperationSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(["zoom", "broll", "sfx", "music", "text", "transition"]),
  start_time: z.number().finite().nonnegative(),
  end_time: z.number().finite().positive(),
  track: z.enum(["v1", "v2", "a1", "a2", "t1"]),
  details: z.record(z.unknown()),
}).strict().refine((operation) => operation.end_time > operation.start_time, {
  message: "An operation must end after it starts.",
  path: ["end_time"],
});

export const EditingPlanSchema = z.object({
  project: z.object({
    duration: z.number().finite().positive(),
    aspect_ratio: z.string().trim().min(1),
    video_profile: z.enum(["short_form", "long_form"]),
    intensity: z.enum(["subtle", "professional", "dynamic"]),
  }).strict(),
  timeline_operations: z.array(TimelineOperationSchema),
}).strict().superRefine((plan, context) => {
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
