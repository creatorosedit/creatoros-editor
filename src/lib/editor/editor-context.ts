import { z } from "zod";

export interface VideoClip {
  id: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

const TimelineClipSchema = z.object({
  id: z.string().min(1).max(200),
  timelineStart: z.number().finite().nonnegative(),
  timelineEnd: z.number().finite().positive(),
  sourceStart: z.number().finite().nonnegative(),
  sourceEnd: z.number().finite().positive(),
  speed: z.number().finite().positive(),
}).strict().refine((clip) =>
  clip.timelineEnd > clip.timelineStart &&
  clip.sourceEnd > clip.sourceStart &&
  Math.abs(
    (clip.timelineEnd - clip.timelineStart) -
    (clip.sourceEnd - clip.sourceStart) / clip.speed,
  ) <= 0.05,
);

const EditorContextSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  projectId: z.string().min(1).max(200).nullable(),
  mediaId: z.string().min(1).max(200).nullable(),
  videoFilename: z.string().min(1).max(1024).nullable(),
  videoDuration: z.number().finite().positive().nullable(),
  mediaMetadata: z.object({
    duration: z.number().finite().positive().nullable(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    mimeType: z.string().max(256).nullable(),
  }).strict().nullable(),
  timelineClips: z.array(TimelineClipSchema).max(2_000),
  timelineDuration: z.number().finite().nonnegative(),
  selectedClipIds: z.array(z.string().min(1).max(200)).max(2_000),
  selectedRange: z.object({
    in: z.number().finite().nonnegative().nullable(),
    out: z.number().finite().nonnegative().nullable(),
  }).strict().nullable(),
  playheadPosition: z.number().finite().nonnegative(),
  originalScript: z.string().max(50_000).nullable(),
  synchronizationStatus: z.enum(["synchronized", "loading", "error"]),
}).strict().superRefine((context, issueContext) => {
  const clipIds = new Set<string>();
  let previousTimelineStart = -1;
  let lastTimelineEnd = 0;
  for (const [index, clip] of context.timelineClips.entries()) {
    if (clipIds.has(clip.id)) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timelineClips", index, "id"],
        message: "Timeline clip IDs must be unique.",
      });
    }
    if (clip.timelineStart < previousTimelineStart || clip.timelineStart < lastTimelineEnd - 0.001) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timelineClips", index, "timelineStart"],
        message: "Timeline clips must be ordered and cannot overlap.",
      });
    }
    clipIds.add(clip.id);
    previousTimelineStart = clip.timelineStart;
    lastTimelineEnd = clip.timelineEnd;
  }
  if (lastTimelineEnd > context.timelineDuration + 0.05) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["timelineDuration"],
      message: "Timeline duration must include every clip.",
    });
  }
  if (context.playheadPosition > context.timelineDuration + 0.05) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["playheadPosition"],
      message: "Playhead position must be within the timeline.",
    });
  }
  context.selectedClipIds.forEach((id, index) => {
    if (!clipIds.has(id)) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedClipIds", index],
        message: "Selected clip must exist on the timeline.",
      });
    }
  });
  if (context.selectedRange) {
    for (const [field, time] of Object.entries(context.selectedRange)) {
      if (time !== null && time > context.timelineDuration + 0.05) {
        issueContext.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["selectedRange", field],
          message: "Selected range timestamps must be within the timeline.",
        });
      }
    }
    const { in: rangeIn, out: rangeOut } = context.selectedRange;
    if (rangeIn !== null && rangeOut !== null && rangeOut <= rangeIn) {
      issueContext.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["selectedRange"],
        message: "Selected range out point must follow its in point.",
      });
    }
  }
  if (context.videoFilename && /^https?:\/\//iu.test(context.videoFilename)) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["videoFilename"],
      message: "Video filename must not be a media URL.",
    });
  }
  if (context.videoFilename === null && context.mediaMetadata !== null) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mediaMetadata"],
      message: "Media metadata requires an active video.",
    });
  }
  if (context.videoFilename === null && (context.timelineClips.length > 0 || context.timelineDuration > 0)) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["timelineClips"],
      message: "A timeline cannot contain video clips when no source video is active.",
    });
  }
  if (
    context.videoFilename !== null &&
    context.mediaMetadata?.duration !== null &&
    context.mediaMetadata?.duration !== undefined &&
    context.videoDuration !== context.mediaMetadata.duration
  ) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["videoDuration"],
      message: "Video duration must match the media metadata.",
    });
  }
});

export type EditorContext = z.infer<typeof EditorContextSchema>;

export interface EditorContextInput {
  projectId: string | null;
  mediaId?: string | null;
  sourceMedia: {
    filename: string;
    mimeType?: string | null;
    duration?: number | null;
    width?: number | null;
    height?: number | null;
  } | null;
  clips: readonly VideoClip[];
  timelineDuration: number;
  selectedClipId: string | null;
  selectedRange: { in: number | null; out: number | null } | null;
  playheadPosition: number;
  originalScript?: string | null;
  revision: number;
  synchronizationStatus: EditorContext["synchronizationStatus"];
}

function normalizeFilename(filename: string): string {
  const basename = Array.from(filename.split(/[\\/]/u).pop() ?? "")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .trim();
  return /^https?:\/\//iu.test(basename) ? "" : basename;
}

export function buildEditorContext(input: EditorContextInput): EditorContext {
  const filename = input.sourceMedia ? normalizeFilename(input.sourceMedia.filename) : null;
  const timelineClips = input.clips.map((clip) => ({
    id: clip.id,
    timelineStart: clip.start,
    timelineEnd: clip.end,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    speed: clip.speed,
  }));
  const selectedClipIds = input.selectedClipId &&
    timelineClips.some((clip) => clip.id === input.selectedClipId)
    ? [input.selectedClipId]
    : [];
  const selectedRange = input.selectedRange &&
    (input.selectedRange.in !== null || input.selectedRange.out !== null)
    ? { in: input.selectedRange.in, out: input.selectedRange.out }
    : null;
  const context = {
    version: 1 as const,
    revision: input.revision,
    projectId: input.projectId,
    mediaId: input.mediaId ?? null,
    videoFilename: filename || null,
    videoDuration: input.sourceMedia?.duration ?? null,
    mediaMetadata: filename
      ? {
          duration: input.sourceMedia?.duration ?? null,
          width: input.sourceMedia?.width ?? null,
          height: input.sourceMedia?.height ?? null,
          mimeType: input.sourceMedia?.mimeType ?? null,
        }
      : null,
    timelineClips,
    timelineDuration: input.timelineDuration,
    selectedClipIds,
    selectedRange,
    playheadPosition: input.playheadPosition,
    originalScript: input.originalScript ?? null,
    synchronizationStatus: input.synchronizationStatus,
  };
  return EditorContextSchema.parse(context);
}

export function validateEditorContext(value: unknown): EditorContext {
  return EditorContextSchema.parse(value);
}

export function formatEditorContextForPrompt(context: EditorContext): string {
  if (!context.videoFilename) {
    return `No active video is open. Project ID: ${context.projectId ?? "unavailable"}.`;
  }
  const selectedClip = context.timelineClips.find((clip) => context.selectedClipIds.includes(clip.id));
  const range = context.selectedRange &&
    (context.selectedRange.in !== null || context.selectedRange.out !== null)
    ? `Selected range: In ${context.selectedRange.in ?? "unset"}s, Out ${context.selectedRange.out ?? "unset"}s.`
    : "No timeline range is selected.";
  return [
    "Editor metadata only; the video content has not been uploaded or watched.",
    `Active project ID: ${JSON.stringify(context.projectId)}.`,
    `Active video filename: ${JSON.stringify(context.videoFilename)}; duration: ${context.videoDuration ?? "unknown"}s.`,
    `Active timeline: ${context.timelineClips.length} clips, ${context.timelineDuration}s total.`,
    `Timeline clip details (timeline seconds and source-media seconds): ${JSON.stringify(context.timelineClips)}.`,
    selectedClip
      ? `Selected clip: ${JSON.stringify(selectedClip.id)}, timeline ${selectedClip.timelineStart}-${selectedClip.timelineEnd}s, source ${selectedClip.sourceStart}-${selectedClip.sourceEnd}s, speed ${selectedClip.speed}x.`
      : "No clip is selected.",
    range,
    `Playhead: ${context.playheadPosition}s.`,
    ...(context.originalScript ? [`Original script: ${JSON.stringify(context.originalScript)}.`] : []),
    `Context revision: ${context.revision}; synchronization: ${context.synchronizationStatus}.`,
  ].join("\n");
}
