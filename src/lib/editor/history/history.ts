import {
  ProjectDocumentV1Schema,
  type ProjectClip,
  type ProjectDocumentV1,
  type Track,
} from "../project.ts";
import {applyProjectCommand} from "../commands/engine.ts";
import type {ProjectCommand} from "../commands/types.ts";

type TrackFields = Omit<Track, "clips">;

type ClipSnapshot = {
  index: number;
  clip: ProjectClip;
};

type ClipPatch = {
  id: string;
  before: ClipSnapshot | null;
  after: ClipSnapshot | null;
};

type TrackSnapshot =
  | {index: number; fullTrack: Track}
  | TrackFieldsSnapshot;

type TrackFieldsSnapshot = {
  index: number;
  fields: TrackFields;
  clipOrder?: readonly string[];
};

type TrackPatch = {
  id: string;
  before: TrackSnapshot | null;
  after: TrackSnapshot | null;
  clips: readonly ClipPatch[];
};

export type ProjectHistoryEntry = {
  commands: readonly ProjectCommand[];
  patches: readonly TrackPatch[];
  memoryBytes: number;
};

type ActiveGroup = {
  baseProject: ProjectDocumentV1;
  commands: readonly ProjectCommand[];
  patches: readonly TrackPatch[];
  commandBytes: number;
  patchBytes: number;
  stagedProjectBytes: number;
  memoryBytes: number;
};

export type ProjectHistory = {
  readonly project: ProjectDocumentV1;
  readonly entries: readonly ProjectHistoryEntry[];
  readonly cursor: number;
  readonly historyBytes: number;
  readonly maxHistoryBytes: number;
  readonly activeGroup: ActiveGroup | null;
};

export type ProjectHistoryOptions = {
  maxHistoryBytes?: number;
};

export type ProjectHistoryErrorCode =
  | "INVALID_PROJECT"
  | "INVALID_HISTORY_OPTIONS"
  | "STALE_REVISION"
  | "NO_UNDO"
  | "NO_REDO"
  | "GROUP_ACTIVE"
  | "NO_ACTIVE_GROUP"
  | "REVISION_OVERFLOW"
  | "HISTORY_CONFLICT"
  | "HISTORY_BUDGET_EXCEEDED";

export class ProjectHistoryError extends Error {
  readonly code: ProjectHistoryErrorCode;
  readonly details?: unknown;

  constructor(
    code: ProjectHistoryErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ProjectHistoryError";
    this.code = code;
    this.details = details;
  }
}

/**
 * The budget estimates UTF-8 serialized command and patch bytes, not runtime heap.
 * Oldest entries are evicted first; one oversized entry is retained alone so the
 * latest successful operation remains undoable.
 */
export const DEFAULT_PROJECT_HISTORY_MEMORY_BUDGET = 50 * 1024 * 1024;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function freeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach((child) => freeze(child));
  return Object.freeze(value);
}

function immutableHistory(history: ProjectHistory): ProjectHistory {
  return freeze(history);
}

function fail(
  code: ProjectHistoryErrorCode,
  message: string,
  details?: unknown,
): never {
  throw new ProjectHistoryError(code, message, details);
}

function equal(first: unknown, second: unknown): boolean {
  if (Object.is(first, second)) return true;
  if (typeof first !== "object" || first === null ||
    typeof second !== "object" || second === null) return false;
  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second) ||
      first.length !== second.length) return false;
    return first.every((value, index) => equal(value, second[index]));
  }
  const firstKeys = Object.keys(first);
  const secondKeys = Object.keys(second);
  if (firstKeys.length !== secondKeys.length) return false;
  return firstKeys.every((key) =>
    Object.hasOwn(second, key) &&
    equal(
      (first as Record<string, unknown>)[key],
      (second as Record<string, unknown>)[key],
    )
  );
}

function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) fail("HISTORY_CONFLICT", "History data is not serializable.");
  return new TextEncoder().encode(json).byteLength;
}

function assertRevision(project: ProjectDocumentV1, expectedRevision: number): void {
  if (expectedRevision !== project.revision) {
    fail(
      "STALE_REVISION",
      `History expected revision ${expectedRevision}, but project is at revision ${project.revision}.`,
      {expectedRevision, actualRevision: project.revision},
    );
  }
}

function assertCanIncrementRevision(project: ProjectDocumentV1): void {
  if (project.revision === Number.MAX_SAFE_INTEGER) {
    fail("REVISION_OVERFLOW", "Project revision cannot be incremented safely.");
  }
}

function trackFields(track: Track): TrackFields {
  const {clips: _clips, ...fields} = track;
  return fields;
}

function tracksById(project: ProjectDocumentV1): Map<string, {index: number; track: Track}> {
  return new Map(project.tracks.map((track, index) => [
    track.id,
    {index, track},
  ]));
}

function clipsById(track: Track): Map<string, ClipSnapshot> {
  return new Map(track.clips.map((clip, index) => [clip.id, {index, clip}]));
}

function createClipPatches(before: Track, after: Track): ClipPatch[] {
  const beforeClips = clipsById(before);
  const afterClips = clipsById(after);
  const ids = new Set([...beforeClips.keys(), ...afterClips.keys()]);
  const patches: ClipPatch[] = [];

  for (const id of ids) {
    const previous = beforeClips.get(id) ?? null;
    const next = afterClips.get(id) ?? null;
    if (previous && next && equal(previous.clip, next.clip)) continue;
    patches.push({
      id,
      before: previous ? {index: previous.index, clip: clone(previous.clip)} : null,
      after: next ? {index: next.index, clip: clone(next.clip)} : null,
    });
  }
  return patches;
}

function hasRelativeOrderChange(
  before: Track,
  after: Track,
  changedIds: ReadonlySet<string>,
): boolean {
  const afterIds = new Set(after.clips.map((clip) => clip.id));
  const beforeIds = new Set(before.clips.map((clip) => clip.id));
  const beforeShared = before.clips
    .map((clip) => clip.id)
    .filter((id) => !changedIds.has(id) && afterIds.has(id));
  const afterShared = after.clips
    .map((clip) => clip.id)
    .filter((id) => !changedIds.has(id) && beforeIds.has(id));
  return !equal(beforeShared, afterShared);
}

function makeTrackSnapshot(
  track: Track,
  index: number,
  fullTrack: boolean,
  includeClipOrder: boolean,
): TrackSnapshot {
  if (fullTrack) return {index, fullTrack: clone(track)};
  return {
    index,
    fields: clone(trackFields(track)),
    ...(includeClipOrder ? {clipOrder: track.clips.map((clip) => clip.id)} : {}),
  };
}

function createPatches(
  before: ProjectDocumentV1,
  after: ProjectDocumentV1,
): TrackPatch[] {
  const beforeTracks = tracksById(before);
  const afterTracks = tracksById(after);
  const ids = new Set([...beforeTracks.keys(), ...afterTracks.keys()]);
  const patches: TrackPatch[] = [];

  for (const id of ids) {
    const previous = beforeTracks.get(id) ?? null;
    const next = afterTracks.get(id) ?? null;
    if (!previous || !next) {
      patches.push({
        id,
        before: previous
          ? makeTrackSnapshot(previous.track, previous.index, true, false)
          : null,
        after: next
          ? makeTrackSnapshot(next.track, next.index, true, false)
          : null,
        clips: [],
      });
      continue;
    }

    const clipPatches = createClipPatches(previous.track, next.track);
    const changedClipIds = new Set(clipPatches.map((patch) => patch.id));
    const clipOrderChanged = hasRelativeOrderChange(
      previous.track,
      next.track,
      changedClipIds,
    );
    const fieldsChanged = !equal(
      trackFields(previous.track),
      trackFields(next.track),
    );
    if (!fieldsChanged && clipPatches.length === 0 && !clipOrderChanged) continue;

    patches.push({
      id,
      before: makeTrackSnapshot(
        previous.track,
        previous.index,
        false,
        clipOrderChanged,
      ),
      after: makeTrackSnapshot(next.track, next.index, false, clipOrderChanged),
      clips: clipPatches,
    });
  }
  return patches;
}

function createEntry(
  before: ProjectDocumentV1,
  after: ProjectDocumentV1,
  commands: readonly ProjectCommand[],
): ProjectHistoryEntry {
  const entryWithoutSize = {
    commands: clone(commands),
    patches: createPatches(before, after),
  };
  return {...entryWithoutSize, memoryBytes: serializedBytes(entryWithoutSize)};
}

function replayGroupProject(group: ActiveGroup): ProjectDocumentV1 {
  let project = group.baseProject;
  for (const command of group.commands) {
    project = applyProjectCommand(project, command).project;
  }
  return project;
}

function createGroupMemoryStats(
  commands: readonly ProjectCommand[],
  patches: readonly TrackPatch[],
): Pick<
  ActiveGroup,
  "commandBytes" | "patchBytes" | "stagedProjectBytes" | "memoryBytes"
> {
  const commandBytes = serializedBytes(commands);
  const patchBytes = serializedBytes(patches);
  // The staged project is reconstructed on demand and is never retained here.
  return {
    commandBytes,
    patchBytes,
    stagedProjectBytes: 0,
    memoryBytes: serializedBytes({commands, patches}),
  };
}

function pushEntry(
  history: ProjectHistory,
  project: ProjectDocumentV1,
  entry: ProjectHistoryEntry,
): ProjectHistory {
  const entries = [...history.entries.slice(0, history.cursor), entry];
  let historyBytes = entries.reduce((sum, item) => sum + item.memoryBytes, 0);
  // Keep the new operation even when it alone exceeds the budget.
  while (entries.length > 1 && historyBytes > history.maxHistoryBytes) {
    const evicted = entries.shift();
    if (evicted) historyBytes -= evicted.memoryBytes;
  }
  return immutableHistory({
    ...history,
    project,
    entries,
    cursor: entries.length,
    historyBytes,
    activeGroup: null,
  });
}

function insertClips(
  current: Track,
  expected: TrackFieldsSnapshot,
  target: TrackFieldsSnapshot,
  patches: readonly ClipPatch[],
  direction: "before" | "after",
): ProjectClip[] {
  const changedIds = new Set(patches.map((patch) => patch.id));
  const currentById = clipsById(current);
  for (const patch of patches) {
    const expectedClip = patch[direction === "before" ? "after" : "before"];
    const found = currentById.get(patch.id) ?? null;
    if (
      (expectedClip === null && found !== null) ||
      (expectedClip !== null && (
        found === null ||
        found.index !== expectedClip.index ||
        !equal(found.clip, expectedClip.clip)
      ))
    ) {
      fail("HISTORY_CONFLICT", `Clip ${patch.id} no longer matches the history entry.`);
    }
  }

  const remaining = current.clips.filter((clip) => !changedIds.has(clip.id));
  const targetClips = patches
    .map((patch) => patch[direction])
    .filter((snapshot): snapshot is ClipSnapshot => snapshot !== null)
    .sort((first, second) => first.index - second.index);
  if (target.clipOrder) {
    const clips = new Map(remaining.map((clip) => [clip.id, clip]));
    targetClips.forEach(({clip}) => clips.set(clip.id, clone(clip)));
    if (clips.size !== target.clipOrder.length) {
      fail("HISTORY_CONFLICT", "History clip ordering is inconsistent.");
    }
    return target.clipOrder.map((id) => {
      const clip = clips.get(id);
      if (!clip) fail("HISTORY_CONFLICT", `Clip ${id} is missing from history order.`);
      return clip;
    });
  }

  const ordered: Array<ProjectClip | undefined> =
    Array.from({length: remaining.length + targetClips.length});
  for (const snapshot of targetClips) {
    if (
      snapshot.index < 0 ||
      snapshot.index >= ordered.length ||
      ordered[snapshot.index] !== undefined
    ) {
      fail("HISTORY_CONFLICT", "History clip positions are inconsistent.");
    }
    ordered[snapshot.index] = clone(snapshot.clip);
  }
  let remainingIndex = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index] === undefined) {
      ordered[index] = remaining[remainingIndex];
      remainingIndex += 1;
    }
  }
  return ordered as ProjectClip[];
}

function insertTracks(
  project: ProjectDocumentV1,
  patches: readonly TrackPatch[],
  direction: "before" | "after",
): Track[] {
  const patchedIds = new Set(patches.map((patch) => patch.id));
  const currentTracks = tracksById(project);
  const replacements: Array<{index: number; track: Track}> = [];

  for (const patch of patches) {
    const expected = patch[direction === "before" ? "after" : "before"];
    const target = patch[direction];
    const current = currentTracks.get(patch.id) ?? null;

    if (
      (expected === null && current !== null) ||
      (expected !== null && current === null)
    ) {
      fail("HISTORY_CONFLICT", `Track ${patch.id} no longer matches the history entry.`);
    }
    if (expected && current) {
      if (current.index !== expected.index) {
        fail("HISTORY_CONFLICT", `Track ${patch.id} changed position unexpectedly.`);
      }
      if ("fullTrack" in expected) {
        if (!equal(current.track, expected.fullTrack)) {
          fail("HISTORY_CONFLICT", `Track ${patch.id} no longer matches the history entry.`);
        }
      } else {
        if (!equal(trackFields(current.track), expected.fields)) {
          fail("HISTORY_CONFLICT", `Track ${patch.id} properties changed unexpectedly.`);
        }
        if (expected.clipOrder && !equal(
          current.track.clips.map((clip) => clip.id),
          expected.clipOrder,
        )) {
          fail("HISTORY_CONFLICT", `Track ${patch.id} clip order changed unexpectedly.`);
        }
            const targetState = target;
            if (!targetState || "fullTrack" in targetState) {
          fail("HISTORY_CONFLICT", `Track ${patch.id} patch is inconsistent.`);
        }
            const clips = insertClips(
              current.track,
              expected,
              targetState,
              patch.clips,
              direction,
            );
        replacements.push({
          index: targetState.index,
          track: {...clone(targetState.fields), clips},
        });
        continue;
      }
    }
    if (target) {
      if ("fullTrack" in target) {
        replacements.push({index: target.index, track: clone(target.fullTrack)});
      } else {
        fail("HISTORY_CONFLICT", `Track ${patch.id} is missing its track data.`);
      }
    }
  }

  const remaining = project.tracks.filter((track) => !patchedIds.has(track.id));
  const ordered: Array<Track | undefined> =
    Array.from({length: remaining.length + replacements.length});
  for (const replacement of replacements) {
    if (
      replacement.index < 0 ||
      replacement.index >= ordered.length ||
      ordered[replacement.index] !== undefined
    ) {
      fail("HISTORY_CONFLICT", "History track positions are inconsistent.");
    }
    ordered[replacement.index] = replacement.track;
  }
  let remainingIndex = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index] === undefined) {
      ordered[index] = remaining[remainingIndex];
      remainingIndex += 1;
    }
  }
  return ordered as Track[];
}

function applyPatches(
  project: ProjectDocumentV1,
  patches: readonly TrackPatch[],
  direction: "before" | "after",
): ProjectDocumentV1 {
  const tracks = insertTracks(project, patches, direction);
  assertCanIncrementRevision(project);
  const candidate: ProjectDocumentV1 = {
    ...project,
    revision: project.revision + 1,
    tracks,
  };
  const parsed = ProjectDocumentV1Schema.safeParse(candidate);
  if (!parsed.success) {
    fail("HISTORY_CONFLICT", "History operation would produce an invalid project.", parsed.error.issues);
  }
  return clone(parsed.data);
}

export function createProjectHistory(
  project: ProjectDocumentV1,
  options: ProjectHistoryOptions = {},
): ProjectHistory {
  const maxHistoryBytes = options.maxHistoryBytes ??
    DEFAULT_PROJECT_HISTORY_MEMORY_BUDGET;
  if (!Number.isSafeInteger(maxHistoryBytes) || maxHistoryBytes <= 0) {
    fail("INVALID_HISTORY_OPTIONS", "maxHistoryBytes must be a positive safe integer.");
  }
  const parsed = ProjectDocumentV1Schema.safeParse(project);
  if (!parsed.success) {
    fail("INVALID_PROJECT", "Cannot create history for an invalid project.", parsed.error.issues);
  }
  return immutableHistory({
    project: clone(parsed.data),
    entries: [],
    cursor: 0,
    historyBytes: 0,
    maxHistoryBytes,
    activeGroup: null,
  });
}

export function getHistoryCurrentProject(history: ProjectHistory): ProjectDocumentV1 {
  if (!history.activeGroup) return history.project;
  return freeze(replayGroupProject(history.activeGroup));
}

export function executeProjectCommand(
  history: ProjectHistory,
  input: unknown,
): ProjectHistory {
  const currentProject = getHistoryCurrentProject(history);
  const result = applyProjectCommand(currentProject, input);

  if (history.activeGroup) {
    const commands = [...history.activeGroup.commands, result.command];
    const patches = createPatches(history.activeGroup.baseProject, result.project);
    const stats = createGroupMemoryStats(commands, patches);
    const aggregateBytes = history.historyBytes + stats.memoryBytes +
      stats.stagedProjectBytes;
    const oversizedFirstOperation =
      history.activeGroup.commands.length === 0 &&
      history.entries.length === 0 &&
      aggregateBytes > history.maxHistoryBytes;
    if (aggregateBytes > history.maxHistoryBytes && !oversizedFirstOperation) {
      fail(
        "HISTORY_BUDGET_EXCEEDED",
        "Active history group would exceed the aggregate history memory budget.",
        {
          committedBytes: history.historyBytes,
          stagedBytes: stats.memoryBytes,
          stagedProjectBytes: stats.stagedProjectBytes,
          aggregateBytes,
          maxHistoryBytes: history.maxHistoryBytes,
        },
      );
    }
    return immutableHistory({
      ...history,
      activeGroup: {
        ...history.activeGroup,
        commands,
        patches,
        ...stats,
      },
    });
  }

  const entry = createEntry(history.project, result.project, [result.command]);
  return pushEntry(history, result.project, entry);
}

export function undoProjectHistory(
  history: ProjectHistory,
  expectedRevision: number,
): ProjectHistory {
  if (history.activeGroup) fail("GROUP_ACTIVE", "Cannot undo while a history group is active.");
  assertRevision(history.project, expectedRevision);
  if (history.cursor === 0) fail("NO_UNDO", "There is no project history to undo.");
  const entry = history.entries[history.cursor - 1];
  if (!entry) fail("HISTORY_CONFLICT", "Undo history entry is missing.");

  const project = applyPatches(history.project, entry.patches, "before");
  return immutableHistory({
    ...history,
    project,
    cursor: history.cursor - 1,
  });
}

export function redoProjectHistory(
  history: ProjectHistory,
  expectedRevision: number,
): ProjectHistory {
  if (history.activeGroup) fail("GROUP_ACTIVE", "Cannot redo while a history group is active.");
  assertRevision(history.project, expectedRevision);
  if (history.cursor >= history.entries.length) fail("NO_REDO", "There is no project history to redo.");
  const entry = history.entries[history.cursor];
  if (!entry) fail("HISTORY_CONFLICT", "Redo history entry is missing.");

  const project = applyPatches(history.project, entry.patches, "after");
  return immutableHistory({
    ...history,
    project,
    cursor: history.cursor + 1,
  });
}

export function beginHistoryGroup(
  history: ProjectHistory,
  expectedRevision: number,
): ProjectHistory {
  if (history.activeGroup) fail("GROUP_ACTIVE", "A history group is already active.");
  assertRevision(history.project, expectedRevision);
  // Commands are replayed from this frozen base; no staged project clone is retained.
  return immutableHistory({
    ...history,
    activeGroup: {
      baseProject: history.project,
      commands: [],
      patches: [],
      commandBytes: 0,
      patchBytes: 0,
      stagedProjectBytes: 0,
      memoryBytes: 0,
    },
  });
}

export function commitHistoryGroup(
  history: ProjectHistory,
  expectedRevision: number,
): ProjectHistory {
  const group = history.activeGroup;
  if (!group) fail("NO_ACTIVE_GROUP", "There is no active history group to commit.");
  const workingProject = replayGroupProject(group);
  assertRevision(workingProject, expectedRevision);
  if (!equal(history.project, group.baseProject)) {
    fail("HISTORY_CONFLICT", "Project changed while the history group was active.");
  }
  if (group.commands.length === 0) {
    return immutableHistory({...history, activeGroup: null});
  }
  const entryData = {commands: group.commands, patches: group.patches};
  const entry: ProjectHistoryEntry = {
    ...entryData,
    memoryBytes: serializedBytes(entryData),
  };
  return pushEntry(history, workingProject, entry);
}

export function cancelHistoryGroup(
  history: ProjectHistory,
  expectedRevision: number,
): ProjectHistory {
  const group = history.activeGroup;
  if (!group) fail("NO_ACTIVE_GROUP", "There is no active history group to cancel.");
  assertRevision(replayGroupProject(group), expectedRevision);
  if (!equal(history.project, group.baseProject)) {
    fail("HISTORY_CONFLICT", "Project changed while the history group was active.");
  }
  return immutableHistory({...history, activeGroup: null});
}

export function canUndo(history: ProjectHistory): boolean {
  return history.activeGroup === null && history.cursor > 0;
}

export function canRedo(history: ProjectHistory): boolean {
  return history.activeGroup === null && history.cursor < history.entries.length;
}
