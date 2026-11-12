import assert from "node:assert/strict";
import {test} from "node:test";
import {
  beginHistoryGroup,
  cancelHistoryGroup,
  canRedo,
  canUndo,
  commitHistoryGroup,
  createProjectHistory,
  executeProjectCommand,
  getHistoryCurrentProject,
  ProjectHistoryError,
  redoProjectHistory,
  undoProjectHistory,
} from "../src/lib/editor/history/history.ts";
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
const textClip = (id = "text-1", kind = "text", start = 2, end = 6) => ({
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
const command = (history, type, payload, expectedRevision = getHistoryCurrentProject(history).revision) => ({
  schemaVersion: PROJECT_SCHEMA_VERSION,
  commandId: `command-${type}`,
  expectedRevision,
  type,
  payload,
});
const execute = (history, type, payload) =>
  executeProjectCommand(history, command(history, type, payload));
const findTrack = (project, id) => project.tracks.find((entry) => entry.id === id);
const findClip = (project, trackId, id) => findTrack(project, trackId).clips.find((entry) => entry.id === id);
const content = (project) => {
  const {revision: _revision, ...rest} = project;
  return rest;
};
const assertHistoryError = (callback, code) => {
  assert.throws(callback, (error) =>
    error instanceof ProjectHistoryError && error.code === code);
};
const assertCommandError = (callback, code) => {
  assert.throws(callback, (error) =>
    error instanceof ProjectCommandError && error.code === code);
};
const roundTrip = (type, payload) => {
  const original = baseProject();
  const history = createProjectHistory(original);
  const applied = execute(history, type, payload);
  const appliedContent = content(applied.project);
  const undone = undoProjectHistory(applied, applied.project.revision);
  assert.deepEqual(content(undone.project), content(original), `${type} undo`);
  assert.equal(undone.project.revision, applied.project.revision + 1);
  const redone = redoProjectHistory(undone, undone.project.revision);
  assert.deepEqual(content(redone.project), appliedContent, `${type} redo`);
  assert.equal(redone.project.revision, undone.project.revision + 1);
  assert.equal(redone.cursor, 1);
};

test("undo and redo restore every supported command type", () => {
  const cases = [
    ["split-clip", {trackId: "video", clipId: "media-1", at: r(3), rightClipId: "split-right"}],
    ["split-clip", {
      trackId: "captions",
      clipId: "caption-1",
      at: r(3),
      rightClipId: "caption-right",
      captionText: {leftText: "First", rightText: "Second"},
    }],
    ["trim-clip-start", {trackId: "video", clipId: "media-1", timelineStart: r(3)}],
    ["trim-clip-end", {trackId: "video", clipId: "media-1", timelineEnd: r(5)}],
    ["move-clip", {trackId: "video", clipId: "media-1", timelineStart: r(10), destinationTrackId: "overlay"}],
    ["delete-clip", {trackId: "video", clipId: "media-1"}],
    ["ripple-delete", {
      trackId: "video",
      start: r(3),
      end: r(5),
      rightClipIds: {"media-1": "ripple-right"},
      captionSplits: {},
    }],
    ["change-clip-speed", {
      trackId: "video",
      clipId: "media-1",
      speed: r(4),
      policy: "preserve-source-range",
    }],
    ["change-clip-speed", {
      trackId: "video",
      clipId: "media-1",
      speed: r(1, 2),
      policy: "preserve-timeline-range",
    }],
    ["update-clip-properties", {
      trackId: "video",
      clipId: "media-1",
      patch: {kind: "media", updates: {properties: {volume: 0.25}}},
    }],
    ["update-clip-properties", {
      trackId: "text",
      clipId: "text-1",
      patch: {kind: "text", updates: {content: "Updated", style: {color: "cyan"}}},
    }],
    ["update-clip-properties", {
      trackId: "captions",
      clipId: "caption-1",
      patch: {kind: "caption", updates: {content: "Updated caption"}},
    }],
    ["add-track", {
      track: {id: "new-track", kind: "text", name: "New", order: 5, locked: false, muted: false, hidden: false, clips: []},
    }],
    ["remove-track", {trackId: "captions", removeContents: true}],
    ["add-media-clip", {
      trackId: "video",
      clip: mediaClip({
        id: "added-media",
        timelineStart: r(20),
        timelineEnd: r(24),
        sourceIn: r(10),
        sourceOut: r(18),
      }),
    }],
    ["remove-media-clip", {trackId: "video", clipId: "media-1"}],
  ];
  for (const [type, payload] of cases) roundTrip(type, payload);
});

test("history entries record commands and minimal clip entity patches", () => {
  const history = createProjectHistory(baseProject());
  const moved = execute(history, "move-clip", {
    trackId: "video",
    clipId: "media-1",
    timelineStart: r(10),
  });
  assert.equal(moved.entries.length, 1);
  assert.equal(moved.entries[0].commands[0].type, "move-clip");
  assert.deepEqual(moved.entries[0].patches.map((patch) => patch.id), ["video"]);
  const patch = moved.entries[0].patches[0];
  assert.equal(patch.clips.length, 1);
  assert.equal(Object.hasOwn(patch.before, "fullTrack"), false);
  assert.equal(Object.hasOwn(patch.before, "clips"), false);
  assert.equal(Object.hasOwn(patch.clips[0].before.clip, "properties"), true);
  assert.equal(JSON.stringify(moved.entries).includes("filename"), false);
  assert.equal(JSON.stringify(moved.entries).includes("Blob"), false);
  assert.ok(moved.entries[0].memoryBytes > 0);
  assert.equal(moved.historyBytes, moved.entries[0].memoryBytes);
  assert.equal(Object.isFrozen(moved), true);
  assert.equal(Object.isFrozen(moved.project.tracks[0].clips[0]), true);
  assert.equal(Object.isFrozen(patch.clips[0].before.clip), true);
  assert.throws(() => {
    patch.clips[0].before.clip.keyframes[0].value = 99;
  }, TypeError);
});

test("sequential edits undo and redo in order with monotonically increasing revisions", () => {
  let history = createProjectHistory(baseProject());
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  assert.equal(history.project.revision, 2);
  const afterEdits = content(history.project);

  history = undoProjectHistory(history, 2);
  assert.equal(history.project.revision, 3);
  assert.equal(findClip(history.project, "video", "media-1").properties.volume, 1);
  assert.deepEqual(findClip(history.project, "video", "media-1").timelineStart, r(10));

  history = undoProjectHistory(history, 3);
  assert.equal(history.project.revision, 4);
  assert.deepEqual(content(history.project), content(baseProject()));
  assert.equal(canUndo(history), false);
  assert.equal(canRedo(history), true);

  history = redoProjectHistory(history, 4);
  assert.equal(history.project.revision, 5);
  history = redoProjectHistory(history, 5);
  assert.equal(history.project.revision, 6);
  assert.deepEqual(content(history.project), afterEdits);
  assert.equal(canRedo(history), false);
});

test("a successful edit after undo discards the redo branch", () => {
  let history = createProjectHistory(baseProject());
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  history = undoProjectHistory(history, 2);
  assert.equal(history.entries.length, 2);
  assert.equal(history.cursor, 1);

  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  assert.equal(history.entries.length, 2);
  assert.equal(history.cursor, 2);
  assert.equal(canRedo(history), false);
  assert.deepEqual(findClip(history.project, "video", "media-1").timelineStart, r(20));
});

test("stale and failed undo/redo operations leave history and project unchanged", () => {
  const original = createProjectHistory(baseProject());
  assertHistoryError(() => undoProjectHistory(original, 1), "STALE_REVISION");
  assertHistoryError(() => undoProjectHistory(original, 0), "NO_UNDO");
  assert.deepEqual(original.project, baseProject());
  assert.equal(original.cursor, 0);

  let history = execute(original, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const beforeFailedUndo = structuredClone(history);
  assertHistoryError(() => undoProjectHistory(history, 0), "STALE_REVISION");
  assert.deepEqual(history, beforeFailedUndo);

  history = undoProjectHistory(history, 1);
  const beforeFailedRedo = structuredClone(history);
  assertHistoryError(() => redoProjectHistory(history, 1), "STALE_REVISION");
  assert.deepEqual(history, beforeFailedRedo);
  assertHistoryError(() => redoProjectHistory(createProjectHistory(baseProject()), 0), "NO_REDO");

  const staleCommand = command(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(12),
  }, 99);
  assertCommandError(() => executeProjectCommand(history, staleCommand), "STALE_REVISION");
  assert.deepEqual(history, beforeFailedRedo);
});

test("group commit creates one entry and group undo/redo is atomic", () => {
  let history = createProjectHistory(baseProject());
  history = beginHistoryGroup(history, 0);
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.4}}},
  });
  assert.equal(history.project.revision, 0);
  assert.equal(getHistoryCurrentProject(history).revision, 2);
  assert.equal(history.entries.length, 0);

  history = commitHistoryGroup(history, 2);
  assert.equal(history.project.revision, 2);
  assert.equal(history.entries.length, 1);
  assert.equal(history.entries[0].commands.length, 2);
  history = undoProjectHistory(history, 2);
  assert.equal(history.project.revision, 3);
  assert.deepEqual(content(history.project), content(baseProject()));
  history = redoProjectHistory(history, 3);
  assert.equal(history.project.revision, 4);
  assert.equal(findClip(history.project, "video", "media-1").properties.volume, 0.4);
});

test("group cancel discards staged edits without changing project or history", () => {
  const original = createProjectHistory(baseProject());
  let history = beginHistoryGroup(original, 0);
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const staged = structuredClone(history);
  assertCommandError(() => executeProjectCommand(history, command(history, "delete-clip", {
    trackId: "video", clipId: "missing",
  })), "CLIP_NOT_FOUND");
  assert.deepEqual(history, staged);

  history = cancelHistoryGroup(history, 1);
  assert.deepEqual(history.project, original.project);
  assert.deepEqual(history.entries, original.entries);
  assert.equal(history.cursor, original.cursor);
  assert.equal(history.activeGroup, null);
});

test("failed group commit rejects stale revision without partial changes", () => {
  let history = beginHistoryGroup(createProjectHistory(baseProject()), 0);
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const beforeCommit = structuredClone(history);
  assertHistoryError(() => commitHistoryGroup(history, 0), "STALE_REVISION");
  assert.deepEqual(history, beforeCommit);
  assert.equal(history.project.revision, 0);
  assert.equal(history.entries.length, 0);
});

test("budget evicts oldest entries and retains undo/redo for the retained boundary", () => {
  const initial = baseProject();
  let probe = execute(createProjectHistory(initial), "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const firstBytes = probe.entries[0].memoryBytes;
  probe = execute(probe, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  const secondBytes = probe.entries[1].memoryBytes;
  const budget = Math.max(firstBytes, secondBytes);

  let history = createProjectHistory(initial, {maxHistoryBytes: budget});
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  assert.equal(history.entries.length, 1);
  assert.equal(history.cursor, 1);
  assert.equal(history.historyBytes, history.entries[0].memoryBytes);
  assert.ok(history.historyBytes <= budget);

  history = undoProjectHistory(history, history.project.revision);
  assert.deepEqual(findClip(history.project, "video", "media-1").timelineStart, r(10));
  assert.equal(history.cursor, 0);
  history = redoProjectHistory(history, history.project.revision);
  assert.deepEqual(findClip(history.project, "video", "media-1").timelineStart, r(20));
});

test("branching after budget eviction discards redo and keeps the new branch undoable", () => {
  const initial = baseProject();
  let probe = execute(createProjectHistory(initial), "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const firstBytes = probe.entries[0].memoryBytes;
  probe = execute(probe, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  const budget = Math.max(firstBytes, probe.entries[1].memoryBytes);

  let history = createProjectHistory(initial, {maxHistoryBytes: budget});
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  history = undoProjectHistory(history, history.project.revision);
  assert.equal(history.entries.length, 1);
  assert.equal(history.cursor, 0);
  assert.equal(canRedo(history), true);

  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(30),
  });
  assert.equal(history.entries.length, 1);
  assert.equal(history.cursor, 1);
  assert.equal(canRedo(history), false);
  history = undoProjectHistory(history, history.project.revision);
  assert.deepEqual(findClip(history.project, "video", "media-1").timelineStart, r(10));
});

test("oversized single entries remain undoable and are evicted by the next fitting entry", () => {
  const initial = baseProject();
  let history = createProjectHistory(initial, {maxHistoryBytes: 1});
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  assert.equal(history.entries.length, 1);
  assert.ok(history.historyBytes > history.maxHistoryBytes);
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  assert.equal(history.entries.length, 1);
  history = undoProjectHistory(history, history.project.revision);
  assert.deepEqual(findClip(history.project, "video", "media-1").timelineStart, r(10));
});

test("active groups reuse the committed project as their base without cloning it", () => {
  const project = baseProject();
  const history = createProjectHistory(project);
  const group = beginHistoryGroup(history, 0);
  assert.equal(group.activeGroup.baseProject, history.project);
  assert.equal(Object.hasOwn(group.activeGroup, "workingProject"), false);
  assert.equal(group.activeGroup.commandBytes, 0);
  assert.equal(group.activeGroup.patchBytes, 0);
  assert.equal(group.activeGroup.stagedProjectBytes, 0);
  assert.equal(group.activeGroup.memoryBytes, 0);

  const staged = execute(group, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  assert.equal(staged.activeGroup.baseProject, history.project);
  assert.equal(Object.hasOwn(staged.activeGroup, "workingProject"), false);
  assert.equal(staged.project, history.project);
  assert.equal(staged.activeGroup.commands.length, 1);
  assert.equal(staged.activeGroup.patches.length, 1);
  assert.equal(staged.activeGroup.memoryBytes, Buffer.byteLength(JSON.stringify({
    commands: staged.activeGroup.commands,
    patches: staged.activeGroup.patches,
  })));
  assert.deepEqual(
    getHistoryCurrentProject(staged),
    execute(history, "move-clip", {
      trackId: "video", clipId: "media-1", timelineStart: r(10),
    }).project,
  );
});

test("committed history nearly filling the budget rejects group staging atomically", () => {
  const initial = baseProject();
  const committedProbe = execute(createProjectHistory(initial), "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const committedBytes = committedProbe.historyBytes;
  const groupProbe = execute(beginHistoryGroup(
    createProjectHistory(committedProbe.project),
    committedProbe.project.revision,
  ), "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  const stagedBytes = groupProbe.activeGroup.memoryBytes;
  const budget = committedBytes + stagedBytes - 1;

  let history = createProjectHistory(initial, {maxHistoryBytes: budget});
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  const group = beginHistoryGroup(history, history.project.revision);
  assert.throws(() => execute(group, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  }), (error) =>
    error instanceof ProjectHistoryError &&
    error.code === "HISTORY_BUDGET_EXCEEDED");
  assert.deepEqual(group.project, history.project);
  assert.deepEqual(group.entries, history.entries);
  assert.equal(group.cursor, history.cursor);
  assert.equal(group.activeGroup.commands.length, 0);
  assert.equal(history.historyBytes + stagedBytes > budget, true);
});

test("aggregate group budget rejects the next command and cancellation preserves redo", () => {
  const initial = baseProject();
  let probe = execute(createProjectHistory(initial), "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  probe = execute(probe, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  probe = undoProjectHistory(probe, probe.project.revision);
  const committedBytes = probe.historyBytes;
  let groupProbe = beginHistoryGroup(probe, probe.project.revision);
  groupProbe = execute(groupProbe, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.4}}},
  });
  const firstStagedBytes = groupProbe.activeGroup.memoryBytes;
  const budget = committedBytes + firstStagedBytes;

  let history = createProjectHistory(initial, {maxHistoryBytes: budget});
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  history = undoProjectHistory(history, history.project.revision);
  let group = beginHistoryGroup(history, history.project.revision);
  group = execute(group, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.4}}},
  });
  const beforeRejectedStage = group;
  assert.equal(history.historyBytes + group.activeGroup.memoryBytes, budget);
  assert.throws(() => execute(group, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  }), (error) =>
    error instanceof ProjectHistoryError &&
    error.code === "HISTORY_BUDGET_EXCEEDED");
  assert.deepEqual(group, beforeRejectedStage);

  group = cancelHistoryGroup(group, getHistoryCurrentProject(group).revision);
  assert.equal(group.project.revision, history.project.revision);
  assert.equal(group.cursor, history.cursor);
  assert.equal(canRedo(group), true);
  assert.deepEqual(group.entries, history.entries);
});

test("multiple staged commands retain patches and commands but no working project snapshots", () => {
  const history = createProjectHistory(baseProject());
  let group = beginHistoryGroup(history, history.project.revision);
  let stagedCommandCount = 0;
  for (const volume of [0.8, 0.6, 0.4]) {
    group = execute(group, "update-clip-properties", {
      trackId: "video",
      clipId: "media-1",
      patch: {kind: "media", updates: {properties: {volume}}},
    });
    stagedCommandCount += 1;
    assert.equal(Object.hasOwn(group.activeGroup, "workingProject"), false);
    assert.equal(group.activeGroup.baseProject, history.project);
    assert.equal(group.activeGroup.stagedProjectBytes, 0);
  }
  assert.equal(stagedCommandCount, 3);
  assert.equal(group.activeGroup.commands.length, 3);
  assert.deepEqual(
    findClip(getHistoryCurrentProject(group), "video", "media-1").properties.volume,
    0.4,
  );
  assert.equal(group.activeGroup.memoryBytes, Buffer.byteLength(JSON.stringify({
    commands: group.activeGroup.commands,
    patches: group.activeGroup.patches,
  })));
});

test("group commit drops a redo branch and keeps retained-byte accounting exact", () => {
  const initial = baseProject();
  let probe = execute(createProjectHistory(initial), "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  probe = execute(probe, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  probe = undoProjectHistory(probe, probe.project.revision);
  let groupProbe = beginHistoryGroup(probe, probe.project.revision);
  groupProbe = execute(groupProbe, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.4}}},
  });
  const budget = probe.historyBytes + groupProbe.activeGroup.memoryBytes;

  let history = createProjectHistory(initial, {maxHistoryBytes: budget});
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.5}}},
  });
  history = undoProjectHistory(history, history.project.revision);
  let group = beginHistoryGroup(history, history.project.revision);
  group = execute(group, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {kind: "media", updates: {properties: {volume: 0.4}}},
  });
  assert.ok(history.historyBytes + group.activeGroup.memoryBytes <= budget);

  history = commitHistoryGroup(
    group,
    getHistoryCurrentProject(group).revision,
  );
  assert.equal(history.historyBytes, history.entries.reduce(
    (sum, entry) => sum + entry.memoryBytes,
    0,
  ));
  assert.ok(history.historyBytes <= budget);
  assert.equal(history.cursor, history.entries.length);
  assert.equal(canRedo(history), false);

  history = undoProjectHistory(history, history.project.revision);
  assert.deepEqual(findClip(history.project, "video", "media-1").properties.volume, 1);
  history = redoProjectHistory(history, history.project.revision);
  assert.deepEqual(findClip(history.project, "video", "media-1").properties.volume, 0.4);
});

test("first oversized group command is allowed alone and remains undoable", () => {
  let history = beginHistoryGroup(
    createProjectHistory(baseProject(), {maxHistoryBytes: 1}),
    0,
  );
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  assert.ok(history.activeGroup.memoryBytes > history.maxHistoryBytes);
  const staged = history;
  assert.throws(() => execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  }), (error) =>
    error instanceof ProjectHistoryError &&
    error.code === "HISTORY_BUDGET_EXCEEDED");
  assert.deepEqual(history, staged);

  history = commitHistoryGroup(
    history,
    getHistoryCurrentProject(history).revision,
  );
  assert.equal(history.entries.length, 1);
  assert.equal(history.historyBytes, history.entries[0].memoryBytes);
  assert.ok(history.historyBytes > history.maxHistoryBytes);
  history = undoProjectHistory(history, history.project.revision);
  assert.deepEqual(content(history.project), content(baseProject()));
  history = redoProjectHistory(history, history.project.revision);
  assert.deepEqual(
    findClip(history.project, "video", "media-1").timelineStart,
    r(10),
  );
});

test("failed group commit with a redo branch preserves committed state and cursor", () => {
  let history = createProjectHistory(baseProject());
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(10),
  });
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(20),
  });
  history = undoProjectHistory(history, history.project.revision);
  let group = beginHistoryGroup(history, history.project.revision);
  group = execute(group, "move-clip", {
    trackId: "video", clipId: "media-1", timelineStart: r(30),
  });
  const beforeFailedCommit = group;
  assertHistoryError(
    () => commitHistoryGroup(group, getHistoryCurrentProject(group).revision - 1),
    "STALE_REVISION",
  );
  assert.equal(group, beforeFailedCommit);
  assert.equal(group.activeGroup !== null, true);
  assert.deepEqual(group.project, history.project);
  assert.equal(group.cursor, history.cursor);
  assert.equal(canRedo(group), false);

  assertHistoryError(
    () => beginHistoryGroup(group, group.project.revision),
    "GROUP_ACTIVE",
  );
});

test("undo restores optional property absence and exact nested clip data", () => {
  const project = baseProject();
  const clip = findClip(project, "video", "media-1");
  clip.properties = {};
  const before = structuredClone(project);
  let history = createProjectHistory(project);
  history = execute(history, "update-clip-properties", {
    trackId: "video",
    clipId: "media-1",
    patch: {
      kind: "media",
      updates: {
        properties: {
          volume: 0.25,
          effects: [{id: "new-effect", kind: "blur", parameters: {radius: 2}}],
        },
      },
    },
  });
  assert.equal(Object.hasOwn(findClip(history.project, "video", "media-1").properties, "volume"), true);
  history = undoProjectHistory(history, 1);
  assert.deepEqual(content(history.project), content(before));
  assert.equal(Object.hasOwn(findClip(history.project, "video", "media-1").properties, "volume"), false);
  assert.equal(Object.hasOwn(findClip(history.project, "video", "media-1").properties, "effects"), false);
});

test("large metadata-only projects can be edited and undone without a clip limit", () => {
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
  const original = structuredClone(project);
  let history = createProjectHistory(project);
  history = execute(history, "move-clip", {
    trackId: "video", clipId: "clip-2999", timelineStart: r(40_000),
  });
  assert.equal(findTrack(history.project, "video").clips.length, 3_000);
  history = undoProjectHistory(history, 1);
  assert.deepEqual(content(history.project), content(original));
  assert.equal(history.entries[0].patches[0].clips.length, 1);
  assert.ok(
    history.entries[0].memoryBytes <
      Buffer.byteLength(JSON.stringify(original.tracks[0])),
  );
});
