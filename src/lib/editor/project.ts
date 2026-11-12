import { z } from "zod";

export const PROJECT_SCHEMA_VERSION = 1 as const;

export interface Rational {
  numerator: number;
  denominator: number;
}

export type MediaTime = Rational;

export interface FrameRate extends Rational {}

export type TrackKind = "video" | "audio" | "text" | "captions" | "overlay";

export type AssetKind = "video" | "audio" | "image";
export type AssetAvailability = "available" | "missing" | "unknown";

export type StyleValue = string | number | boolean;

export interface MediaAsset {
  id: string;
  kind: AssetKind;
  original: {
    filename: string | null;
    mimeType: string | null;
    duration: MediaTime | null;
    width: number | null;
    height: number | null;
    sourceTimebase: Rational | null;
    frameRate: FrameRate | null;
  };
  localMediaKey: string | null;
  proxyMediaKey: string | null;
  availability: AssetAvailability;
}

export interface TransformProperties {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotationDegrees: number;
  opacity: number;
}

export interface Effect {
  id: string;
  kind: string;
  parameters: Record<string, StyleValue>;
}

export interface ClipProperties {
  transform?: TransformProperties;
  volume?: number;
  effects?: Effect[];
}

export interface Keyframe {
  id: string;
  property: string;
  time: MediaTime;
  value: StyleValue;
  interpolation: "linear" | "hold" | "bezier";
}

export interface MediaClip {
  id: string;
  kind: "media";
  assetId: string;
  /** Canonical duration must match source duration / speed within half a frame. */
  timelineStart: MediaTime;
  timelineEnd: MediaTime;
  sourceIn: MediaTime;
  sourceOut: MediaTime;
  speed: Rational;
  /**
   * Legacy mismatches are preserved as provenance. Preview, export, and edit-command
   * boundaries must explicitly handle this status rather than treating it as consistent.
   */
  timingStatus: "consistent" | "legacy-mismatch";
  properties: ClipProperties;
  keyframes: Keyframe[];
}

export interface TextClip {
  id: string;
  kind: "text" | "caption";
  timelineStart: MediaTime;
  timelineEnd: MediaTime;
  content: string;
  style: Record<string, StyleValue>;
  keyframes: Keyframe[];
}

export type ProjectClip = MediaClip | TextClip;

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  order: number;
  locked: boolean;
  muted: boolean;
  hidden: boolean;
  clips: ProjectClip[];
}

export interface ProjectDocumentV1 {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: string;
  revision: number;
  metadata: {
    name: string | null;
    aspectRatio: string | null;
    createdAt: number | null;
    updatedAt: number | null;
  };
  settings: {
    frameRate: FrameRate | null;
    width: number | null;
    height: number | null;
  };
  assets: MediaAsset[];
  tracks: Track[];
}

/** Legacy migration accepts up to 50 ms of timing difference without rewriting values. */
export const LEGACY_CLIP_TIMING_TOLERANCE = {numerator: 1, denominator: 20} as const;

/**
 * Canonical timing allows at most half a frame: nearest-frame quantization has a
 * maximum rounding error of half a frame. This is strictly sub-frame and is
 * evaluated as a rational duration, not a floating-point approximation.
 */
export const CANONICAL_CLIP_TIMING_TOLERANCE_FRAMES = {
  numerator: 1,
  denominator: 2,
} as const;

const SafeIntegerSchema = z.number().int().safe();

export const RationalSchema = z.object({
  numerator: SafeIntegerSchema,
  denominator: SafeIntegerSchema.positive(),
}).strict().superRefine((value, context) => {
  if (greatestCommonDivisor(value.numerator, value.denominator) !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["numerator"],
      message: "Rational values must be reduced to lowest terms.",
    });
  }
});

export const MediaTimeSchema = RationalSchema.refine(
  (value) => value.numerator >= 0,
  "Media time must be non-negative.",
);

export const FrameRateSchema = RationalSchema.refine(
  (value) => value.numerator > 0,
  "Frame rate must be positive.",
);

const PositiveMediaTimeSchema = MediaTimeSchema.refine(
  (value) => value.numerator > 0,
  "Duration must be positive.",
);

const SafeStringSchema = z.string().min(1).max(200);
const StyleValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

const TransformPropertiesSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  scaleX: z.number().finite().positive(),
  scaleY: z.number().finite().positive(),
  rotationDegrees: z.number().finite(),
  opacity: z.number().finite().min(0).max(1),
}).strict();

const EffectSchema = z.object({
  id: SafeStringSchema,
  kind: SafeStringSchema,
  parameters: z.record(StyleValueSchema),
}).strict();

const ClipPropertiesSchema = z.object({
  transform: TransformPropertiesSchema.optional(),
  volume: z.number().finite().nonnegative().optional(),
  effects: z.array(EffectSchema).optional(),
}).strict();

const KeyframeSchema = z.object({
  id: SafeStringSchema,
  property: SafeStringSchema,
  time: MediaTimeSchema,
  value: StyleValueSchema,
  interpolation: z.enum(["linear", "hold", "bezier"]),
}).strict();

const MediaClipSchema = z.object({
  id: SafeStringSchema,
  kind: z.literal("media"),
  assetId: SafeStringSchema,
  timelineStart: MediaTimeSchema,
  timelineEnd: PositiveMediaTimeSchema,
  sourceIn: MediaTimeSchema,
  sourceOut: PositiveMediaTimeSchema,
  speed: RationalSchema.refine(
    (value) => value.numerator > 0,
    "Clip speed must be positive.",
  ),
  timingStatus: z.enum(["consistent", "legacy-mismatch"]),
  properties: ClipPropertiesSchema,
  keyframes: z.array(KeyframeSchema),
}).strict();

const TextClipSchema = z.object({
  id: SafeStringSchema,
  kind: z.enum(["text", "caption"]),
  timelineStart: MediaTimeSchema,
  timelineEnd: PositiveMediaTimeSchema,
  content: z.string(),
  style: z.record(StyleValueSchema),
  keyframes: z.array(KeyframeSchema),
}).strict();

const ProjectClipSchema = z.discriminatedUnion("kind", [
  MediaClipSchema,
  TextClipSchema,
]);

const TrackSchema = z.object({
  id: SafeStringSchema,
  kind: z.enum(["video", "audio", "text", "captions", "overlay"]),
  name: z.string().max(200),
  order: SafeIntegerSchema.nonnegative(),
  locked: z.boolean(),
  muted: z.boolean(),
  hidden: z.boolean(),
  clips: z.array(ProjectClipSchema),
}).strict().superRefine((track, context) => {
  track.clips.forEach((clip, index) => {
    const compatible =
      (track.kind === "video" && clip.kind === "media") ||
      (track.kind === "audio" && clip.kind === "media") ||
      (track.kind === "overlay" && clip.kind === "media") ||
      (track.kind === "text" && clip.kind === "text") ||
      (track.kind === "captions" && clip.kind === "caption");
    if (!compatible) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clips", index, "kind"],
        message: `Clip kind is not compatible with ${track.kind} track.`,
      });
    }
  });
});

const MediaAssetSchema = z.object({
  id: SafeStringSchema,
  kind: z.enum(["video", "audio", "image"]),
  original: z.object({
    filename: z.string().max(1024).nullable(),
    mimeType: z.string().max(256).nullable(),
    duration: PositiveMediaTimeSchema.nullable(),
    width: SafeIntegerSchema.positive().nullable(),
    height: SafeIntegerSchema.positive().nullable(),
    sourceTimebase: FrameRateSchema.nullable(),
    frameRate: FrameRateSchema.nullable(),
  }).strict(),
  localMediaKey: z.string().max(1024).nullable(),
  proxyMediaKey: z.string().max(1024).nullable(),
  availability: z.enum(["available", "missing", "unknown"]),
}).strict();

export const ProjectDocumentV1Schema = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: SafeStringSchema,
  revision: SafeIntegerSchema.nonnegative(),
  metadata: z.object({
    name: z.string().max(500).nullable(),
    aspectRatio: z.string().max(32).nullable(),
    createdAt: z.number().finite().nonnegative().nullable(),
    updatedAt: z.number().finite().nonnegative().nullable(),
  }).strict(),
  settings: z.object({
    frameRate: FrameRateSchema.nullable(),
    width: SafeIntegerSchema.positive().nullable(),
    height: SafeIntegerSchema.positive().nullable(),
  }).strict().superRefine((settings, context) => {
    if ((settings.width === null) !== (settings.height === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["height"],
        message: "Project width and height must either both be set or both be null.",
      });
    }
  }),
  assets: z.array(MediaAssetSchema),
  tracks: z.array(TrackSchema),
}).strict().superRefine((project, context) => {
  const assetIds = new Set<string>();
  const assetsById = new Map<string, MediaAsset>();
  project.assets.forEach((asset, index) => {
    if (assetIds.has(asset.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assets", index, "id"],
        message: "Asset IDs must be unique within a project.",
      });
    }
    assetIds.add(asset.id);
    assetsById.set(asset.id, asset);
  });

  const trackIds = new Set<string>();
  const trackOrders = new Set<number>();
  const clipIds = new Set<string>();
  project.tracks.forEach((track, trackIndex) => {
    if (trackIds.has(track.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tracks", trackIndex, "id"],
        message: "Track IDs must be unique within a project.",
      });
    }
    trackIds.add(track.id);
    if (trackOrders.has(track.order)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tracks", trackIndex, "order"],
        message: "Track order values must be unique within a project.",
      });
    }
    trackOrders.add(track.order);

    track.clips.forEach((clip, clipIndex) => {
      validateClipTiming(
        clip,
        context,
        ["tracks", trackIndex, "clips", clipIndex],
        project.settings.frameRate,
      );
      if (clipIds.has(clip.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks", trackIndex, "clips", clipIndex, "id"],
          message: "Clip IDs must be unique within a project.",
        });
      }
      clipIds.add(clip.id);
      if (clip.kind !== "media") return;

      const asset = assetsById.get(clip.assetId);
      if (!asset) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks", trackIndex, "clips", clipIndex, "assetId"],
          message: "Media clip must reference an asset in this project.",
        });
        return;
      }
      if (
        (track.kind === "video" && asset.kind !== "video") ||
        (track.kind === "audio" && asset.kind !== "audio") ||
        (track.kind === "overlay" && asset.kind !== "video" && asset.kind !== "image")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks", trackIndex, "clips", clipIndex, "assetId"],
          message: `Asset kind is not compatible with ${track.kind} track.`,
        });
      }
      if (
        asset.original.duration &&
        compareRationals(clip.sourceOut, asset.original.duration) > 0
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tracks", trackIndex, "clips", clipIndex, "sourceOut"],
          message: "Clip source out exceeds the known asset duration.",
        });
      }
    });
  });
});

export type ProjectDocument = ProjectDocumentV1;

export class UnsupportedProjectVersionError extends Error {
  readonly version: unknown;

  constructor(version: unknown) {
    super(`Unsupported project schema version: ${String(version)}.`);
    this.name = "UnsupportedProjectVersionError";
    this.version = version;
  }
}

export function parseProjectDocument(value: unknown): ProjectDocument {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== PROJECT_SCHEMA_VERSION
  ) {
    const version = typeof value === "object" && value !== null && "schemaVersion" in value
      ? value.schemaVersion
      : undefined;
    throw new UnsupportedProjectVersionError(version);
  }
  return ProjectDocumentV1Schema.parse(value);
}

export function rationalFromNumber(value: number): Rational {
  if (!Number.isFinite(value)) {
    throw new Error("Cannot convert a non-finite number to rational time.");
  }
  const decimal = value.toString().match(/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/iu);
  if (!decimal) throw new Error("Number cannot be represented as rational time.");

  const sign = decimal[1] === "-" ? -1n : 1n;
  const fraction = decimal[3] ?? "";
  const exponent = Number(decimal[4] ?? 0);
  let numerator = sign * BigInt(`${decimal[2]}${fraction}`);
  let denominator = 10n ** BigInt(fraction.length);
  if (exponent > 0) numerator *= 10n ** BigInt(exponent);
  if (exponent < 0) denominator *= 10n ** BigInt(-exponent);
  const divisor = greatestCommonDivisorBigInt(numerator, denominator);
  numerator /= divisor;
  denominator /= divisor;

  if (isSafeBigInt(numerator) && isSafeBigInt(denominator)) {
    return {numerator: Number(numerator), denominator: Number(denominator)};
  }

  const scale = 1_000_000;
  const roundedNumerator = Math.round(value * scale);
  if (!Number.isSafeInteger(roundedNumerator)) {
    throw new Error("Number is too large to represent safely as rational time.");
  }
  if (value !== 0 && roundedNumerator === 0) {
    throw new Error(
      "Number is too small to preserve at microsecond precision; provide an explicit rational value.",
    );
  }
  return reduceRational({numerator: roundedNumerator, denominator: scale});
}

export function rationalToNumber(value: Rational): number {
  return value.numerator / value.denominator;
}

export function reduceRational(value: Rational): Rational {
  const divisor = greatestCommonDivisorBigInt(
    BigInt(value.numerator),
    BigInt(value.denominator),
  );
  return {
    numerator: Number(BigInt(value.numerator) / divisor),
    denominator: Number(BigInt(value.denominator) / divisor),
  };
}

export function compareRationals(first: Rational, second: Rational): number {
  const difference =
    BigInt(first.numerator) * BigInt(second.denominator) -
    BigInt(second.numerator) * BigInt(first.denominator);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function subtractRationals(first: Rational, second: Rational): Rational {
  const numerator =
    BigInt(first.numerator) * BigInt(second.denominator) -
    BigInt(second.numerator) * BigInt(first.denominator);
  const denominator = BigInt(first.denominator) * BigInt(second.denominator);
  return rationalFromBigInts(numerator, denominator);
}

export function divideRationals(first: Rational, second: Rational): Rational {
  if (second.numerator === 0) throw new Error("Cannot divide by zero rational.");
  return rationalFromBigInts(
    BigInt(first.numerator) * BigInt(second.denominator),
    BigInt(first.denominator) * BigInt(second.numerator),
  );
}

/**
 * JavaScript numbers cannot retain the original rational pair. For example,
 * `30000 / 1001` is already rounded before this function receives it. Pass
 * explicit rational values for frame rates and source timebases.
 */
export function isMediaClipTimingConsistent(
  clip: Pick<MediaClip, "timelineStart" | "timelineEnd" | "sourceIn" | "sourceOut" | "speed">,
  frameRate: FrameRate | null = null,
): boolean {
  if (
    clip.speed.numerator <= 0 ||
    (frameRate !== null && (
      typeof frameRate !== "object" ||
      !Number.isSafeInteger(frameRate.numerator) ||
      !Number.isSafeInteger(frameRate.denominator) ||
      frameRate.numerator <= 0 ||
      frameRate.denominator <= 0
    ))
  ) return false;

  const toleranceNumerator = frameRate === null
    ? 0n
    : BigInt(frameRate.denominator) *
      BigInt(CANONICAL_CLIP_TIMING_TOLERANCE_FRAMES.numerator);
  const toleranceDenominator = frameRate === null
    ? 1n
    : BigInt(frameRate.numerator) *
      BigInt(CANONICAL_CLIP_TIMING_TOLERANCE_FRAMES.denominator);
  return isTimingDifferenceWithinTolerance(
    clip,
    toleranceNumerator,
    toleranceDenominator,
  );
}

/** Legacy-only comparison; canonical validation uses the project frame rate. */
export function isMediaClipTimingWithinLegacyTolerance(
  clip: Pick<MediaClip, "timelineStart" | "timelineEnd" | "sourceIn" | "sourceOut" | "speed">,
): boolean {
  if (clip.speed.numerator <= 0) return false;
  return isTimingDifferenceWithinTolerance(
    clip,
    BigInt(LEGACY_CLIP_TIMING_TOLERANCE.numerator),
    BigInt(LEGACY_CLIP_TIMING_TOLERANCE.denominator),
  );
}

function isTimingDifferenceWithinTolerance(
  clip: Pick<MediaClip, "timelineStart" | "timelineEnd" | "sourceIn" | "sourceOut" | "speed">,
  toleranceNumerator: bigint,
  toleranceDenominator: bigint,
): boolean {
  const timelineDurationNumerator =
    BigInt(clip.timelineEnd.numerator) * BigInt(clip.timelineStart.denominator) -
    BigInt(clip.timelineStart.numerator) * BigInt(clip.timelineEnd.denominator);
  const timelineDurationDenominator =
    BigInt(clip.timelineEnd.denominator) * BigInt(clip.timelineStart.denominator);
  const sourceDurationNumerator =
    BigInt(clip.sourceOut.numerator) * BigInt(clip.sourceIn.denominator) -
    BigInt(clip.sourceIn.numerator) * BigInt(clip.sourceOut.denominator);
  const sourceDurationDenominator =
    BigInt(clip.sourceOut.denominator) * BigInt(clip.sourceIn.denominator);
  const expectedDurationNumerator =
    sourceDurationNumerator * BigInt(clip.speed.denominator);
  const expectedDurationDenominator =
    sourceDurationDenominator * BigInt(clip.speed.numerator);
  const differenceNumerator =
    timelineDurationNumerator * expectedDurationDenominator -
    expectedDurationNumerator * timelineDurationDenominator;
  const absoluteDifference =
    differenceNumerator < 0n ? -differenceNumerator : differenceNumerator;

  return absoluteDifference * toleranceDenominator <=
    toleranceNumerator * timelineDurationDenominator * expectedDurationDenominator;
}

function isLessThan(first: Rational, second: Rational): boolean {
  return compareRationals(first, second) < 0;
}

function validateClipTiming(
  clip: z.infer<typeof ProjectClipSchema>,
  context: z.RefinementCtx,
  path: (string | number)[],
  frameRate: FrameRate | null,
): void {
  if (!isLessThan(clip.timelineStart, clip.timelineEnd)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...path, "timelineEnd"],
      message: "Timeline end must follow timeline start.",
    });
  }
  const timelineDurationNumerator =
    BigInt(clip.timelineEnd.numerator) * BigInt(clip.timelineStart.denominator) -
    BigInt(clip.timelineStart.numerator) * BigInt(clip.timelineEnd.denominator);
  const timelineDurationDenominator =
    BigInt(clip.timelineEnd.denominator) * BigInt(clip.timelineStart.denominator);

  if (clip.kind === "media") {
    if (!isLessThan(clip.sourceIn, clip.sourceOut)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "sourceOut"],
        message: "Source out must follow source in.",
      });
    }
    const consistent = isMediaClipTimingConsistent(clip, frameRate);
    if (clip.timingStatus === "consistent" && !consistent) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "timingStatus"],
        message: frameRate === null
          ? "Clip timing must exactly equal (source out - source in) / speed when the project frame rate is unavailable, or retain legacy-mismatch status."
          : "Clip duration must equal (source out - source in) / speed within half a project frame, or retain legacy-mismatch status.",
      });
    }
  }

  const effectIds = new Set<string>();
  if (clip.kind === "media") {
    clip.properties.effects?.forEach((effect, effectIndex) => {
      if (effectIds.has(effect.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "properties", "effects", effectIndex, "id"],
          message: "Effect IDs must be unique within a clip.",
        });
      }
      effectIds.add(effect.id);
    });
  }

  const keyframeIds = new Set<string>();
  clip.keyframes.forEach((keyframe, keyframeIndex) => {
    if (keyframeIds.has(keyframe.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "keyframes", keyframeIndex, "id"],
        message: "Keyframe IDs must be unique within a clip.",
      });
    }
    keyframeIds.add(keyframe.id);

    const afterClipDuration = (
      BigInt(keyframe.time.numerator) * timelineDurationDenominator >
      timelineDurationNumerator * BigInt(keyframe.time.denominator)
    );
    if (afterClipDuration) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "keyframes", keyframeIndex, "time"],
        message: "Keyframe time must be within the clip duration.",
      });
    }
  });
}

function rationalFromBigInts(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) throw new Error("Rational denominator must not be zero.");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisorBigInt(numerator, denominator);
  const reducedNumerator = numerator / divisor * sign;
  const reducedDenominator = denominator / divisor * sign;
  if (!isSafeBigInt(reducedNumerator) || !isSafeBigInt(reducedDenominator)) {
    throw new Error("Rational arithmetic exceeded the safe integer range.");
  }
  return {
    numerator: Number(reducedNumerator),
    denominator: Number(reducedDenominator),
  };
}

function greatestCommonDivisor(first: number, second: number): number {
  let a = Math.abs(first);
  let b = Math.abs(second);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function greatestCommonDivisorBigInt(first: bigint, second: bigint): bigint {
  let a = first < 0n ? -first : first;
  let b = second < 0n ? -second : second;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

function isSafeBigInt(value: bigint): boolean {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) &&
    value >= BigInt(Number.MIN_SAFE_INTEGER);
}
