import assert from "node:assert/strict";
import {test} from "node:test";
import {
  PROJECT_SCHEMA_VERSION,
  ProjectDocumentV1Schema,
  RationalSchema,
  UnsupportedProjectVersionError,
  compareRationals,
  parseProjectDocument,
  rationalFromNumber,
  rationalToNumber,
} from "../src/lib/editor/project.ts";

const project = {
  schemaVersion: PROJECT_SCHEMA_VERSION,
  id: "project-1",
  revision: 0,
  metadata: {
    name: "Test Project",
    aspectRatio: "16:9",
    createdAt: null,
    updatedAt: null,
  },
  settings: {
    frameRate: {numerator: 30000, denominator: 1001},
    width: 1920,
    height: 1080,
  },
  assets: [{
    id: "asset-1",
    kind: "video",
    original: {
      filename: "source.mp4",
      mimeType: "video/mp4",
      duration: {numerator: 60, denominator: 1},
      width: 1920,
      height: 1080,
      sourceTimebase: {numerator: 1, denominator: 90000},
      frameRate: {numerator: 30000, denominator: 1001},
    },
    localMediaKey: null,
    proxyMediaKey: null,
    availability: "unknown",
  }],
  tracks: [{
    id: "track-1",
    kind: "video",
    name: "Video 1",
    order: 0,
    locked: false,
    muted: false,
    hidden: false,
    clips: [{
      id: "clip-1",
      kind: "media",
      assetId: "asset-1",
      timelineStart: {numerator: 0, denominator: 1},
      timelineEnd: {numerator: 4, denominator: 1},
      sourceIn: {numerator: 10, denominator: 1},
      sourceOut: {numerator: 18, denominator: 1},
      speed: {numerator: 2, denominator: 1},
      timingStatus: "consistent",
      properties: {
        transform: {
          x: 0,
          y: 0,
          scaleX: 1,
          scaleY: 1,
          rotationDegrees: 0,
          opacity: 1,
        },
        volume: 1,
        effects: [],
      },
      keyframes: [],
    }],
  }],
};

function clone(value) {
  return structuredClone(value);
}

test("validates a versioned project with rational frame timing and media references", () => {
  const parsed = parseProjectDocument(project);
  assert.deepEqual(parsed, project);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(
    parseProjectDocument(JSON.parse(JSON.stringify(project))),
    project,
  );
});

test("allows empty projects and projects with large clip and track arrays", () => {
  const empty = clone(project);
  empty.assets = [];
  empty.tracks = [];
  empty.settings.frameRate = null;
  empty.settings.width = null;
  empty.settings.height = null;
  assert.equal(parseProjectDocument(empty).tracks.length, 0);

  const many = clone(project);
  const primaryClip = many.tracks[0].clips[0];
  many.tracks[0].clips = Array.from({length: 2_500}, (_, index) => ({
    ...primaryClip,
    id: `clip-${index}`,
    timelineStart: {numerator: index * 4, denominator: 1},
    timelineEnd: {numerator: index * 4 + 4, denominator: 1},
  }));
  many.tracks.push({
    id: "track-2",
    kind: "video",
    name: "Video 2",
    order: 1,
    locked: false,
    muted: false,
    hidden: false,
    clips: [],
  });
  assert.equal(parseProjectDocument(many).tracks[0].clips.length, 2_500);
});

test("allows multiple instances of one asset and audio, text, caption, and overlay tracks", () => {
  const multi = clone(project);
  const videoClip = multi.tracks[0].clips[0];
  multi.tracks[0].clips.push({
    ...videoClip,
    id: "clip-2",
    timelineStart: {numerator: 4, denominator: 1},
    timelineEnd: {numerator: 8, denominator: 1},
    sourceIn: {numerator: 20, denominator: 1},
    sourceOut: {numerator: 24, denominator: 1},
    speed: {numerator: 1, denominator: 1},
  });
  multi.assets.push({
    ...multi.assets[0],
    id: "audio-asset",
    kind: "audio",
    original: {...multi.assets[0].original, filename: "music.wav"},
  });
  multi.assets.push({
    ...multi.assets[0],
    id: "image-asset",
    kind: "image",
    original: {...multi.assets[0].original, filename: "overlay.png"},
  });
  multi.tracks.push(
    {
      id: "audio-track",
      kind: "audio",
      name: "Audio",
      order: 1,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        ...videoClip,
        id: "audio-clip",
        assetId: "audio-asset",
        timelineEnd: {numerator: 4, denominator: 1},
        sourceIn: {numerator: 0, denominator: 1},
        sourceOut: {numerator: 4, denominator: 1},
        speed: {numerator: 1, denominator: 1},
      }],
    },
    {
      id: "text-track",
      kind: "text",
      name: "Titles",
      order: 2,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: "text-clip",
        kind: "text",
        timelineStart: {numerator: 0, denominator: 1},
        timelineEnd: {numerator: 2, denominator: 1},
        content: "Title",
        style: {fontSize: 24, bold: true},
        keyframes: [],
      }],
    },
    {
      id: "caption-track",
      kind: "captions",
      name: "Captions",
      order: 3,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        id: "caption-clip",
        kind: "caption",
        timelineStart: {numerator: 0, denominator: 1},
        timelineEnd: {numerator: 1, denominator: 1},
        content: "Hello",
        style: {},
        keyframes: [],
      }],
    },
    {
      id: "overlay-track",
      kind: "overlay",
      name: "Overlay",
      order: 4,
      locked: false,
      muted: false,
      hidden: false,
      clips: [{
        ...videoClip,
        id: "overlay-clip",
        assetId: "image-asset",
      }],
    },
  );
  const parsed = parseProjectDocument(multi);
  assert.equal(parsed.tracks.length, 5);
  assert.equal(parsed.tracks[0].clips.length, 2);
});

test("validates rational values and frame rates", () => {
  for (const frameRate of [
    {numerator: 0, denominator: 1},
    {numerator: 30, denominator: 0},
    {numerator: 30, denominator: 2},
    {numerator: Number.MAX_SAFE_INTEGER + 1, denominator: 1},
  ]) {
    const invalid = clone(project);
    invalid.settings.frameRate = frameRate;
    assert.equal(ProjectDocumentV1Schema.safeParse(invalid).success, false);
  }
  const missingFrameRate = clone(project);
  missingFrameRate.settings.frameRate = null;
  assert.equal(ProjectDocumentV1Schema.safeParse(missingFrameRate).success, true);
});

test("rejects duplicate IDs, missing references, incompatible tracks, and invalid ranges", () => {
  const duplicateClip = clone(project);
  duplicateClip.tracks[0].clips.push({...duplicateClip.tracks[0].clips[0]});
  assert.equal(ProjectDocumentV1Schema.safeParse(duplicateClip).success, false);

  const missingAsset = clone(project);
  missingAsset.tracks[0].clips[0].assetId = "missing";
  assert.equal(ProjectDocumentV1Schema.safeParse(missingAsset).success, false);

  const wrongTrack = clone(project);
  wrongTrack.tracks[0].kind = "audio";
  assert.equal(ProjectDocumentV1Schema.safeParse(wrongTrack).success, false);

  const invalidSpeed = clone(project);
  invalidSpeed.tracks[0].clips[0].speed = {numerator: 0, denominator: 1};
  assert.equal(ProjectDocumentV1Schema.safeParse(invalidSpeed).success, false);

  const invalidSourceOut = clone(project);
  invalidSourceOut.tracks[0].clips[0].sourceOut = {numerator: 61, denominator: 1};
  assert.equal(ProjectDocumentV1Schema.safeParse(invalidSourceOut).success, false);
});

test("enforces half-frame canonical timing and preserves explicit legacy mismatch status", () => {
  const matching = clone(project);
  assert.equal(ProjectDocumentV1Schema.safeParse(matching).success, true);

  const atCanonicalTolerance = clone(project);
  atCanonicalTolerance.tracks[0].clips[0].timelineEnd = {
    numerator: 241_001,
    denominator: 60_000,
  };
  assert.equal(ProjectDocumentV1Schema.safeParse(atCanonicalTolerance).success, true);

  const mismatch = clone(project);
  mismatch.tracks[0].clips[0].timelineEnd = {numerator: 403, denominator: 100};
  assert.equal(ProjectDocumentV1Schema.safeParse(mismatch).success, false);
  mismatch.tracks[0].clips[0].timingStatus = "legacy-mismatch";
  assert.equal(ProjectDocumentV1Schema.safeParse(mismatch).success, true);
  assert.deepEqual(
    parseProjectDocument(JSON.parse(JSON.stringify(mismatch))).tracks[0].clips[0].timingStatus,
    "legacy-mismatch",
  );

  const retainedMismatch = clone(project);
  retainedMismatch.tracks[0].clips[0].timingStatus = "legacy-mismatch";
  assert.equal(ProjectDocumentV1Schema.safeParse(retainedMismatch).success, true);
  assert.equal(parseProjectDocument(retainedMismatch).tracks[0].clips[0].timingStatus, "legacy-mismatch");
});

test("uses exact rational timing for standard and fractional project frame rates", () => {
  for (const frameRate of [
    {numerator: 24, denominator: 1},
    {numerator: 25, denominator: 1},
    {numerator: 30, denominator: 1},
    {numerator: 60, denominator: 1},
    {numerator: 30000, denominator: 1001},
  ]) {
    const oneFrame = {
      numerator: frameRate.denominator,
      denominator: frameRate.numerator,
    };
    const frameProject = clone(project);
    frameProject.settings.frameRate = frameRate;
    frameProject.tracks[0].clips[0].timelineEnd = oneFrame;
    frameProject.tracks[0].clips[0].sourceIn = {numerator: 0, denominator: 1};
    frameProject.tracks[0].clips[0].sourceOut = oneFrame;
    frameProject.tracks[0].clips[0].speed = {numerator: 1, denominator: 1};
    assert.equal(ProjectDocumentV1Schema.safeParse(frameProject).success, true);
  }
});

test("requires exact timing when the project frame rate is unavailable", () => {
  const missingRate = clone(project);
  missingRate.settings.frameRate = null;
  assert.equal(ProjectDocumentV1Schema.safeParse(missingRate).success, true);

  missingRate.tracks[0].clips[0].timelineEnd = {numerator: 401, denominator: 100};
  assert.equal(ProjectDocumentV1Schema.safeParse(missingRate).success, false);
  missingRate.tracks[0].clips[0].timingStatus = "legacy-mismatch";
  assert.equal(ProjectDocumentV1Schema.safeParse(missingRate).success, true);
});

test("rejects nested unknown frame-rate timebase fields with an actionable diagnostic", () => {
  const unknownTimebase = clone(project);
  unknownTimebase.settings.frameRate.timebase = {numerator: 1, denominator: 90_000};
  const result = ProjectDocumentV1Schema.safeParse(unknownTimebase);
  assert.equal(result.success, false);
  const issue = result.error.issues.find((entry) => entry.path.join(".") === "settings.frameRate");
  assert.ok(issue);
  assert.match(issue.message, /timebase/u);
});

test("accepts representable very small positive durations and rejects zero durations", () => {
  const tiny = clone(project);
  tiny.tracks[0].clips[0].timelineEnd = {numerator: 1, denominator: 1_000_000_000};
  tiny.tracks[0].clips[0].sourceIn = {numerator: 0, denominator: 1};
  tiny.tracks[0].clips[0].sourceOut = {numerator: 1, denominator: 1_000_000_000};
  tiny.tracks[0].clips[0].speed = {numerator: 1, denominator: 1};
  assert.equal(ProjectDocumentV1Schema.safeParse(tiny).success, true);

  const zero = clone(tiny);
  zero.tracks[0].clips[0].timelineEnd = {numerator: 0, denominator: 1};
  assert.equal(ProjectDocumentV1Schema.safeParse(zero).success, false);
});

test("validates references efficiently across many assets and clips", () => {
  const many = clone(project);
  const templateAsset = many.assets[0];
  const templateClip = many.tracks[0].clips[0];
  const count = 1_200;
  many.assets = Array.from({length: count}, (_, index) => ({
    ...templateAsset,
    id: `asset-${index}`,
  }));
  many.tracks[0].clips = Array.from({length: count}, (_, index) => ({
    ...templateClip,
    id: `clip-${index}`,
    assetId: `asset-${index}`,
  }));
  assert.equal(ProjectDocumentV1Schema.safeParse(many).success, true);

  many.tracks[0].clips[count - 1].assetId = "missing-asset";
  assert.equal(ProjectDocumentV1Schema.safeParse(many).success, false);
});

test("enforces effect and keyframe ID uniqueness within each clip", () => {
  const duplicateEffects = clone(project);
  duplicateEffects.tracks[0].clips[0].properties.effects = [
    {id: "effect-1", kind: "blur", parameters: {}},
    {id: "effect-1", kind: "color", parameters: {}},
  ];
  assert.equal(ProjectDocumentV1Schema.safeParse(duplicateEffects).success, false);

  const duplicateKeyframes = clone(project);
  duplicateKeyframes.tracks[0].clips[0].keyframes = [
    {
      id: "keyframe-1",
      property: "opacity",
      time: {numerator: 1, denominator: 1},
      value: 0.5,
      interpolation: "linear",
    },
    {
      id: "keyframe-1",
      property: "opacity",
      time: {numerator: 2, denominator: 1},
      value: 1,
      interpolation: "linear",
    },
  ];
  assert.equal(ProjectDocumentV1Schema.safeParse(duplicateKeyframes).success, false);
});

test("preserves missing media references instead of requiring a local file", () => {
  const missing = clone(project);
  missing.assets[0].availability = "missing";
  missing.assets[0].localMediaKey = null;
  assert.equal(parseProjectDocument(missing).tracks[0].clips.length, 1);
});

test("returns explicit errors for unsupported and malformed project versions", () => {
  const future = {...clone(project), schemaVersion: 2};
  assert.throws(() => parseProjectDocument(future), UnsupportedProjectVersionError);
  assert.throws(
    () => parseProjectDocument({schemaVersion: "1"}),
    UnsupportedProjectVersionError,
  );
  assert.throws(() => parseProjectDocument({id: "no-version"}), UnsupportedProjectVersionError);
  assert.throws(
    () => parseProjectDocument({...clone(project), revision: -1}),
    /revision/u,
  );
});

test("rational arithmetic and number conversion preserve common frame and decimal values", () => {
  assert.deepEqual(rationalFromNumber(0.1), {numerator: 1, denominator: 10});
  assert.deepEqual(
    RationalSchema.parse({numerator: 30000, denominator: 1001}),
    {numerator: 30000, denominator: 1001},
  );
  assert.deepEqual(rationalFromNumber(30000 / 1001), {
    numerator: 2997002997002997,
    denominator: 100000000000000,
  });
  assert.equal(rationalToNumber({numerator: 30000, denominator: 1001}), 30000 / 1001);
  assert.equal(compareRationals(
    {numerator: 30000, denominator: 1001},
    {numerator: 29, denominator: 1},
  ), 1);
  assert.throws(
    () => rationalFromNumber(Number.MIN_VALUE),
    /too small to preserve at microsecond precision/u,
  );
});
