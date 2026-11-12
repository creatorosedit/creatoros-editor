export interface TimedRange {
  start: number;
  end: number;
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

export function registerAbortCleanup(signal: AbortSignal, cleanup: () => void): () => void {
  let registered = true;
  const onAbort = () => {
    if (!registered) return;
    registered = false;
    cleanup();
  };
  signal.addEventListener("abort", onAbort, {once: true});
  if (signal.aborted) onAbort();
  return () => {
    registered = false;
    signal.removeEventListener("abort", onAbort);
  };
}

export function parseSilenceDetectionLog(log: string, duration: number): TimedRange[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const events = [...log.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/gu)];
  const ranges: TimedRange[] = [];
  let silenceStart: number | null = null;
  for (const event of events) {
    const time = Number(event[2]);
    if (!Number.isFinite(time)) continue;
    if (event[1] === "start") {
      silenceStart = time;
    } else if (silenceStart !== null) {
      ranges.push({start: silenceStart, end: time});
      silenceStart = null;
    }
  }
  if (silenceStart !== null) ranges.push({start: silenceStart, end: duration});
  return normalizeCutRanges(ranges, duration);
}

export function createSilenceReviewCandidates(
  detected: TimedRange[],
  duration: number,
  minDuration: number,
): TimedRange[] {
  if (!Number.isFinite(minDuration) || minDuration <= 0) return [];
  return normalizeCutRanges(detected, duration)
    .filter((range) => range.end - range.start >= minDuration);
}

export interface TimedClip extends TimedRange {
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

export interface AudioChunkPart {
  sourceStart: number;
  sourceEnd: number;
  speed: number;
}

export function getAudioChunkParts(
  clips: TimedClip[],
  chunkStart: number,
  chunkEnd: number,
): AudioChunkPart[] {
  return clips.flatMap((clip) => {
    const partStart = Math.max(chunkStart, clip.start);
    const partEnd = Math.min(chunkEnd, clip.end);
    if (partEnd - partStart <= 0.001) return [];
    if (!Number.isFinite(clip.speed) || clip.speed <= 0) {
      throw new Error("A timeline clip has an invalid playback speed.");
    }
    return [{
      sourceStart: clip.sourceStart + (partStart - clip.start) * clip.speed,
      sourceEnd: clip.sourceStart + (partEnd - clip.start) * clip.speed,
      speed: clip.speed,
    }];
  });
}

export function buildAudioChunkFilterGraph(parts: AudioChunkPart[], thresholdDb: number): string {
  if (parts.length === 0) throw new Error("At least one timeline clip is required for audio extraction.");
  if (!Number.isFinite(thresholdDb) || thresholdDb < -60 || thresholdDb > -10) {
    throw new Error("Silence threshold must be between -60 and -10 dB.");
  }
  const atempoFilters = (speed: number): string => {
    if (!Number.isFinite(speed) || speed <= 0) {
      throw new Error("A timeline clip has an invalid playback speed.");
    }
    let remaining = speed;
    const filters: string[] = [];
    while (remaining > 2) {
      filters.push("atempo=2");
      remaining /= 2;
    }
    while (remaining < 0.5) {
      filters.push("atempo=0.5");
      remaining /= 0.5;
    }
    filters.push(`atempo=${remaining}`);
    return filters.join(",");
  };
  const audioSplit = parts.length > 1
    ? `[0:a]asplit=${parts.length}${parts.map((_, index) => `[s${index}]`).join("")}`
    : "";
  const audioFilters = parts.map((part, index) => {
    const source = parts.length > 1 ? `[s${index}]` : "[0:a]";
    return `${source}atrim=start=${part.sourceStart}:end=${part.sourceEnd},asetpts=PTS-STARTPTS,${atempoFilters(part.speed)}[a${index}]`;
  });
  const audioInputs = parts.map((_, index) => `[a${index}]`).join("");
  return [
    ...(audioSplit ? [audioSplit] : []),
    ...audioFilters,
    `${audioInputs}concat=n=${parts.length}:v=0:a=1[joined]`,
    `[joined]silencedetect=noise=${thresholdDb}dB:d=0.05,anull[out]`,
  ].join(";");
}

export function getSourcePosition(
  clips: TimedClip[],
  time: number,
): {sourceTime: number; speed: number} | null {
  const clip = clips.find((item) => time >= item.start && time < item.end)
    ?? clips[clips.length - 1];
  if (!clip || time < clip.start || time > clip.end) return null;
  return {
    sourceTime: clip.sourceStart +
      Math.max(0, Math.min(clip.end - clip.start, time - clip.start)) * clip.speed,
    speed: clip.speed,
  };
}

export function reflowTimelineClips<T extends TimedClip>(clips: T[]): T[] {
  let cursor = 0;
  return [...clips]
    .sort((first, second) => first.start - second.start)
    .map((clip) => {
      const duration = Math.max(0, (clip.sourceEnd - clip.sourceStart) / clip.speed);
      const result = {...clip, start: cursor, end: cursor + duration};
      cursor = result.end;
      return result;
    })
    .filter((clip) => clip.end - clip.start > 0.001);
}

export function normalizeCutRanges(cuts: TimedRange[], duration?: number): TimedRange[] {
  const sorted = cuts
    .map(({start, end}) => ({
      start: duration === undefined ? start : Math.max(0, Math.min(duration, start)),
      end: duration === undefined ? end : Math.max(0, Math.min(duration, end)),
    }))
    .filter((cut) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end > cut.start)
    .sort((first, second) => first.start - second.start);
  const merged: TimedRange[] = [];
  for (const cut of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && cut.start <= previous.end) previous.end = Math.max(previous.end, cut.end);
    else merged.push({...cut});
  }
  return merged;
}

export function mapRangeAfterCuts(
  start: number,
  end: number,
  cuts: TimedRange[],
): TimedRange[] {
  const normalizedCuts = normalizeCutRanges(cuts);
  let fragments = [{start, end}];
  for (const cut of normalizedCuts) {
    fragments = fragments.flatMap((fragment) => {
      if (cut.end <= fragment.start || cut.start >= fragment.end) return [fragment];
      const remaining: TimedRange[] = [];
      if (cut.start > fragment.start) remaining.push({start: fragment.start, end: cut.start});
      if (cut.end < fragment.end) remaining.push({start: cut.end, end: fragment.end});
      return remaining;
    });
  }
  return fragments.map((fragment) => {
    const shift = normalizedCuts
      .filter((cut) => cut.end <= fragment.start)
      .reduce((total, cut) => total + cut.end - cut.start, 0);
    return {start: fragment.start - shift, end: fragment.end - shift};
  }).filter((fragment) => fragment.end - fragment.start > 0.02);
}

export function resolveWordIndexRange(
  words: TimedRange[],
  startIndex: number,
  endIndex: number,
  duration: number,
): TimedRange | null {
  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex >= words.length ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return null;
  }

  const range = words.slice(startIndex, endIndex + 1);
  if (range.some((word, offset) =>
    !Number.isFinite(word.start) ||
    !Number.isFinite(word.end) ||
    word.start < 0 ||
    word.end <= word.start ||
    word.end > duration ||
    (offset > 0 && word.start < (range[offset - 1]?.start ?? 0)),
  )) {
    return null;
  }
  const first = range[0];
  const last = range[range.length - 1];
  if (!first || !last || last.end <= first.start) return null;
  return {start: first.start, end: last.end};
}

export function splitTimelineClips(
  clips: TimedClip[],
  cuts: TimedRange[],
): Array<Pick<TimedClip, "start" | "sourceStart" | "sourceEnd" | "speed">> {
  const normalizedCuts = normalizeCutRanges(cuts);
  const fragments: Array<Pick<TimedClip, "start" | "sourceStart" | "sourceEnd" | "speed">> = [];
  for (const clip of [...clips].sort((first, second) => first.start - second.start)) {
    if (
      !Number.isFinite(clip.speed) ||
      clip.speed <= 0 ||
      clip.sourceEnd <= clip.sourceStart ||
      clip.end <= clip.start
    ) {
      continue;
    }
    let remaining = [{start: clip.start, end: clip.end}];
    for (const cut of normalizedCuts) {
      remaining = remaining.flatMap((fragment) => {
        if (cut.end <= fragment.start || cut.start >= fragment.end) return [fragment];
        const parts: TimedRange[] = [];
        if (cut.start > fragment.start) parts.push({start: fragment.start, end: cut.start});
        if (cut.end < fragment.end) parts.push({start: cut.end, end: fragment.end});
        return parts;
      });
    }
    for (const fragment of remaining) {
      const sourceStart = clip.sourceStart + (fragment.start - clip.start) * clip.speed;
      const sourceEnd = clip.sourceStart + (fragment.end - clip.start) * clip.speed;
      const boundedSourceStart = Math.max(clip.sourceStart, sourceStart);
      const boundedSourceEnd = Math.min(clip.sourceEnd, sourceEnd);
      if (boundedSourceEnd - boundedSourceStart > 0.05) {
        fragments.push({
          start: fragment.start,
          sourceStart: boundedSourceStart,
          sourceEnd: boundedSourceEnd,
          speed: clip.speed,
        });
      }
    }
  }
  return fragments;
}

export function detectSilencesFromRms(
  levels: number[],
  frameDuration: number,
  minDuration: number,
  padding = 0.08,
): TimedRange[] {
  if (
    levels.length === 0 ||
    !Number.isFinite(frameDuration) ||
    frameDuration <= 0 ||
    !Number.isFinite(minDuration) ||
    minDuration <= 0
  ) {
    return [];
  }
  const sortedLevels = [...levels].sort((first, second) => first - second);
  const lowerLevel = sortedLevels[Math.floor(sortedLevels.length * 0.2)] ?? 0;
  const speechLevel = sortedLevels[Math.floor(sortedLevels.length * 0.8)] ?? 0;
  if (speechLevel < 0.003) return [];
  const threshold = Math.max(0.001, Math.min(lowerLevel * 2, speechLevel * 0.15));
  const speechFrames = levels.map((level) => level >= threshold);
  for (let index = 1; index < speechFrames.length - 1; index += 1) {
    if (speechFrames[index - 1] && speechFrames[index + 1]) speechFrames[index] = true;
  }

  const silences: TimedRange[] = [];
  let silenceStart: number | null = null;
  for (let index = 0; index <= speechFrames.length; index += 1) {
    if (index < speechFrames.length && !speechFrames[index]) {
      silenceStart ??= index * frameDuration;
      continue;
    }
    if (silenceStart === null) continue;
    const silenceEnd = index * frameDuration;
    const start = Math.min(silenceEnd, silenceStart + padding);
    const end = Math.max(start, silenceEnd - padding);
    if (end - start >= minDuration) silences.push({start, end});
    silenceStart = null;
  }
  return silences;
}
