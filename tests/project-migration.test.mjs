import assert from "node:assert/strict";
import {test} from "node:test";
import {
  migrateLegacyProject,
  migrateOrValidateProject,
} from "../src/lib/editor/project-migration.ts";
import {
  UnsupportedProjectVersionError,
} from "../src/lib/editor/project.ts";

const sourceMedia = {
  filename: "source.mp4",
  mimeType: "video/mp4",
  duration: 60,
  width: 1920,
  height: 1080,
  frameRate: {numerator: 30000, denominator: 1001},
};
const clips = [
  {
    id: "stable-clip-1",
    start: 0,
    end: 4,
    sourceStart: 10,
    sourceEnd: 18,
    speed: 2,
  },
  {
    id: "stable-clip-2",
    start: 4,
    end: 8,
    sourceStart: 30,
    sourceEnd: 34,
    speed: 1,
  },
];

test("maps legacy clips and metadata without changing IDs or source/timeline positions", () => {
  const result = migrateLegacyProject({
    projectId: "draft-1",
    clips,
    sourceMedia,
    metadata: {
      name: "Legacy project",
      aspectRatio: "16:9",
      createdAt: 123,
      updatedAt: 456,
    },
    media: {
      localMediaKey: "video.mp4",
      availability: "available",
    },
  });
  const project = result.project;
  assert.equal(project.id, "draft-1");
  assert.deepEqual(project.metadata, {
    name: "Legacy project",
    aspectRatio: "16:9",
    createdAt: 123,
    updatedAt: 456,
  });
  assert.equal(project.settings.frameRate.numerator, 30000);
  assert.deepEqual(project.settings.frameRate, {numerator: 30000, denominator: 1001});
  assert.equal(project.assets[0].localMediaKey, "video.mp4");
  assert.equal(project.assets[0].original.filename, "source.mp4");
  assert.deepEqual(project.tracks[0].clips.map((clip) => ({
    id: clip.id,
    assetId: clip.assetId,
    timelineStart: clip.timelineStart,
    timelineEnd: clip.timelineEnd,
    sourceIn: clip.sourceIn,
    sourceOut: clip.sourceOut,
    speed: clip.speed,
    timingStatus: clip.timingStatus,
  })), [
    {
      id: "stable-clip-1",
      assetId: project.assets[0].id,
      timelineStart: {numerator: 0, denominator: 1},
      timelineEnd: {numerator: 4, denominator: 1},
      sourceIn: {numerator: 10, denominator: 1},
      sourceOut: {numerator: 18, denominator: 1},
      speed: {numerator: 2, denominator: 1},
      timingStatus: "consistent",
    },
    {
      id: "stable-clip-2",
      assetId: project.assets[0].id,
      timelineStart: {numerator: 4, denominator: 1},
      timelineEnd: {numerator: 8, denominator: 1},
      sourceIn: {numerator: 30, denominator: 1},
      sourceOut: {numerator: 34, denominator: 1},
      speed: {numerator: 1, denominator: 1},
      timingStatus: "consistent",
    },
  ]);
  assert.deepEqual(result.warnings, []);
});

test("assigns deterministic asset and track IDs across repeated migrations", () => {
  const first = migrateLegacyProject({
    projectId: "draft-deterministic",
    clips,
    sourceMedia,
  }).project;
  const second = migrateLegacyProject({
    projectId: "draft-deterministic",
    clips,
    sourceMedia,
  }).project;
  assert.equal(first.assets[0].id, second.assets[0].id);
  assert.equal(first.tracks[0].id, second.tracks[0].id);
  assert.deepEqual(first.tracks[0].clips.map((clip) => clip.id), clips.map((clip) => clip.id));
});

test("preserves clips when media is missing or its metadata is unavailable", () => {
  const missing = migrateLegacyProject({
    projectId: "draft-missing",
    clips,
    sourceMedia: null,
    media: {availability: "missing"},
  });
  assert.equal(missing.project.tracks[0].clips.length, 2);
  assert.equal(missing.project.assets[0].availability, "missing");
  assert.equal(missing.project.assets[0].original.filename, null);
  assert.equal(missing.project.assets[0].localMediaKey, null);
  assert.ok(missing.warnings.some((warning) => warning.includes("preserved")));

  const unknown = migrateLegacyProject({
    projectId: "draft-unknown",
    clips,
    sourceMedia: null,
  });
  assert.equal(unknown.project.tracks[0].clips.length, 2);
  assert.equal(unknown.project.assets[0].availability, "unknown");
  assert.equal(unknown.project.assets[0].original.duration, null);
  assert.equal(unknown.project.settings.frameRate, null);
  assert.ok(unknown.warnings.some((warning) => warning.includes("no frame rate was inferred")));
});

test("does not invent a project frame rate when source metadata omits it", () => {
  const result = migrateLegacyProject({
    projectId: "draft-no-rate",
    clips,
    sourceMedia: {...sourceMedia, frameRate: undefined},
  });
  assert.equal(result.project.settings.frameRate, null);
  assert.ok(result.warnings.some((warning) => warning.includes("frame rate is unknown")));
});

test("rounds legacy floating-point artifacts only when safe integers cannot hold an exact decimal", () => {
  const result = migrateLegacyProject({
    projectId: "draft-floats",
    sourceMedia: null,
    clips: [{
      id: "float-clip",
      start: 0,
      end: 0.12345678901234567,
      sourceStart: 0,
      sourceEnd: 0.12345678901234567,
      speed: 1,
    }],
  });
  assert.equal(result.project.tracks[0].clips[0].timelineEnd.denominator, 1_000_000);
  assert.ok(result.warnings.some((warning) => warning.includes("rounded to microsecond")));
  const convertedEnd = result.project.tracks[0].clips[0].timelineEnd.numerator /
    result.project.tracks[0].clips[0].timelineEnd.denominator;
  assert.ok(Math.abs(convertedEnd - 0.12345678901234567) <= 0.0000005);
  assert.ok(Array.isArray(result.warnings));
});

test("preserves and marks legacy timing mismatches without rewriting positions or speed", () => {
  const result = migrateLegacyProject({
    projectId: "draft-duration-warning",
    sourceMedia,
    clips: [{...clips[0], end: 3}],
  });
  const migrated = result.project.tracks[0].clips[0];
  assert.ok(result.warnings.some((warning) => warning.includes("canonical timing rule")));
  assert.equal(migrated.id, clips[0].id);
  assert.deepEqual(migrated.timelineStart, {numerator: 0, denominator: 1});
  assert.deepEqual(migrated.timelineEnd, {numerator: 3, denominator: 1});
  assert.deepEqual(migrated.sourceIn, {numerator: 10, denominator: 1});
  assert.deepEqual(migrated.sourceOut, {numerator: 18, denominator: 1});
  assert.deepEqual(migrated.speed, {numerator: 2, denominator: 1});
  assert.equal(migrated.timingStatus, "legacy-mismatch");
  assert.doesNotThrow(() => migrateOrValidateProject(result.project));
  const jsonRoundTrip = migrateOrValidateProject(JSON.parse(JSON.stringify(result.project)));
  assert.equal(jsonRoundTrip.project.tracks[0].clips[0].timingStatus, "legacy-mismatch");
  assert.deepEqual(jsonRoundTrip.warnings, []);
});

test("keeps the 50 ms legacy tolerance separate from canonical half-frame timing", () => {
  const atTolerance = migrateLegacyProject({
    projectId: "draft-at-tolerance",
    sourceMedia,
    clips: [{...clips[0], end: 4.05}],
  });
  assert.equal(
    atTolerance.project.tracks[0].clips[0].timingStatus,
    "legacy-mismatch",
  );
  assert.ok(atTolerance.warnings.some((warning) => warning.includes("50 ms migration compatibility tolerance")));

  const beyondTolerance = migrateLegacyProject({
    projectId: "draft-beyond-tolerance",
    sourceMedia,
    clips: [{...clips[0], end: 4.050000001}],
  });
  assert.equal(
    beyondTolerance.project.tracks[0].clips[0].timingStatus,
    "legacy-mismatch",
  );
  assert.ok(beyondTolerance.warnings.length > 0);

  const belowLegacyTolerance = migrateLegacyProject({
    projectId: "draft-below-legacy-tolerance",
    sourceMedia,
    clips: [{...clips[0], end: 4.03}],
  });
  assert.equal(
    belowLegacyTolerance.project.tracks[0].clips[0].timingStatus,
    "legacy-mismatch",
  );
  assert.ok(belowLegacyTolerance.warnings.some((warning) => warning.includes("50 ms migration compatibility tolerance")));
});

test("preserves mismatches when the project frame rate is unavailable", () => {
  const result = migrateLegacyProject({
    projectId: "draft-no-rate-mismatch",
    sourceMedia: null,
    clips: [{...clips[0], end: 4.03}],
  });
  assert.equal(result.project.settings.frameRate, null);
  assert.equal(result.project.tracks[0].clips[0].timingStatus, "legacy-mismatch");
  assert.ok(result.warnings.some((warning) => warning.includes("frame rate is unknown")));
  assert.ok(result.warnings.some((warning) => warning.includes("50 ms migration compatibility tolerance")));
});

test("rejects zero durations but preserves very small representable durations", () => {
  assert.throws(() => migrateLegacyProject({
    projectId: "draft-zero-duration",
    sourceMedia,
    clips: [{...clips[0], end: 0}],
  }), /invalid source, timeline, or speed/u);

  const tiny = migrateLegacyProject({
    projectId: "draft-tiny-duration",
    sourceMedia: null,
    clips: [{
      id: "tiny-clip",
      start: 0,
      end: 0.00000001,
      sourceStart: 0,
      sourceEnd: 0.00000001,
      speed: 1,
    }],
  });
  assert.equal(tiny.project.tracks[0].clips[0].timelineEnd.denominator, 100_000_000);
  assert.equal(tiny.project.tracks[0].clips[0].timingStatus, "consistent");
  assert.throws(
    () => migrateLegacyProject({
      projectId: "draft-unrepresentably-tiny",
      sourceMedia: null,
      clips: [{
        id: "tiny-clip",
        start: 0,
        end: Number.MIN_VALUE,
        sourceStart: 0,
        sourceEnd: Number.MIN_VALUE,
        speed: 1,
      }],
    }),
    /too small to preserve at microsecond precision/u,
  );
});

test("rejects unknown legacy fields with actionable paths instead of discarding them", () => {
  const base = {
    projectId: "draft-unknown-fields",
    clips,
    sourceMedia,
  };
  assert.throws(
    () => migrateLegacyProject({...base, customProjectField: true}),
    /project\.customProjectField is unsupported/u,
  );
  assert.throws(
    () => migrateLegacyProject({...base, metadata: {name: "Project", extra: true}}),
    /metadata\.extra is unsupported/u,
  );
  assert.throws(
    () => migrateLegacyProject({...base, media: {localMediaKey: "video.mp4", extra: true}}),
    /media\.extra is unsupported/u,
  );
  assert.throws(
    () => migrateLegacyProject({
      ...base,
      sourceMedia: {...sourceMedia, extra: true},
    }),
    /sourceMedia\.extra is unsupported/u,
  );
  assert.throws(
    () => migrateLegacyProject({
      ...base,
      clips: [{...clips[0], extra: true}],
    }),
    /clips\[0\]\.extra is unsupported/u,
  );
});

test("rejects malformed legacy project IDs and clip data rather than dropping it", () => {
  assert.throws(() => migrateLegacyProject({
    projectId: "",
    clips,
    sourceMedia,
  }), /project ID/u);
  assert.throws(() => migrateLegacyProject({
    projectId: "draft-bad-clip",
    clips: [{...clips[0], speed: 0}],
    sourceMedia,
  }), /invalid source, timeline, or speed/u);
  assert.throws(() => migrateLegacyProject({
    projectId: "draft-nan",
    clips: [{...clips[0], start: Number.NaN}],
    sourceMedia,
  }), /non-finite start/u);
  assert.throws(() => migrateLegacyProject({
    projectId: "draft-bad-id",
    clips: [{...clips[0], id: 123}],
    sourceMedia,
  }), /invalid ID/u);
  assert.throws(() => migrateLegacyProject({
    projectId: "draft-bad-clips",
    clips: null,
    sourceMedia,
  }), /clips must be an array/u);
});

test("validates canonical projects and explicitly rejects unsupported versions", () => {
  const canonical = migrateLegacyProject({
    projectId: "draft-canonical",
    clips,
    sourceMedia,
  }).project;
  assert.deepEqual(migrateOrValidateProject(canonical), {
    project: canonical,
    warnings: [],
  });
  assert.throws(
    () => migrateOrValidateProject({...canonical, schemaVersion: 99}),
    UnsupportedProjectVersionError,
  );
});
