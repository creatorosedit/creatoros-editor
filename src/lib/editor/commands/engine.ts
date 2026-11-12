import {
  ProjectDocumentV1Schema,
  compareRationals,
  type MediaClip,
  type MediaTime,
  type ProjectClip,
  type ProjectDocumentV1,
  type Rational,
  type TextClip,
  type Track,
} from "../project.ts";
import {
  ProjectCommandError,
  ProjectCommandSchema,
  type CommandResult,
  type ProjectCommand,
} from "./types.ts";

type RationalInput = Rational;
type ClipLocation = {track: Track; index: number; clip: ProjectClip};
type CaptionSplit = {leftText: string; rightText: string};

function fail(
  code: ConstructorParameters<typeof ProjectCommandError>[0],
  message: string,
  details?: unknown,
): never {
  throw new ProjectCommandError(code, message, details);
}

function assertJsonValue(value: unknown, path = "$", ancestors = new Set<object>()): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return;
  if (typeof value !== "object") {
    fail("INVALID_COMMAND", `${path} is not JSON-serializable.`);
  }
  if (ancestors.has(value)) fail("INVALID_COMMAND", `${path} contains a cycle.`);
  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null) {
    fail("INVALID_COMMAND", `${path} must be a plain JSON object.`);
  }
  ancestors.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      fail("INVALID_COMMAND", `${path} contains a non-string property.`);
    }
    if (isArray && key === "length") continue;
    if (
      isArray &&
      (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length)
    ) {
      fail("INVALID_COMMAND", `${path} contains a non-JSON array property.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      fail("INVALID_COMMAND", `${path}.${key} must be a JSON data property.`);
    }
    assertJsonValue(descriptor.value, `${path}.${key}`, ancestors);
  }
  if (isArray && Object.keys(value).length !== value.length) {
    fail("INVALID_COMMAND", `${path} must not contain sparse array entries.`);
  }
  ancestors.delete(value);
}

function gcd(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a || 1n;
}

function rational(numerator: bigint, denominator: bigint): Rational {
  if (denominator === 0n) fail("ARITHMETIC_OVERFLOW", "Rational denominator is zero.");
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = gcd(numerator, denominator);
  const reducedNumerator = numerator / divisor * sign;
  const reducedDenominator = denominator / divisor * sign;
  if (
    reducedNumerator > BigInt(Number.MAX_SAFE_INTEGER) ||
    reducedNumerator < BigInt(Number.MIN_SAFE_INTEGER) ||
    reducedDenominator > BigInt(Number.MAX_SAFE_INTEGER) ||
    reducedDenominator <= 0n
  ) {
    fail("ARITHMETIC_OVERFLOW", "Exact rational result exceeds the safe integer range.");
  }
  return {
    numerator: Number(reducedNumerator),
    denominator: Number(reducedDenominator),
  };
}

function add(first: RationalInput, second: RationalInput): Rational {
  return rational(
    BigInt(first.numerator) * BigInt(second.denominator) +
      BigInt(second.numerator) * BigInt(first.denominator),
    BigInt(first.denominator) * BigInt(second.denominator),
  );
}

function subtract(first: RationalInput, second: RationalInput): Rational {
  return rational(
    BigInt(first.numerator) * BigInt(second.denominator) -
      BigInt(second.numerator) * BigInt(first.denominator),
    BigInt(first.denominator) * BigInt(second.denominator),
  );
}

function multiply(first: RationalInput, second: RationalInput): Rational {
  return rational(
    BigInt(first.numerator) * BigInt(second.numerator),
    BigInt(first.denominator) * BigInt(second.denominator),
  );
}

function divide(first: RationalInput, second: RationalInput): Rational {
  if (second.numerator === 0) fail("INVALID_TIMING", "Cannot divide by zero clip speed.");
  return rational(
    BigInt(first.numerator) * BigInt(second.denominator),
    BigInt(first.denominator) * BigInt(second.numerator),
  );
}

function compare(first: RationalInput, second: RationalInput): number {
  return compareRationals(first, second);
}

function timeFromClipStart(clip: ProjectClip, time: MediaTime): Rational {
  return subtract(time, clip.timelineStart);
}

function sourceAt(clip: MediaClip, timelineTime: MediaTime): Rational {
  return add(
    clip.sourceIn,
    multiply(timeFromClipStart(clip, timelineTime), clip.speed),
  );
}

function duration(start: MediaTime, end: MediaTime): Rational {
  return subtract(end, start);
}

function assertPositive(value: RationalInput, message: string): void {
  if (value.numerator <= 0) fail("INVALID_TIMING", message);
}

function findTrack(project: ProjectDocumentV1, trackId: string): Track {
  const track = project.tracks.find((candidate) => candidate.id === trackId);
  if (!track) fail("TRACK_NOT_FOUND", `Track ${trackId} does not exist.`);
  return track;
}

function findClip(track: Track, clipId: string): ClipLocation {
  const index = track.clips.findIndex((candidate) => candidate.id === clipId);
  const clip = track.clips[index];
  if (!clip) fail("CLIP_NOT_FOUND", `Clip ${clipId} does not exist on track ${track.id}.`);
  return {track, index, clip};
}

function clipIds(project: ProjectDocumentV1): Set<string> {
  return new Set(project.tracks.flatMap((track) => track.clips.map((clip) => clip.id)));
}

function assertNewClipId(project: ProjectDocumentV1, id: string): void {
  if (clipIds(project).has(id)) fail("ID_COLLISION", `Clip ID ${id} already exists.`);
}

function assertTrackAcceptsClip(
  track: Track,
  clip: ProjectClip,
  project: ProjectDocumentV1,
): void {
  if (
    (track.kind === "video" && clip.kind !== "media") ||
    (track.kind === "audio" && clip.kind !== "media") ||
    (track.kind === "overlay" && clip.kind !== "media") ||
    (track.kind === "text" && clip.kind !== "text") ||
    (track.kind === "captions" && clip.kind !== "caption")
  ) {
    fail("TRACK_INCOMPATIBLE", `Clip kind ${clip.kind} is not valid on ${track.kind} track ${track.id}.`);
  }
  if (clip.kind !== "media") return;
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset) fail("ASSET_NOT_FOUND", `Asset ${clip.assetId} does not exist.`);
  if (
    (track.kind === "video" && asset.kind !== "video") ||
    (track.kind === "audio" && asset.kind !== "audio") ||
    (track.kind === "overlay" && asset.kind !== "video" && asset.kind !== "image")
  ) {
    fail("TRACK_INCOMPATIBLE", `Asset ${asset.id} is not valid on ${track.kind} track ${track.id}.`);
  }
}

function assertMediaSourceBounds(
  project: ProjectDocumentV1,
  clip: MediaClip,
): void {
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset) fail("ASSET_NOT_FOUND", `Asset ${clip.assetId} does not exist.`);
  const assetDuration = asset.original.duration;
  if (assetDuration && compare(clip.sourceOut, assetDuration) > 0) {
    fail("INVALID_SOURCE_RANGE", `Clip ${clip.id} exceeds asset ${asset.id}'s known duration.`);
  }
}

function replaceTrack(
  project: ProjectDocumentV1,
  trackId: string,
  update: (track: Track) => Track,
): ProjectDocumentV1["tracks"] {
  let found = false;
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track;
    found = true;
    return update(track);
  });
  if (!found) fail("TRACK_NOT_FOUND", `Track ${trackId} does not exist.`);
  return tracks;
}

function replaceClip(
  track: Track,
  clipIndex: number,
  replacements: ProjectClip[],
): Track {
  return {
    ...track,
    clips: [
      ...track.clips.slice(0, clipIndex),
      ...replacements,
      ...track.clips.slice(clipIndex + 1),
    ],
  };
}

function adjustKeyframesAfterStartTrim(
  keyframes: MediaClip["keyframes"],
  removedDuration: Rational,
): MediaClip["keyframes"] {
  return keyframes
    .filter((keyframe) => compare(keyframe.time, removedDuration) >= 0)
    .map((keyframe) => ({...keyframe, time: subtract(keyframe.time, removedDuration)}));
}

function adjustKeyframesForEnd(
  keyframes: MediaClip["keyframes"],
  keptDuration: Rational,
): MediaClip["keyframes"] {
  return keyframes.filter((keyframe) => compare(keyframe.time, keptDuration) <= 0);
}

function rescaleKeyframes(
  keyframes: MediaClip["keyframes"],
  oldDuration: Rational,
  newDuration: Rational,
): MediaClip["keyframes"] {
  return keyframes.map((keyframe) => ({
    ...keyframe,
    time: multiply(keyframe.time, divide(newDuration, oldDuration)),
  }));
}

function splitKeyframes(
  keyframes: MediaClip["keyframes"],
  splitOffset: Rational,
): {left: MediaClip["keyframes"]; right: MediaClip["keyframes"]} {
  return {
    left: keyframes.filter((keyframe) => compare(keyframe.time, splitOffset) <= 0),
    right: keyframes
      .filter((keyframe) => compare(keyframe.time, splitOffset) > 0)
      .map((keyframe) => ({...keyframe, time: subtract(keyframe.time, splitOffset)})),
  };
}

function splitClip(
  project: ProjectDocumentV1,
  clip: ProjectClip,
  at: MediaTime,
  rightClipId: string,
  captionText?: CaptionSplit,
): [ProjectClip, ProjectClip] {
  if (
    compare(at, clip.timelineStart) <= 0 ||
    compare(at, clip.timelineEnd) >= 0
  ) {
    fail("INVALID_TIMING", "Split point must be strictly inside the clip.");
  }
  const splitOffset = timeFromClipStart(clip, at);
  const keyframes = splitKeyframes(clip.keyframes, splitOffset);
  if (clip.kind === "media") {
    const sourcePoint = sourceAt(clip, at);
    return [
      {...clip, timelineEnd: at, sourceOut: sourcePoint, keyframes: keyframes.left},
      {
        ...clip,
        id: rightClipId,
        timelineStart: at,
        sourceIn: sourcePoint,
        keyframes: keyframes.right,
      },
    ];
  }
  if (clip.kind === "caption" && !captionText) {
    fail("CAPTION_TEXT_REQUIRED", "Caption split requires explicit leftText and rightText.");
  }
  if (clip.kind !== "caption" && captionText) {
    fail("INVALID_COMMAND", "captionText is only valid when splitting a caption clip.");
  }
  return [
    {
      ...clip,
      timelineEnd: at,
      content: captionText?.leftText ?? clip.content,
      keyframes: keyframes.left,
    },
    {
      ...clip,
      id: rightClipId,
      timelineStart: at,
      content: captionText?.rightText ?? clip.content,
      keyframes: keyframes.right,
    },
  ];
}

function applyRippleDelete(
  project: ProjectDocumentV1,
  track: Track,
  start: MediaTime,
  end: MediaTime,
  rightClipIds: Record<string, string>,
  captionSplits: Record<string, CaptionSplit>,
): Track {
  if (compare(start, end) >= 0) fail("INVALID_TIMING", "Ripple-delete end must follow start.");
  const removedDuration = duration(start, end);
  const idsInUse = clipIds(project);
  const usedGeneratedIds = new Set<string>();
  const usedRightClipIds = new Set<string>();
  const usedCaptionSplits = new Set<string>();
  const clips: ProjectClip[] = [];

  for (const clip of track.clips) {
    if (compare(clip.timelineEnd, start) <= 0) {
      clips.push(clip);
      continue;
    }
    if (compare(clip.timelineStart, end) >= 0) {
      clips.push({
        ...clip,
        timelineStart: subtract(clip.timelineStart, removedDuration),
        timelineEnd: subtract(clip.timelineEnd, removedDuration),
      });
      continue;
    }

    const hasLeft = compare(clip.timelineStart, start) < 0;
    const hasRight = compare(clip.timelineEnd, end) > 0;
    if (!hasLeft && !hasRight) continue;

    const leftEnd = hasLeft ? start : null;
    const rightStart = hasRight
      ? subtract(compare(clip.timelineStart, end) > 0 ? clip.timelineStart : end, removedDuration)
      : null;
    const rightEnd = hasRight ? subtract(clip.timelineEnd, removedDuration) : null;
    const leftSourceOut = hasLeft && clip.kind === "media" ? sourceAt(clip, start) : null;
    const rightSourceIn = hasRight && clip.kind === "media"
      ? sourceAt(clip, compare(clip.timelineStart, end) > 0 ? clip.timelineStart : end)
      : null;
    const leftKeyframes = hasLeft
      ? clip.keyframes.filter((keyframe) =>
          compare(keyframe.time, duration(clip.timelineStart, start)) <= 0)
      : [];
    const rightOffset = hasRight
      ? duration(clip.timelineStart, compare(clip.timelineStart, end) > 0 ? clip.timelineStart : end)
      : null;
    const rightKeyframes = hasRight && rightOffset
      ? clip.keyframes
          .filter((keyframe) => compare(keyframe.time, rightOffset) >= 0)
          .map((keyframe) => ({...keyframe, time: subtract(keyframe.time, rightOffset)}))
      : [];

    if (hasLeft && hasRight) {
      const newId = rightClipIds[clip.id];
      if (!newId) {
        fail("INVALID_COMMAND", `Ripple-delete requires a deterministic right clip ID for ${clip.id}.`);
      }
      if (idsInUse.has(newId) || usedGeneratedIds.has(newId)) {
        fail("ID_COLLISION", `Generated clip ID ${newId} already exists.`);
      }
      usedGeneratedIds.add(newId);
      usedRightClipIds.add(clip.id);
      let leftText: string | undefined;
      let rightText: string | undefined;
      if (clip.kind === "caption") {
        const captionSplit = captionSplits[clip.id];
        if (!captionSplit) {
          fail("CAPTION_TEXT_REQUIRED", `Ripple split of caption ${clip.id} requires explicit leftText and rightText.`);
        }
        usedCaptionSplits.add(clip.id);
        leftText = captionSplit.leftText;
        rightText = captionSplit.rightText;
      }
      if (clip.kind === "media") {
        clips.push({
          ...clip,
          timelineEnd: leftEnd!,
          sourceOut: leftSourceOut!,
          keyframes: leftKeyframes,
        });
        clips.push({
          ...clip,
          id: newId,
          timelineStart: rightStart!,
          timelineEnd: rightEnd!,
          sourceIn: rightSourceIn!,
          keyframes: rightKeyframes,
        });
      } else {
        clips.push({
          ...clip,
          timelineEnd: leftEnd!,
          content: leftText ?? clip.content,
          keyframes: leftKeyframes,
        });
        clips.push({
          ...clip,
          id: newId,
          timelineStart: rightStart!,
          timelineEnd: rightEnd!,
          content: rightText ?? clip.content,
          keyframes: rightKeyframes,
        });
      }
      continue;
    }

    if (hasLeft) {
      if (clip.kind === "media") {
        clips.push({
          ...clip,
          timelineEnd: leftEnd!,
          sourceOut: leftSourceOut!,
          keyframes: leftKeyframes,
        });
      } else {
        clips.push({...clip, timelineEnd: leftEnd!, keyframes: leftKeyframes});
      }
      continue;
    }

    if (clip.kind === "media") {
      clips.push({
        ...clip,
        timelineStart: rightStart!,
        timelineEnd: rightEnd!,
        sourceIn: rightSourceIn!,
        keyframes: rightKeyframes,
      });
    } else {
      clips.push({...clip, timelineStart: rightStart!, timelineEnd: rightEnd!, keyframes: rightKeyframes});
    }
  }

  for (const id of Object.keys(rightClipIds)) {
    if (!usedRightClipIds.has(id)) {
      fail("UNUSED_GENERATED_ID", `rightClipIds entry for ${id} was not used.`);
    }
  }
  for (const id of Object.keys(captionSplits)) {
    if (!usedCaptionSplits.has(id)) {
      fail("UNUSED_GENERATED_ID", `captionSplits entry for ${id} was not used.`);
    }
  }
  return {...track, clips};
}

function resultingProject(
  project: ProjectDocumentV1,
  command: ProjectCommand,
  tracks: Track[],
  assets = project.assets,
): CommandResult {
  if (project.revision === Number.MAX_SAFE_INTEGER) {
    fail("REVISION_OVERFLOW", "Project revision cannot be incremented safely.");
  }
  const candidate: ProjectDocumentV1 = {
    ...project,
    revision: project.revision + 1,
    assets,
    tracks,
  };
  const result = ProjectDocumentV1Schema.safeParse(candidate);
  if (!result.success) {
    fail("INVALID_PROJECT", "Command would produce an invalid project.", result.error.issues);
  }
  return {project: structuredClone(result.data), command};
}

function runCommand(project: ProjectDocumentV1, command: ProjectCommand): CommandResult {
  switch (command.type) {
    case "split-clip": {
      const track = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(track, command.payload.clipId);
      assertNewClipId(project, command.payload.rightClipId);
      const replacements = splitClip(
        project,
        clip,
        command.payload.at,
        command.payload.rightClipId,
        command.payload.captionText,
      );
      return resultingProject(
        project,
        command,
        replaceTrack(project, track.id, (current) => replaceClip(current, index, replacements)),
      );
    }
    case "trim-clip-start": {
      const track = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(track, command.payload.clipId);
      if (compare(command.payload.timelineStart, clip.timelineStart) <= 0 ||
        compare(command.payload.timelineStart, clip.timelineEnd) >= 0) {
        fail("INVALID_TIMING", "Trimmed start must be inside the clip and leave positive duration.");
      }
      const removedDuration = duration(clip.timelineStart, command.payload.timelineStart);
      const updated: ProjectClip = clip.kind === "media"
        ? {
            ...clip,
            timelineStart: command.payload.timelineStart,
            sourceIn: sourceAt(clip, command.payload.timelineStart),
            keyframes: adjustKeyframesAfterStartTrim(clip.keyframes, removedDuration),
          }
        : {
            ...clip,
            timelineStart: command.payload.timelineStart,
            keyframes: adjustKeyframesAfterStartTrim(clip.keyframes, removedDuration),
          };
      if (updated.kind === "media") assertMediaSourceBounds(project, updated);
      return resultingProject(
        project,
        command,
        replaceTrack(project, track.id, (current) => replaceClip(current, index, [updated])),
      );
    }
    case "trim-clip-end": {
      const track = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(track, command.payload.clipId);
      if (compare(command.payload.timelineEnd, clip.timelineStart) <= 0 ||
        compare(command.payload.timelineEnd, clip.timelineEnd) >= 0) {
        fail("INVALID_TIMING", "Trimmed end must be inside the clip and leave positive duration.");
      }
      const keptDuration = duration(clip.timelineStart, command.payload.timelineEnd);
      const updated: ProjectClip = clip.kind === "media"
        ? {
            ...clip,
            timelineEnd: command.payload.timelineEnd,
            sourceOut: sourceAt(clip, command.payload.timelineEnd),
            keyframes: adjustKeyframesForEnd(clip.keyframes, keptDuration),
          }
        : {
            ...clip,
            timelineEnd: command.payload.timelineEnd,
            keyframes: adjustKeyframesForEnd(clip.keyframes, keptDuration),
          };
      if (updated.kind === "media") assertMediaSourceBounds(project, updated);
      return resultingProject(
        project,
        command,
        replaceTrack(project, track.id, (current) => replaceClip(current, index, [updated])),
      );
    }
    case "move-clip": {
      const sourceTrack = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(sourceTrack, command.payload.clipId);
      const destinationTrack = findTrack(
        project,
        command.payload.destinationTrackId ?? sourceTrack.id,
      );
      assertTrackAcceptsClip(destinationTrack, clip, project);
      const offset = subtract(command.payload.timelineStart, clip.timelineStart);
      const moved: ProjectClip = {
        ...clip,
        timelineStart: command.payload.timelineStart,
        timelineEnd: add(clip.timelineEnd, offset),
      };
      if (compare(moved.timelineEnd, moved.timelineStart) <= 0) {
        fail("INVALID_TIMING", "Move would produce an invalid timeline interval.");
      }
      if (destinationTrack.id === sourceTrack.id) {
        return resultingProject(
          project,
          command,
          replaceTrack(project, sourceTrack.id, (current) => replaceClip(current, index, [moved])),
        );
      }
      const sourceUpdated: Track = {
        ...sourceTrack,
        clips: sourceTrack.clips.filter((_, clipIndex) => clipIndex !== index),
      };
      const destinationUpdated: Track = {
        ...destinationTrack,
        clips: [...destinationTrack.clips, moved],
      };
      return resultingProject(project, command, project.tracks.map((track) =>
        track.id === sourceTrack.id ? sourceUpdated
          : track.id === destinationTrack.id ? destinationUpdated
            : track));
    }
    case "delete-clip":
    case "remove-media-clip": {
      const track = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(track, command.payload.clipId);
      if (command.type === "remove-media-clip" && clip.kind !== "media") {
        fail("CLIP_NOT_FOUND", `Clip ${clip.id} is not a media clip.`);
      }
      return resultingProject(
        project,
        command,
        replaceTrack(project, track.id, (current) => ({
          ...current,
          clips: current.clips.filter((_, clipIndex) => clipIndex !== index),
        })),
      );
    }
    case "ripple-delete": {
      const track = findTrack(project, command.payload.trackId);
      const updated = applyRippleDelete(
        project,
        track,
        command.payload.start,
        command.payload.end,
        command.payload.rightClipIds,
        command.payload.captionSplits,
      );
      return resultingProject(project, command, replaceTrack(project, track.id, () => updated));
    }
    case "change-clip-speed": {
      const track = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(track, command.payload.clipId);
      if (clip.kind !== "media") fail("TRACK_INCOMPATIBLE", "Playback speed can only be changed on media clips.");
      if (clip.timingStatus === "legacy-mismatch") {
        fail("LEGACY_MISMATCH_UNSUPPORTED", "Speed changes are not supported for legacy-mismatch clips.");
      }
      let updated: MediaClip;
      if (command.payload.policy === "preserve-source-range") {
        const sourceDuration = duration(clip.sourceIn, clip.sourceOut);
        const timelineDuration = divide(sourceDuration, command.payload.speed);
        assertPositive(timelineDuration, "Speed change would produce a non-positive timeline duration.");
        const oldDuration = duration(clip.timelineStart, clip.timelineEnd);
        updated = {
          ...clip,
          speed: command.payload.speed,
          timelineEnd: add(clip.timelineStart, timelineDuration),
          keyframes: rescaleKeyframes(clip.keyframes, oldDuration, timelineDuration),
        };
      } else {
        const timelineDuration = duration(clip.timelineStart, clip.timelineEnd);
        const sourceDuration = multiply(timelineDuration, command.payload.speed);
        assertPositive(sourceDuration, "Speed change would produce a non-positive source duration.");
        const sourceOut = add(clip.sourceIn, sourceDuration);
        updated = {...clip, speed: command.payload.speed, sourceOut};
        assertMediaSourceBounds(project, updated);
      }
      return resultingProject(
        project,
        command,
        replaceTrack(project, track.id, (current) => replaceClip(current, index, [updated])),
      );
    }
    case "update-clip-properties": {
      const track = findTrack(project, command.payload.trackId);
      const {index, clip} = findClip(track, command.payload.clipId);
      let updated: ProjectClip;
      if (command.payload.patch.kind === "media") {
        if (clip.kind !== "media") fail("TRACK_INCOMPATIBLE", "Media properties require a media clip.");
        updated = {
          ...clip,
          properties: {...clip.properties, ...command.payload.patch.updates.properties},
        };
      } else {
        if (clip.kind !== command.payload.patch.kind) {
          fail("TRACK_INCOMPATIBLE", `Text updates require a ${command.payload.patch.kind} clip.`);
        }
        updated = {
          ...clip,
          ...(command.payload.patch.updates.content === undefined
            ? {}
            : {content: command.payload.patch.updates.content}),
          ...(command.payload.patch.updates.style === undefined
            ? {}
            : {style: {...clip.style, ...command.payload.patch.updates.style}}),
        };
      }
      return resultingProject(
        project,
        command,
        replaceTrack(project, track.id, (current) => replaceClip(current, index, [updated])),
      );
    }
    case "add-track": {
      const {track} = command.payload;
      if (project.tracks.some((candidate) => candidate.id === track.id)) {
        fail("ID_COLLISION", `Track ID ${track.id} already exists.`);
      }
      if (project.tracks.some((candidate) => candidate.order === track.order)) {
        fail("TRACK_ORDER_COLLISION", `Track order ${track.order} already exists.`);
      }
      return resultingProject(project, command, [...project.tracks, track]);
    }
    case "remove-track": {
      const track = findTrack(project, command.payload.trackId);
      if (track.clips.length > 0 && !command.payload.removeContents) {
        fail("TRACK_NOT_EMPTY", `Track ${track.id} contains clips; explicit removal acknowledgement is required.`);
      }
      return resultingProject(
        project,
        command,
        project.tracks.filter((candidate) => candidate.id !== track.id),
      );
    }
    case "add-media-clip": {
      const track = findTrack(project, command.payload.trackId);
      assertNewClipId(project, command.payload.clip.id);
      assertTrackAcceptsClip(track, command.payload.clip, project);
      assertMediaSourceBounds(project, command.payload.clip);
      return resultingProject(project, command, replaceTrack(project, track.id, (current) => ({
        ...current,
        clips: [...current.clips, command.payload.clip],
      })));
    }
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

export function applyProjectCommand(
  project: ProjectDocumentV1,
  input: unknown,
): CommandResult {
  assertJsonValue(input);
  const parsed = ProjectCommandSchema.safeParse(input);
  if (!parsed.success) {
    fail("INVALID_COMMAND", "Project command payload is invalid.", parsed.error.issues);
  }
  if (parsed.data.expectedRevision !== project.revision) {
    fail(
      "STALE_REVISION",
      `Command expected revision ${parsed.data.expectedRevision}, but project is at revision ${project.revision}.`,
      {expectedRevision: parsed.data.expectedRevision, actualRevision: project.revision},
    );
  }
  return runCommand(project, parsed.data);
}
