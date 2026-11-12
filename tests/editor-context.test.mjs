import assert from "node:assert/strict";
import {test} from "node:test";
import {
  buildEditorContext,
  formatEditorContextForPrompt,
  validateEditorContext,
} from "../src/lib/editor/editor-context.ts";
import {
  MAX_CHAT_REQUEST_BYTES,
  parseChatRequest,
} from "../src/lib/ai/chat-request.ts";

const firstClip = {
  id: "clip-1",
  start: 0,
  end: 4,
  sourceStart: 10,
  sourceEnd: 18,
  speed: 2,
};
const secondClip = {
  id: "clip-2",
  start: 4,
  end: 8,
  sourceStart: 30,
  sourceEnd: 34,
  speed: 1,
};

function makeContext(overrides = {}) {
  return buildEditorContext({
    projectId: "project-1",
    sourceMedia: {
      filename: "source-video.mp4",
      mimeType: "video/mp4",
      duration: 60,
      width: 1920,
      height: 1080,
    },
    clips: [firstClip],
    timelineDuration: 4,
    selectedClipId: null,
    selectedRange: null,
    playheadPosition: 2,
    revision: 1,
    synchronizationStatus: "synchronized",
    ...overrides,
  });
}

test("builds active video context from project metadata without serializing media data", () => {
  const context = makeContext();
  assert.equal(context.videoFilename, "source-video.mp4");
  assert.equal(context.videoDuration, 60);
  assert.deepEqual(context.mediaMetadata, {
    duration: 60,
    width: 1920,
    height: 1080,
    mimeType: "video/mp4",
  });
  assert.equal(context.projectId, "project-1");
  assert.equal(context.mediaId, null);
  assert.equal("file" in context, false);
  assert.equal("videoUrl" in context, false);
  assert.doesNotMatch(JSON.stringify(context), /blob:|base64|https?:\/\//iu);
});

test("supports an active video with an empty timeline", () => {
  const context = makeContext({clips: [], timelineDuration: 0, playheadPosition: 0});
  assert.equal(context.timelineClips.length, 0);
  assert.equal(context.timelineDuration, 0);
  assert.equal(context.videoFilename, "source-video.mp4");
});

test("represents no active video and no timeline", () => {
  const context = makeContext({
    sourceMedia: null,
    clips: [],
    timelineDuration: 0,
    selectedClipId: null,
    playheadPosition: 0,
  });
  assert.equal(context.videoFilename, null);
  assert.equal(context.videoDuration, null);
  assert.equal(context.mediaMetadata, null);
  assert.deepEqual(context.timelineClips, []);
});

test("preserves ordering and source ranges for multiple timeline clips", () => {
  const context = makeContext({
    clips: [firstClip, secondClip],
    timelineDuration: 8,
    playheadPosition: 7,
  });
  assert.deepEqual(context.timelineClips.map((clip) => clip.id), ["clip-1", "clip-2"]);
  assert.deepEqual(context.timelineClips.map((clip) => [
    clip.timelineStart,
    clip.timelineEnd,
    clip.sourceStart,
    clip.sourceEnd,
  ]), [
    [0, 4, 10, 18],
    [4, 8, 30, 34],
  ]);
});

test("preserves source-to-timeline mapping and playback speed", () => {
  const [clip] = makeContext().timelineClips;
  assert.deepEqual(
    [clip.timelineStart, clip.timelineEnd, clip.sourceStart, clip.sourceEnd, clip.speed],
    [0, 4, 10, 18, 2],
  );
  assert.equal((clip.sourceEnd - clip.sourceStart) / clip.speed, clip.timelineEnd - clip.timelineStart);
});

test("includes a selected clip only when it exists in the timeline", () => {
  assert.deepEqual(makeContext({selectedClipId: "clip-1"}).selectedClipIds, ["clip-1"]);
  assert.deepEqual(makeContext({selectedClipId: "removed-clip"}).selectedClipIds, []);
});

test("preserves a selected range in timeline seconds", () => {
  const context = makeContext({selectedRange: {in: 1.25, out: 3.5}});
  assert.deepEqual(context.selectedRange, {in: 1.25, out: 3.5});
});

test("context changes after timeline edits and exposes the new revision", () => {
  const before = makeContext();
  const after = makeContext({
    clips: [firstClip, {...secondClip, id: "clip-3"}],
    timelineDuration: 8,
    revision: before.revision + 1,
  });
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.timelineClips.map((clip) => clip.id), ["clip-1", "clip-3"]);
});

test("source replacement changes media context and revision", () => {
  const before = makeContext();
  const after = makeContext({
    sourceMedia: {filename: "replacement.mov", duration: 15, width: 1280, height: 720},
    revision: before.revision + 1,
  });
  assert.equal(after.videoFilename, "replacement.mov");
  assert.equal(after.revision, before.revision + 1);
});

test("project switching updates the project identity and revision", () => {
  const before = makeContext();
  const after = makeContext({projectId: "project-2", revision: before.revision + 1});
  assert.equal(after.projectId, "project-2");
  assert.equal(after.revision, before.revision + 1);
});

test("context is JSON serializable and omits unavailable optional identifiers", () => {
  const context = makeContext({projectId: null, mediaId: null});
  assert.equal(context.projectId, null);
  assert.equal(context.mediaId, null);
  assert.deepEqual(validateEditorContext(JSON.parse(JSON.stringify(context))), context);
});

test("rejects invalid clip timing, speed, ordering, and duplicate identifiers", () => {
  assert.throws(() => makeContext({
    clips: [{...firstClip, speed: 0}],
  }));
  assert.throws(() => makeContext({
    clips: [{...firstClip, end: 3}],
  }));
  assert.throws(() => makeContext({
    clips: [secondClip, firstClip],
    timelineDuration: 8,
  }));
  assert.throws(() => makeContext({
    clips: [firstClip, {...firstClip}],
    timelineDuration: 8,
  }));
});

test("validates the chat API context and rejects malformed or oversized requests", () => {
  const context = makeContext();
  const valid = parseChatRequest({
    message: "What is open?",
    editorContext: context,
  }, 256, validateEditorContext);
  assert.equal(valid.editorContext.videoFilename, "source-video.mp4");

  assert.throws(() => parseChatRequest({
    message: "What is open?",
    editorContext: {...context, timelineClips: [{...context.timelineClips[0], speed: -1}]},
  }, 256, validateEditorContext));
  assert.throws(() => parseChatRequest({
    message: "",
    editorContext: context,
  }, 256, validateEditorContext));
  assert.throws(() => parseChatRequest({
    message: "What is open?",
    editorContext: context,
    modelsToTry: ["paid-provider/paid-model"],
  }, 256, validateEditorContext));
  assert.throws(() => parseChatRequest({}, MAX_CHAT_REQUEST_BYTES + 1, validateEditorContext));
});

test("context and playhead updates preserve the independent structural revision", () => {
  const context = makeContext();
  const playheadUpdate = {...context, playheadPosition: 3.25};
  assert.equal(playheadUpdate.revision, context.revision);
  assert.equal(playheadUpdate.timelineClips, context.timelineClips);
  assert.equal(playheadUpdate.playheadPosition, 3.25);
});

test("chat prompt receives every clip and explicitly treats context as metadata", () => {
  const context = makeContext({
    clips: [firstClip, secondClip],
    timelineDuration: 8,
    selectedClipId: "clip-2",
    selectedRange: {in: 4, out: 6},
  });
  const promptContext = formatEditorContextForPrompt(context);
  assert.match(promptContext, /clip-1/u);
  assert.match(promptContext, /clip-2/u);
  assert.match(promptContext, /Selected range: In 4s, Out 6s/u);
  assert.match(promptContext, /Playhead: 2s/u);
  assert.match(promptContext, /metadata only/u);

  const noVideo = formatEditorContextForPrompt(makeContext({
    sourceMedia: null,
    clips: [],
    timelineDuration: 0,
    playheadPosition: 0,
  }));
  assert.match(noVideo, /No active video is open/u);
});
