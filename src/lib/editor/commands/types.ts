import { z } from "zod";

import {
  PROJECT_SCHEMA_VERSION,
  RationalSchema,
  type ProjectDocumentV1,
  type Rational,
} from "../project.ts";

const IdSchema = z.string().min(1).max(200);
const StyleValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
]);
const TransformSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scaleX: z.number().finite().positive(),
  scaleY: z.number().finite().positive(),
  rotationDegrees: z.number().finite(),
  opacity: z.number().finite().min(0).max(1),
}).strict();
const EffectSchema = z.object({
  id: IdSchema,
  kind: IdSchema,
  parameters: z.record(StyleValueSchema),
}).strict();
const ClipPropertiesSchema = z.object({
  transform: TransformSchema.optional(),
  volume: z.number().finite().nonnegative().optional(),
  effects: z.array(EffectSchema).optional(),
}).strict();
const KeyframeSchema = z.object({
  id: IdSchema,
  property: IdSchema,
  time: RationalSchema.refine((time) => time.numerator >= 0),
  value: StyleValueSchema,
  interpolation: z.enum(["linear", "hold", "bezier"]),
}).strict();
const MediaClipSchema = z.object({
  id: IdSchema,
  kind: z.literal("media"),
  assetId: IdSchema,
  timelineStart: RationalSchema.refine((time) => time.numerator >= 0),
  timelineEnd: RationalSchema.refine((time) => time.numerator > 0),
  sourceIn: RationalSchema.refine((time) => time.numerator >= 0),
  sourceOut: RationalSchema.refine((time) => time.numerator > 0),
  speed: RationalSchema.refine((speed) => speed.numerator > 0),
  timingStatus: z.enum(["consistent", "legacy-mismatch"]),
  properties: ClipPropertiesSchema,
  keyframes: z.array(KeyframeSchema),
}).strict();
const TextClipSchema = z.object({
  id: IdSchema,
  kind: z.enum(["text", "caption"]),
  timelineStart: RationalSchema.refine((time) => time.numerator >= 0),
  timelineEnd: RationalSchema.refine((time) => time.numerator > 0),
  content: z.string(),
  style: z.record(StyleValueSchema),
  keyframes: z.array(KeyframeSchema),
}).strict();
const TrackKindSchema = z.enum(["video", "audio", "text", "captions", "overlay"]);
const EmptyTrackSchema = z.object({
  id: IdSchema,
  kind: TrackKindSchema,
  name: z.string().max(200),
  order: z.number().int().safe().nonnegative(),
  locked: z.boolean(),
  muted: z.boolean(),
  hidden: z.boolean(),
  clips: z.array(z.never()).length(0),
}).strict();
const CaptionSplitSchema = z.object({
  leftText: z.string(),
  rightText: z.string(),
}).strict();
const TextUpdatesSchema = z.object({
  content: z.string().optional(),
  style: z.record(StyleValueSchema).optional(),
}).strict().refine((patch) =>
  patch.content !== undefined || patch.style !== undefined,
  "At least one text or style field must be provided.",
);
const MediaPropertyUpdatesSchema = z.object({
  properties: ClipPropertiesSchema,
}).strict();
const TextPropertyUpdatesSchema = z.object({
  content: z.string().optional(),
  style: z.record(StyleValueSchema).optional(),
}).strict().refine((patch) =>
  patch.content !== undefined || patch.style !== undefined,
  "At least one text or style field must be provided.",
);

const CommandEnvelopeSchema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  commandId: IdSchema,
  expectedRevision: z.number().int().safe().nonnegative(),
}).strict();

export const ProjectCommandSchema = z.discriminatedUnion("type", [
  CommandEnvelopeSchema.extend({
    type: z.literal("split-clip"),
    payload: z.object({
      trackId: IdSchema,
      clipId: IdSchema,
      at: RationalSchema.refine((time) => time.numerator >= 0),
      rightClipId: IdSchema,
      captionText: CaptionSplitSchema.optional(),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("trim-clip-start"),
    payload: z.object({
      trackId: IdSchema,
      clipId: IdSchema,
      timelineStart: RationalSchema.refine((time) => time.numerator >= 0),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("trim-clip-end"),
    payload: z.object({
      trackId: IdSchema,
      clipId: IdSchema,
      timelineEnd: RationalSchema.refine((time) => time.numerator > 0),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("move-clip"),
    payload: z.object({
      trackId: IdSchema,
      clipId: IdSchema,
      timelineStart: RationalSchema.refine((time) => time.numerator >= 0),
      destinationTrackId: IdSchema.optional(),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("delete-clip"),
    payload: z.object({trackId: IdSchema, clipId: IdSchema}).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("ripple-delete"),
    payload: z.object({
      trackId: IdSchema,
      start: RationalSchema.refine((time) => time.numerator >= 0),
      end: RationalSchema.refine((time) => time.numerator > 0),
      rightClipIds: z.record(IdSchema),
      captionSplits: z.record(CaptionSplitSchema),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("change-clip-speed"),
    payload: z.object({
      trackId: IdSchema,
      clipId: IdSchema,
      speed: RationalSchema.refine((speed) => speed.numerator > 0),
      policy: z.enum(["preserve-source-range", "preserve-timeline-range"]),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("update-clip-properties"),
    payload: z.object({
      trackId: IdSchema,
      clipId: IdSchema,
      patch: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("media"),
          updates: MediaPropertyUpdatesSchema,
        }).strict(),
        z.object({
          kind: z.enum(["text", "caption"]),
          updates: TextPropertyUpdatesSchema,
        }).strict(),
      ]),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("add-track"),
    payload: z.object({track: EmptyTrackSchema}).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("remove-track"),
    payload: z.object({
      trackId: IdSchema,
      removeContents: z.boolean(),
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("add-media-clip"),
    payload: z.object({
      trackId: IdSchema,
      clip: MediaClipSchema,
    }).strict(),
  }),
  CommandEnvelopeSchema.extend({
    type: z.literal("remove-media-clip"),
    payload: z.object({trackId: IdSchema, clipId: IdSchema}).strict(),
  }),
]);

export type ProjectCommand = z.infer<typeof ProjectCommandSchema>;
export type RationalTime = Rational;
export type ProjectCommandType = ProjectCommand["type"];

export type ProjectCommandErrorCode =
  | "INVALID_COMMAND"
  | "STALE_REVISION"
  | "INVALID_PROJECT"
  | "REVISION_OVERFLOW"
  | "TRACK_NOT_FOUND"
  | "CLIP_NOT_FOUND"
  | "ASSET_NOT_FOUND"
  | "ID_COLLISION"
  | "TRACK_INCOMPATIBLE"
  | "INVALID_TIMING"
  | "INVALID_SOURCE_RANGE"
  | "LEGACY_MISMATCH_UNSUPPORTED"
  | "CAPTION_TEXT_REQUIRED"
  | "TRACK_NOT_EMPTY"
  | "TRACK_ORDER_COLLISION"
  | "UNUSED_GENERATED_ID"
  | "ARITHMETIC_OVERFLOW";

export class ProjectCommandError extends Error {
  readonly code: ProjectCommandErrorCode;
  readonly details?: unknown;

  constructor(
    code: ProjectCommandErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ProjectCommandError";
    this.code = code;
    this.details = details;
  }
}

export type CommandResult = {
  project: ProjectDocumentV1;
  command: ProjectCommand;
};
