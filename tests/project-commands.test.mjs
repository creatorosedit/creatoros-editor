import assert from "node:assert/strict";
import {test} from "node:test";
import {applyProjectCommand} from "../src/lib/editor/commands/engine.ts";
import {ProjectCommandError} from "../src/lib/editor/commands/types.ts";
import {PROJECT_SCHEMA_VERSION} from "../src/lib/editor/project.ts";

const r = (numerator, denominator = 1) => ({numerator, denominator});
const asset = (id, kind = "video", duration = r(100)) => ({
  id,
  kind,
  original: {
    filename: `${id}.media`,
    mimeType: null,
    duration,
    width: null,
    height: null,
    sourceTimebase: null,
    frameRate: null,
  },
  localMediaKey: null,
  proxyMediaKey: null,
  availability: "available",
});
const mediaClip = (overrides = {}) => ({
  id: "media-1",
  kind: "media",
  assetId: "video-asset",
  timelineStart: r(2),
  timelineEnd: r(6),
  sourceIn: r(10),
  sourceOut: r(18),
  speed: r(2),
  timingStatus: "consistent",
  properties: {volume: 1, effects: []},
  keyframes: [
    {id: "kf-before", property: "opacity", time: r(1), value: 0.5, interpolation: "linear"},
    {id: "kf-after", property: "opacity", time: r(3), value: 1, interpolation: "hold"},
  ],
  ...overrides,
});
const textClip = (id = "text-1", kind = "text", start = 2, end = 6, overrides = {}) => ({
  id,
  kind,
  timelineStart: r(start),
  timelineEnd: r(end),
  content: "Title",
  style: {color: "white"},
  keyframes: [
    {id: `${id}-kf-1`, property: "opacity", time: r(1), value: 0.5, interpolation: "linear"},
    {id: `${id}-kf-2`, property: "opacity", time: r(3), value: 1, interpolation: "hold"},
  ],
  ...overrides,
});
const track = (id, kind, clips = [], order = 0) => ({
  id,
  kind,
  name: id,
  order,
  locked: false,
  muted: false,
  hidden: false,
  clips,
});
const baseProject = () => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: "project-1",
  revision: 0,
  metadata: {name: "Test", aspectRatio: "16:9", createdAt: null, updatedAt: null},
  settings: {frameRate: r(25), width: 1920, height: 1080},
  assets: [asset("video-asset"), asset("audio-asset", "audio"), asset("image-asset", "image")],
  tracks: [
    track("video", "video", [mediaClip()], 0),
    track("audio", "audio", [], 1),
    track("text", "text", [textClip()], 2),
    track("captions", "captions", [textClip("caption-1", "caption")], 3),
    track("overlay", "overlay", [], 4),
  ],
});
const command = (type, payload, expectedRevision = 0, commandId = "command-1") => ({
  schemaVersion: 1,
  commandId,
  expectedRevision,
  type,
  payload,
});
const apply = (project, type, payload, commandId = "command-1") =>
  applyProjectCommand(project, command(type, payload, project.revision, commandId));
const findTrack = (project, id) => project.tracks.find((entry) => entry.id === id);
const findClip = (project, trackId, id) => findTrack(project, trackId).clips.find((entry) => entry.id === id);
const assertCommandError = (callback, code) => {
  assert.throws(callback, (error) =>
    error instanceof ProjectCommandError && error.code === code);
};

test("split media uses rational source mapping and caller-provided stable IDs", () => {
  const project = baseProject();
  const {project: result} = apply(project, "split-clip", {
    trackId: "video",
    clipId: "media-1",
    at: r(3),
    rightClipId: "media-1-right",
  });
  assert.deepEqual(findTrack(result, "video").clips.map((clip) => clip.id), [
    "media-1",
    "media-1-right",
  ]);
  assert.deepEqual(findClip(result, "video", "media-1").sourceOut, r(12));
  assert.deepEqual(findClip(result, "video", "media-1-right").sourceIn, r(12));
  assert.deepEqual(findClip(result, "video", "media-1-right").timelineStart, r(3));
  assert.deepEqual(findClip(result, "video", "media-1-right").properties, mediaClip().properties);
  assert.deepEqual(findClip(result, "video", "media-1-right").keyframes.map((keyframe) => keyframe.time), [r(2)]);
  assert.equal(result.revision, 1);
  assert.equal(project.revision, 0);
});

test("split rejects boundary points and collisions without mutating input", () => {
  const project = baseProject();
  const before = structuredClone(project);
  assertCommandError(() => apply(project, "split-clip", {
    trackId: "video", clipId: "media-1", at: r(2), rightClipId: "right",
  }), "INVALID_TIMING");
  assertCommandError(() => apply(project, "split-clip", {
    trackId: "video", clipId: "media-1", at: r(3), rightClipId: "text-1",
  }), "ID_COLLISION");
  assert.deepEqual(project, before);
});

test("split text copies content/style and partitions and rebases keyframes", () => {
  const project = baseProject();
  const {project: result} = apply(project, "split-clip", {
    trackId: "text", clipId: "text-1", at: r(3), rightClipId: "text-right",
  });
  const left = findClip(result, "text", "text-1");
  const right = findClip(result, "text", "text-right");
  assert.equal(left.content, right.content);
  assert.deepEqual(left.style, right.style);
  assert.deepEqual(left.keyframes.map((keyframe) => keyframe.time), [r(1)]);
  assert.deepEqual(right.keyframes.map((keyframe) => keyframe.time), [r(2)]);
});

test("caption split requires and uses explicit left and right text", () => {
  const project = baseProject();
  assertCommandError(() => apply(project, "split-clip", {
    trackId: "captions", clipId: "caption-1", at: r(3), rightClipId: "caption-right",
  }), "CAPTION_TEXT_REQUIRED");
  const {project: result} = apply(project, "split-clip", {
    trackId: "captions",
    clipId: "caption-1",
    at: r(3),
    rightClipId: "caption-right",
    captionText: {leftText: "First phrase", rightText: "Second phrase"},
  });
  assert.equal(findClip(result, "captions", "caption-1").content, "First phrase");
  assert.equal(findClip(result, "captions", "caption-right").content, "Second phrase");
});

test("trim start and end update media source positions exactly and preserve properties", () => {
  const project = baseProject();
  const startTrim = apply(project, "trim-clip-start", {
    trackId: "video", clipId: "media-1", timelineStart: r(3),
  }).project;
  assert.deepEqual(findClip(startTrim, "video", "media-1").sourceIn, r(12));
  assert.deepEqual(findClip(startTrim, "video", "media-1").timelineEnd, r(6));
  assert.deepEqual(findClip(startTrim, "video", "media-1").keyframes.map((keyframe) => keyframe.time), [r(0), r(2)]);
  const endTrim = apply(project, "trim-clip-end", {
    trackId: "video", clipId: "media-1", timelineEnd: r(5),
  }).project;
  assert.deepEqual(findClip(endTrim, "video", "media-1").sourceOut, r(16));
  assert.deepEqual(findClip(endTrim, "video", "media-1").keyframes.map((keyframe) => keyframe.id), ["kf-before", "kf-after"]);
  assert.deepEqual(findClip(endTrim, "video", "media-1").properties, mediaClip().properties);
});

test("trim supports text and rejects zero-duration or out-of-clip trims", () => {
  const project = baseProject();
  const result = apply(project, "trim-clip-start", {
    trackId: "text", clipId: "text-1", timelineStart: r(3),
  }).project;
  assert.deepEqual(findClip(result, "text", "text-1").timelineStart, r(3));
  assert.deepEqual(findClip(result, "text", "text-1").keyframes.map((keyframe) => keyframe.time), [r(0), r(2)]);
  assertCommandError(() => apply(project, "trim-clip-end", {
    trackId: "video", clipId: "media-1", timelineEnd: r(2),
  }), "INVALID_TIMING");
});

test("move changes only the target clip and supports compatible cross-track moves", () => {
  const project = baseProject();
  const beforeAudio = structuredClone(findTrack(project, "audio"));
  const moved = apply(project, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  }).project;
  assert.deepEqual(findClip(moved, "video", "media-1").timelineStart, r(10));
  assert.deepEqual(findClip(moved, "video", "media-1").timelineEnd, r(14));
  assert.deepEqual(findTrack(moved, "audio"), beforeAudio);

  const transferred = apply(project, "move-clip", {
    trackId: "video",
    clipId: "media-1",
    timelineStart: r(10),
    destinationTrackId: "overlay",
  }).project;
  assert.equal(findTrack(transferred, "video").clips.length, 0);
  assert.deepEqual(findClip(transferred, "overlay", "media-1").timelineStart, r(10));
  assertCommandError(() => apply(project, "move-clip", {
    trackId: "video",
    clipId: "media-1",
    timelineStart: r(10),
    destinationTrackId: "text",
  }), "TRACK_INCOMPATIBLE");
});

test("move preserves legacy mismatch status and rejects negative resulting times", () => {
  const project = baseProject();
  findTrack(project, "video").clips[0].timingStatus = "legacy-mismatch";
  const moved = apply(project, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  }).project;
  assert.equal(findClip(moved, "video", "media-1").timingStatus, "legacy-mismatch");
  assertCommandError(() => apply(project, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(-1),
  }), "INVALID_COMMAND");
});

test("ordinary delete leaves a gap while ripple delete changes only its explicit track", () => {
  const project = baseProject();
  const deleted = apply(project, "delete-clip", {trackId: "video", clipId: "media-1"}).project;
  assert.equal(findTrack(deleted, "video").clips.length, 0);
  assert.equal(findTrack(deleted, "audio").clips.length, 0);

  const withNeighbor = structuredClone(project);
  findTrack(withNeighbor, "video").clips.push(mediaClip({
    id: "later",
    timelineStart: r(10),
    timelineEnd: r(14),
    sourceIn: r(30),
    sourceOut: r(38),
  }));
  const beforeOtherTrack = structuredClone(findTrack(withNeighbor, "audio"));
  const rippled = apply(withNeighbor, "ripple-delete", {
    trackId: "video", start: r(2), end: r(6), rightClipIds: {}, captionSplits: {},
  }).project;
  assert.deepEqual(findTrack(rippled, "video").clips.map((clip) => clip.timelineStart), [r(6)]);
  assert.deepEqual(findTrack(rippled, "audio"), beforeOtherTrack);
  assert.deepEqual(findClip(rippled, "video", "later").timelineEnd, r(10));
});

test("ripple delete preserves gaps/overlaps and handles all boundary relationships", () => {
  const project = baseProject();
  const clips = [
    mediaClip({id: "before", timelineStart: r(0), timelineEnd: r(2), sourceIn: r(0), sourceOut: r(2), speed: r(1), keyframes: []}),
    mediaClip({id: "inside", timelineStart: r(3), timelineEnd: r(5), sourceIn: r(10), sourceOut: r(12), speed: r(1), keyframes: []}),
    mediaClip({id: "cross-start", timelineStart: r(5), timelineEnd: r(7), sourceIn: r(20), sourceOut: r(22), speed: r(1), keyframes: []}),
    mediaClip({id: "cross-end", timelineStart: r(2), timelineEnd: r(4), sourceIn: r(30), sourceOut: r(32), speed: r(1), keyframes: []}),
    mediaClip({id: "spanning", timelineStart: r(1), timelineEnd: r(8), sourceIn: r(40), sourceOut: r(47), speed: r(1), keyframes: []}),
    mediaClip({id: "after", timelineStart: r(7), timelineEnd: r(9), sourceIn: r(50), sourceOut: r(52), speed: r(1), keyframes: []}),
  ];
  findTrack(project, "video").clips = clips;
  const result = apply(project, "ripple-delete", {
    trackId: "video",
    start: r(3),
    end: r(6),
    rightClipIds: {spanning: "spanning-right"},
    captionSplits: {},
  }).project;
  const actual = findTrack(result, "video").clips;
  assert.deepEqual(actual.map((clip) => [clip.id, clip.timelineStart, clip.timelineEnd]), [
    ["before", r(0), r(2)],
    ["cross-start", r(3), r(4)],
    ["cross-end", r(2), r(3)],
    ["spanning", r(1), r(3)],
    ["spanning-right", r(3), r(5)],
    ["after", r(4), r(6)],
  ]);
  assert.deepEqual(findClip(result, "video", "cross-end").sourceOut, r(31));
  assert.deepEqual(findClip(result, "video", "cross-start").sourceIn, r(21));
  assert.deepEqual(findClip(result, "video", "spanning-right").sourceIn, r(45));
});

test("ripple delete preserves retained endpoint keyframes and discards deleted ones", () => {
  const project = baseProject();
  const keyframes = [
    {id: "before-start", property: "opacity", time: r(39, 10), value: 0.1, interpolation: "linear"},
    {id: "at-start", property: "opacity", time: r(4), value: 0.2, interpolation: "hold"},
    {id: "inside-before", property: "opacity", time: r(41, 10), value: 0.3, interpolation: "linear"},
    {id: "inside-middle", property: "opacity", time: r(5), value: 0.4, interpolation: "hold"},
    {id: "inside-after", property: "opacity", time: r(59, 10), value: 0.5, interpolation: "linear"},
    {id: "at-end", property: "opacity", time: r(6), value: 0.6, interpolation: "hold"},
    {id: "after-end", property: "opacity", time: r(61, 10), value: 0.7, interpolation: "linear"},
  ];
  findTrack(project, "video").clips = [mediaClip({
    timelineStart: r(0),
    timelineEnd: r(10),
    sourceIn: r(0),
    sourceOut: r(10),
    speed: r(1),
    keyframes,
  })];

  const result = apply(project, "ripple-delete", {
    trackId: "video",
    start: r(4),
    end: r(6),
    rightClipIds: {"media-1": "media-1-right"},
    captionSplits: {},
  }).project;

  assert.deepEqual(
    findClip(result, "video", "media-1").keyframes,
    [keyframes[0], keyframes[1]],
  );
  assert.deepEqual(
    findClip(result, "video", "media-1-right").keyframes,
    [
      {...keyframes[5], time: r(0)},
      {...keyframes[6], time: r(1, 10)},
    ],
  );
});

test("ripple rejects missing/colliding/unused deterministic IDs and invalid ranges", () => {
  const project = baseProject();
  assertCommandError(() => apply(project, "ripple-delete", {
    trackId: "video", start: r(3), end: r(5), rightClipIds: {}, captionSplits: {},
  }), "INVALID_COMMAND");
  assertCommandError(() => apply(project, "ripple-delete", {
    trackId: "video", start: r(3), end: r(5),
    rightClipIds: {"media-1": "text-1"}, captionSplits: {},
  }), "ID_COLLISION");
  assertCommandError(() => apply(project, "ripple-delete", {
    trackId: "video", start: r(3), end: r(5),
    rightClipIds: {"media-1": "media-right", unused: "unused-right"},
    captionSplits: {},
  }), "UNUSED_GENERATED_ID");
  assertCommandError(() => apply(project, "ripple-delete", {
    trackId: "video", start: r(5), end: r(5), rightClipIds: {}, captionSplits: {},
  }), "INVALID_TIMING");
});

test("ripple splits captions only with supplied text and keeps their track isolated", () => {
  const project = baseProject();
  const result = apply(project, "ripple-delete", {
    trackId: "captions",
    start: r(3),
    end: r(5),
    rightClipIds: {"caption-1": "caption-right"},
    captionSplits: {"caption-1": {leftText: "Left", rightText: "Right"}},
  }).project;
  assert.equal(findClip(result, "captions", "caption-1").content, "Left");
  assert.equal(findClip(result, "captions", "caption-right").content, "Right");
  assert.equal(findTrack(result, "video").clips.length, 1);
});

test("speed policies preserve the selected range exactly and reject legacy mismatches", () => {
  const project = baseProject();
  const sourcePreserved = apply(project, "change-clip-speed", {
    trackId: "video", clipId: "media-1", speed: r(4), policy: "preserve-source-range",
  }).project;
  assert.deepEqual(findClip(sourcePreserved, "video", "media-1").sourceOut, r(18));
  assert.deepEqual(findClip(sourcePreserved, "video", "media-1").timelineEnd, r(4));
  assert.deepEqual(
    findClip(sourcePreserved, "video", "media-1").keyframes.map((keyframe) => keyframe.time),
    [r(1, 2), r(3, 2)],
  );

  const timelinePreserved = apply(project, "change-clip-speed", {
    trackId: "video", clipId: "media-1", speed: r(1, 2), policy: "preserve-timeline-range",
  }).project;
  assert.deepEqual(findClip(timelinePreserved, "video", "media-1").timelineEnd, r(6));
  assert.deepEqual(findClip(timelinePreserved, "video", "media-1").sourceOut, r(12));

  const mismatch = structuredClone(project);
  findTrack(mismatch, "video").clips[0].timingStatus = "legacy-mismatch";
  assertCommandError(() => apply(mismatch, "change-clip-speed", {
    trackId: "video", clipId: "media-1", speed: r(1), policy: "preserve-source-range",
  }), "LEGACY_MISMATCH_UNSUPPORTED");
});

test("position/property edits preserve mismatch status; timing splits preserve it too", () => {
  const project = baseProject();
  findTrack(project, "video").clips[0].timingStatus = "legacy-mismatch";
  const props = apply(project, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  }).project;
  assert.equal(findClip(props, "video", "media-1").timingStatus, "legacy-mismatch");
  assert.equal(findClip(props, "video", "media-1").properties.volume, 0.5);
  const split = apply(project, "split-clip", {
    trackId: "video", clipId: "media-1", at: r(3), rightClipId: "right",
  }).project;
  assert.equal(findClip(split, "video", "media-1").timingStatus, "legacy-mismatch");
  assert.equal(findClip(split, "video", "right").timingStatus, "legacy-mismatch");
  const trimmed = apply(project, "trim-clip-end", {
    trackId: "video", clipId: "media-1", timelineEnd: r(5),
  }).project;
  assert.equal(findClip(trimmed, "video", "media-1").timingStatus, "legacy-mismatch");
});

test("updates text properties, and adds/removes tracks without reordering others", () => {
  const project = baseProject();
  const updated = apply(project, "update-clip-properties", {
    trackId: "text",
    clipId: "text-1",
    patch: {kind: "text", updates: {content: "Updated", style: {color: "cyan"}}},
  }).project;
  assert.equal(findClip(updated, "text", "text-1").content, "Updated");
  assert.deepEqual(findClip(updated, "text", "text-1").style, {color: "cyan"});

  const added = apply(project, "add-track", {
    track: {id: "text-2", kind: "text", name: "Titles 2", order: 5, locked: false, muted: false, hidden: false, clips: []},
  }).project;
  assert.equal(findTrack(added, "text").order, 2);
  assert.equal(findTrack(added, "text-2").order, 5);
  const removed = apply(added, "remove-track", {
    trackId: "text-2", removeContents: false,
  }).project;
  assert.equal(findTrack(removed, "text-2"), undefined);
  assertCommandError(() => apply(project, "add-track", {
    track: {id: "duplicate-order", kind: "text", name: "Duplicate", order: 2, locked: false, muted: false, hidden: false, clips: []},
  }), "TRACK_ORDER_COLLISION");
  assertCommandError(() => apply(project, "remove-track", {
    trackId: "text", removeContents: false,
  }), "TRACK_NOT_EMPTY");
});

test("adds/removes media clips and validates asset and track compatibility", () => {
  const project = baseProject();
  const clip = mediaClip({id: "added", timelineStart: r(20), timelineEnd: r(24), sourceIn: r(10), sourceOut: r(18)});
  const added = apply(project, "add-media-clip", {trackId: "video", clip}).project;
  assert.equal(findClip(added, "video", "added").assetId, "video-asset");
  const removed = apply(added, "remove-media-clip", {trackId: "video", clipId: "added"}).project;
  assert.equal(findClip(removed, "video", "added"), undefined);

  assertCommandError(() => apply(project, "add-media-clip", {
    trackId: "video", clip: {...clip, id: "missing", assetId: "no-asset"},
  }), "ASSET_NOT_FOUND");
  assertCommandError(() => apply(project, "add-media-clip", {
    trackId: "audio", clip: {...clip, id: "wrong-asset"},
  }), "TRACK_INCOMPATIBLE");
  assertCommandError(() => apply(project, "remove-media-clip", {
    trackId: "text", clipId: "text-1",
  }), "CLIP_NOT_FOUND");
});

test("rejects malformed, non-JSON, stale, and missing-target commands explicitly", () => {
  const project = baseProject();
  assertCommandError(() => applyProjectCommand(project, {
    ...command("delete-clip", {trackId: "video", clipId: "media-1"}),
    unexpected: true,
  }), "INVALID_COMMAND");
  assertCommandError(() => applyProjectCommand(project, {
    ...command("delete-clip", {trackId: "video", clipId: "media-1"}),
    payload: {trackId: "video", clipId: "media-1", callback() {}},
  }), "INVALID_COMMAND");
  assertCommandError(() => applyProjectCommand(project, command(
    "delete-clip", {trackId: "video", clipId: "media-1"}, 1,
  )), "STALE_REVISION");
  assertCommandError(() => apply(project, "delete-clip", {
    trackId: "no-track", clipId: "missing",
  }), "TRACK_NOT_FOUND");
  assertCommandError(() => apply(project, "delete-clip", {
    trackId: "video", clipId: "missing",
  }), "CLIP_NOT_FOUND");
});

test("exact rational calculations avoid floating point and reject unsafe results", () => {
  const project = baseProject();
  const rationalClip = mediaClip({
    timelineStart: r(0),
    timelineEnd: r(1),
    sourceIn: r(1, 3),
    sourceOut: r(1),
    speed: r(2, 3),
    keyframes: [],
  });
  findTrack(project, "video").clips = [rationalClip];
  const result = apply(project, "split-clip", {
    trackId: "video", clipId: "media-1", at: r(1, 2), rightClipId: "right",
  }).project;
  assert.deepEqual(findClip(result, "video", "media-1").sourceOut, r(2, 3));
  assert.deepEqual(findClip(result, "video", "right").sourceIn, r(2, 3));
  assertCommandError(() => apply(project, "move-clip", {
    trackId: "video",
    clipId: "media-1",
    timelineStart: r(Number.MAX_SAFE_INTEGER),
  }), "ARITHMETIC_OVERFLOW");
});

test("commands round-trip through JSON and successful execution increments once", () => {
  const project = baseProject();
  const original = command("move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(7, 2),
  });
  const serializedCommand = JSON.parse(JSON.stringify(original));
  const result = applyProjectCommand(project, serializedCommand);
  assert.deepEqual(result.command, original);
  assert.equal(result.project.revision, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.project)), result.project);
});

test("failed commands leave deeply frozen input unchanged", () => {
  const project = baseProject();
  const before = structuredClone(project);
  const freeze = (value) => {
    if (value && typeof value === "object") {
      Object.freeze(value);
      Object.values(value).forEach(freeze);
    }
    return value;
  };
  freeze(project);
  assertCommandError(() => apply(project, "trim-clip-start", {
    trackId: "video", clipId: "media-1", timelineStart: r(2),
  }), "INVALID_TIMING");
  assert.equal(project.revision, 0);
  assert.deepEqual(project, before);
});

test("successful command results are deeply isolated from input in both directions", () => {
  const project = baseProject();
  findClip(project, "video", "media-1").properties.effects = [{
    id: "effect-1",
    kind: "blur",
    parameters: {radius: 2},
  }];
  const originalBefore = structuredClone(project);
  const result = apply(project, "move-clip", {
    trackId: "video",
    clipId: "media-1",
    timelineStart: r(10),
  }).project;

  assert.notEqual(result, project);
  assert.notEqual(result.metadata, project.metadata);
  assert.notEqual(result.settings, project.settings);
  assert.notEqual(result.assets, project.assets);
  assert.notEqual(result.assets[0], project.assets[0]);
  assert.notEqual(result.assets[0].original, project.assets[0].original);
  assert.notEqual(result.tracks, project.tracks);
  assert.notEqual(findTrack(result, "audio"), findTrack(project, "audio"));
  assert.notEqual(findTrack(result, "video"), findTrack(project, "video"));
  assert.notEqual(findClip(result, "video", "media-1"), findClip(project, "video", "media-1"));
  assert.notEqual(
    findClip(result, "video", "media-1").keyframes,
    findClip(project, "video", "media-1").keyframes,
  );
  assert.notEqual(
    findClip(result, "video", "media-1").keyframes[0],
    findClip(project, "video", "media-1").keyframes[0],
  );
  assert.notEqual(
    findClip(result, "video", "media-1").properties.effects[0].parameters,
    findClip(project, "video", "media-1").properties.effects[0].parameters,
  );

  result.metadata.name = "changed in result";
  result.settings.frameRate.numerator = 30;
  result.assets[0].original.filename = "changed in result";
  findTrack(result, "audio").name = "changed in result";
  findClip(result, "video", "media-1").keyframes[0].value = 99;
  findClip(result, "video", "media-1").properties.effects[0].parameters.radius = 99;
  assert.deepEqual(project, originalBefore);
  const resultAfterMutation = structuredClone(result);

  project.metadata.name = "changed in input";
  project.settings.frameRate.denominator = 1;
  project.assets[0].original.filename = "changed in input";
  findTrack(project, "audio").name = "changed in input";
  findClip(project, "video", "media-1").keyframes[0].value = 100;
  findClip(project, "video", "media-1").properties.effects[0].parameters.radius = 100;
  assert.deepEqual(result, resultAfterMutation);
});

test("handles large metadata-only projects without an arbitrary clip count limit", () => {
  const project = baseProject();
  const template = mediaClip();
  findTrack(project, "video").clips = Array.from({length: 3_000}, (_, index) => ({
    ...template,
    id: `clip-${index}`,
    timelineStart: r(index * 10),
    timelineEnd: r(index * 10 + 4),
    sourceIn: r(10),
    sourceOut: r(18),
  }));
  const result = apply(project, "move-clip", {
    trackId: "video", clipId: "clip-2999", timelineStart: r(40_000),
  }).project;
  assert.equal(findTrack(result, "video").clips.length, 3_000);
  assert.deepEqual(findClip(result, "video", "clip-2999").timelineStart, r(40_000));
});
