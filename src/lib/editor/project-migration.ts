import type { VideoClip } from "./editor-context.ts";
import {
  isMediaClipTimingConsistent,
  isMediaClipTimingWithinLegacyTolerance,
  parseProjectDocument,
  rationalFromNumber,
  type AssetAvailability,
  type FrameRate,
  type MediaClip,
  type ProjectDocumentV1,
  type Rational,
} from "./project.ts";

export interface LegacySourceMedia {
  filename: string | null;
  mimeType?: string | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  sourceTimebase?: Rational | null;
  frameRate?: FrameRate | null;
}

export interface LegacyProjectInput {
  projectId: string;
  clips: readonly VideoClip[];
  sourceMedia: LegacySourceMedia | null;
  metadata?: {
    name?: string | null;
    aspectRatio?: string | null;
    createdAt?: number | null;
    updatedAt?: number | null;
  };
  settings?: {
    frameRate?: FrameRate | null;
  };
  media?: {
    localMediaKey?: string | null;
    proxyMediaKey?: string | null;
    availability?: AssetAvailability;
  };
}

export interface MigrationResult {
  project: ProjectDocumentV1;
  /**
   * Future project loaders must surface these warnings and explicitly handle
   * legacy-mismatch clips before normal editing or export.
   */
  warnings: string[];
}

const LEGACY_TRACK_ID = "track";
const LEGACY_ASSET_ID = "asset";

export function migrateLegacyProject(input: LegacyProjectInput): MigrationResult {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input)
  ) {
    throw new Error("Legacy project must be a plain JSON object.");
  }
  assertOnlyKeys(
    input,
    "project",
    ["projectId", "clips", "sourceMedia", "metadata", "settings", "media"],
  );
  if (
    typeof input.projectId !== "string" ||
    !input.projectId.trim() ||
    input.projectId.length > 200
  ) {
    throw new Error("Legacy project ID must contain 1 to 200 characters.");
  }
  if (!Array.isArray(input.clips)) {
    throw new Error("Legacy project clips must be an array.");
  }
  if (
    input.sourceMedia !== null &&
    (typeof input.sourceMedia !== "object" || Array.isArray(input.sourceMedia))
  ) {
    throw new Error("Legacy source media metadata must be an object or null.");
  }

  assertOnlyKeys(input.metadata, "metadata", ["name", "aspectRatio", "createdAt", "updatedAt"]);
  assertOnlyKeys(input.settings, "settings", ["frameRate"]);
  assertOnlyKeys(input.media, "media", ["localMediaKey", "proxyMediaKey", "availability"]);
  if (input.sourceMedia !== null) {
    assertOnlyKeys(
      input.sourceMedia,
      "sourceMedia",
      ["filename", "mimeType", "duration", "width", "height", "sourceTimebase", "frameRate"],
    );
  }

  const warnings: string[] = [];
  const projectId = input.projectId;
  const frameRate = input.settings?.frameRate ?? input.sourceMedia?.frameRate ?? null;
  const trackId = makeStableId(projectId, LEGACY_TRACK_ID);
  const assetId = makeStableId(projectId, LEGACY_ASSET_ID);
  const clips = input.clips.map((clip, index) => {
    validateLegacyClip(clip, index);
    const timelineStart = convertLegacyTime(clip.start, `clip ${clip.id} timeline start`, warnings);
    const timelineEnd = convertLegacyTime(clip.end, `clip ${clip.id} timeline end`, warnings);
    const sourceIn = convertLegacyTime(clip.sourceStart, `clip ${clip.id} source in`, warnings);
    const sourceOut = convertLegacyTime(clip.sourceEnd, `clip ${clip.id} source out`, warnings);
    const speed = rationalFromNumber(clip.speed);
    const migratedClip: MediaClip = {
      id: clip.id,
      kind: "media" as const,
      assetId,
      timelineStart,
      timelineEnd,
      sourceIn,
      sourceOut,
      speed,
      timingStatus: "consistent" as const,
      properties: {},
      keyframes: [],
    };
    const legacyCompatible = isMediaClipTimingWithinLegacyTolerance(migratedClip);
    const canonicalConsistent = isMediaClipTimingConsistent(migratedClip, frameRate);
    const timingStatus: MediaClip["timingStatus"] =
      legacyCompatible && canonicalConsistent
        ? "consistent"
        : "legacy-mismatch";
    if (timingStatus === "legacy-mismatch") {
      if (!legacyCompatible) {
        warnings.push(
          `Clip ${clip.id} preserves legacy timeline, source, and speed values that do not satisfy the canonical timing rule within 50 ms.`,
        );
      } else if (frameRate === null) {
        warnings.push(
          `Clip ${clip.id} preserves legacy timeline, source, and speed values within the 50 ms migration compatibility tolerance, but cannot meet the canonical exact-timing requirement without a known frame rate; status is legacy-mismatch.`,
        );
      } else {
        warnings.push(
          `Clip ${clip.id} preserves legacy timeline, source, and speed values within the 50 ms migration compatibility tolerance, but exceeds the canonical half-frame timing tolerance; status is legacy-mismatch.`,
        );
      }
    }
    return {...migratedClip, timingStatus};
  });

  const hasSource = input.sourceMedia !== null;
  const needsAsset = hasSource || clips.length > 0;
  const availability = input.media?.availability ??
    (hasSource ? "unknown" : "unknown");
  const asset = needsAsset
    ? {
        id: assetId,
        kind: "video" as const,
        original: {
          filename: input.sourceMedia?.filename ?? null,
          mimeType: input.sourceMedia?.mimeType ?? null,
          duration: input.sourceMedia?.duration == null
            ? null
            : convertLegacyTime(input.sourceMedia.duration, "source duration", warnings),
          width: input.sourceMedia?.width ?? null,
          height: input.sourceMedia?.height ?? null,
          sourceTimebase: input.sourceMedia?.sourceTimebase ?? null,
          frameRate: input.sourceMedia?.frameRate ?? null,
        },
        localMediaKey: input.media?.localMediaKey ?? null,
        proxyMediaKey: input.media?.proxyMediaKey ?? null,
        availability,
      }
    : null;

  if (clips.length > 0 && !hasSource) {
    warnings.push(
      "Legacy clips were preserved, but source media metadata is unavailable; the source asset is marked unknown.",
    );
  }
  if (asset?.availability === "missing") {
    warnings.push(
      "Source media is missing; project clips and source references were preserved.",
    );
  }
  if (input.sourceMedia?.filename === null && hasSource) {
    warnings.push("Source media filename is unavailable and was preserved as null.");
  }
  if (
    input.settings?.frameRate == null &&
    input.sourceMedia?.frameRate == null &&
    clips.length > 0
  ) {
    warnings.push("Project frame rate is unknown; no frame rate was inferred.");
  }

  const project: ProjectDocumentV1 = {
    schemaVersion: 1,
    id: projectId,
    revision: 0,
    metadata: {
      name: input.metadata?.name ?? null,
      aspectRatio: input.metadata?.aspectRatio ?? null,
      createdAt: input.metadata?.createdAt ?? null,
      updatedAt: input.metadata?.updatedAt ?? null,
    },
    settings: {
      frameRate,
      width: null,
      height: null,
    },
    assets: asset ? [asset] : [],
    tracks: clips.length > 0
      ? [{
          id: trackId,
          kind: "video",
          name: "Video 1",
          order: 0,
          locked: false,
          muted: false,
          hidden: false,
          clips,
        }]
      : [],
  };

  return {
    project: parseProjectDocument(project),
    warnings,
  };
}

export function migrateOrValidateProject(value: unknown): MigrationResult {
  return {project: parseProjectDocument(value), warnings: []};
}

function validateLegacyClip(clip: VideoClip, index: number): void {
  assertOnlyKeys(clip, `clips[${index}]`, [
    "id",
    "start",
    "end",
    "sourceStart",
    "sourceEnd",
    "speed",
  ]);
  if (
    typeof clip.id !== "string" ||
    !clip.id.trim() ||
    clip.id.length > 200
  ) {
    throw new Error(`Legacy clip at index ${index} has an invalid ID.`);
  }
  for (const [field, value] of Object.entries({
    start: clip.start,
    end: clip.end,
    sourceStart: clip.sourceStart,
    sourceEnd: clip.sourceEnd,
    speed: clip.speed,
  })) {
    if (!Number.isFinite(value)) {
      throw new Error(`Legacy clip ${clip.id} has a non-finite ${field}.`);
    }
  }
  if (
    clip.start < 0 ||
    clip.end <= clip.start ||
    clip.sourceStart < 0 ||
    clip.sourceEnd <= clip.sourceStart ||
    clip.speed <= 0
  ) {
    throw new Error(`Legacy clip ${clip.id} has invalid source, timeline, or speed values.`);
  }
}

function convertLegacyTime(
  value: number,
  label: string,
  warnings: string[],
): Rational {
  const converted = rationalFromNumber(value);
  if (convertedToNumber(converted) !== value) {
    warnings.push(
      `${label} was rounded to microsecond precision during rational conversion.`,
    );
  }
  return converted;
}

function convertedToNumber(value: Rational): number {
  return value.numerator / value.denominator;
}

function assertOnlyKeys(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): void {
  if (value === undefined) return;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error(`Legacy ${path} must be a plain JSON object.`);
  }

  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(
        `Legacy ${path}.${String(key)} is unsupported; preserve or remove it before migration.`,
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new Error(
        `Legacy ${path}.${key} must be an enumerable JSON data property.`,
      );
    }
  }
}

function makeStableId(projectId: string, role: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of projectId) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `legacy-${role}-${hash.toString(16).padStart(16, "0")}`;
}
