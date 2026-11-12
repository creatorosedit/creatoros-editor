"use client";
import { EffectsPanel } from "@/components/effects/EffectsPanel";
import { CaptionPanel } from "@/components/captions/CaptionPanel";
import { CaptionOverlay } from "@/components/captions/CaptionOverlay";
import { AIChatPanel } from "@/components/editor/AIChatPanel";
import {
  buildEditorContext,
  type EditorContext,
  type VideoClip,
} from "@/lib/editor/editor-context";
import {
  buildAudioChunkFilterGraph,
  createSilenceReviewCandidates,
  getAudioChunkParts,
  getSourcePosition,
  mapRangeAfterCuts,
  normalizeCutRanges,
  parseSilenceDetectionLog,
  registerAbortCleanup,
  reflowTimelineClips,
  splitTimelineClips,
  throwIfAborted,
} from "@/lib/video/auto-cut";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import {useRouter, useSearchParams } from "next/navigation";
import {
  Captions,
  ChevronLeft,
  Maximize,
  Redo,
  Sparkles,
  Undo,
  Upload,
  X,
} from "lucide-react";
import { getVideoFromOPFS, saveVideoToOPFS } from "@/lib/video/opfs";

interface ReviewSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  isSuggestedCut: boolean;
  reason: "silence" | "retake" | null;
  explanation?: string;
  bestTakeText?: string;
}

interface SilenceReviewCandidate {
  id: string;
  start: number;
  end: number;
}

const PIXELS_PER_SECOND = 50;

function formatTime(time: number): string {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

async function createAbortableBlobUrl(url: string, mimeType: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, {signal});
  if (!response.ok) throw new Error(`Could not load FFmpeg resource (HTTP ${response.status}).`);
  const blobUrl = URL.createObjectURL(new Blob([await response.blob()], {type: mimeType}));
  if (signal.aborted) {
    URL.revokeObjectURL(blobUrl);
    throwIfAborted(signal);
  }
  return blobUrl;
}

function parseCaptionTime(value: string): number | null {
  const parts = value.replace(",", ".").split(":").map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) ? seconds : null;
}

function parseSrt(text: string): Array<{start: number; end: number; text: string}> {
  const captions: Array<{start: number; end: number; text: string}> = [];
  for (const block of text.replace(/\r/gu, "").split(/\n{2,}/u)) {
    const lines = block.split("\n");
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex]?.match(
      /((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})\s+-->\s+((?:\d{2}:)?\d{2}:\d{2}[,.]\d{3})/u,
    );
    if (!timing?.[1] || !timing[2]) continue;
    const start = parseCaptionTime(timing[1]);
    const end = parseCaptionTime(timing[2]);
    const captionText = lines.slice(timingIndex + 1).join(" ").trim();
    if (start !== null && end !== null && end > start && captionText) {
      captions.push({start, end, text: captionText});
    }
  }
  return captions;
}

function createClip(sourceStart: number, sourceEnd: number, start: number, speed = 1): VideoClip {
  return {
    id: crypto.randomUUID(),
    start,
    end: start + (sourceEnd - sourceStart) / speed,
    sourceStart,
    sourceEnd,
    speed,
  };
}

function StudioEditor() {
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [saturation, setSaturation] = useState(100);
  const [captions, setCaptions] = useState<Array<{start: number; end: number; text: string}>>([]);
  const [captionStyle, setCaptionStyle] = useState("classic");
  const [isEffectsPanelOpen, setIsEffectsPanelOpen] = useState(false);
  const [isCaptionPanelOpen, setIsCaptionPanelOpen] = useState(false);
  const [wordsPerLine, setWordsPerLine] = useState(4);
  const [viewMode, setViewMode] = useState<"editor" | "chat">("editor");
  const [selectedClipTimeStr, setSelectedClipTimeStr] = useState<string | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedFormat = searchParams.get("format");
  const format = (["9:16", "16:9", "1:1", "4:5"] as const).find((ratio) => ratio === requestedFormat) ?? "9:16";
  const draftId = searchParams.get("draftId") ?? searchParams.get("id");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineScrollerRef = useRef<HTMLDivElement>(null);
  const currentTimeRef = useRef(0);
  const clipsRef = useRef<VideoClip[]>([]);
  const undoHistoryRef = useRef<VideoClip[][]>([]);
  const redoHistoryRef = useRef<VideoClip[][]>([]);
  const projectIdRef = useRef(draftId);
  const videoMetadataRef = useRef<{duration: number; width: number | null; height: number | null} | null>(null);
  const autoCutControllerRef = useRef<AbortController | null>(null);
  const timelineDurationRef = useRef(0);
  const videoObjectUrlRef = useRef<string | null>(null);
  const editorContextRef = useRef<EditorContext | null>(null);
  const cancelAutoCut = useCallback(() => {
    const controller = autoCutControllerRef.current;
    autoCutControllerRef.current = null;
    controller?.abort();
  }, []);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [videoMetadata, setVideoMetadata] = useState<{duration: number; width: number | null; height: number | null} | null>(null);
  const [clips, setClips] = useState<VideoClip[]>([]);
  const [timelineDuration, setTimelineDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [manualRangeStart, setManualRangeStart] = useState<number | null>(null);
  const [manualRangeEnd, setManualRangeEnd] = useState<number | null>(null);
  const videoVolume = 1;
  const [minimumSilenceDuration, setMinimumSilenceDuration] = useState(0.7);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-35);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewSegments, setReviewSegments] = useState<ReviewSegment[]>([]);
  const [silenceReview, setSilenceReview] = useState<SilenceReviewCandidate[]>([]);
  const [selectedCutIds, setSelectedCutIds] = useState<Set<string>>(new Set());
  const [contextRevision, setContextRevision] = useState(0);
  const [contextSynchronizationStatus, setContextSynchronizationStatus] =
    useState<EditorContext["synchronizationStatus"]>("synchronized");

  clipsRef.current = clips;
  timelineDurationRef.current = timelineDuration;
  const contextProjectMatches = projectIdRef.current === draftId;

  const structuralEditorContext = useMemo(() => buildEditorContext({
    projectId: draftId,
    mediaId: null,
    sourceMedia: contextProjectMatches && videoFile
      ? {
          filename: videoFile.name,
          mimeType: videoFile.type || null,
          duration: videoMetadata?.duration ?? null,
          width: videoMetadata?.width ?? null,
          height: videoMetadata?.height ?? null,
        }
      : null,
    clips: contextProjectMatches ? clips : [],
    timelineDuration: contextProjectMatches ? timelineDuration : 0,
    selectedClipId: contextProjectMatches ? selectedClipId : null,
    selectedRange: contextProjectMatches && (manualRangeStart !== null || manualRangeEnd !== null)
      ? {in: manualRangeStart, out: manualRangeEnd}
      : null,
    playheadPosition: contextProjectMatches ? currentTimeRef.current : 0,
    originalScript: null,
    revision: contextRevision,
    synchronizationStatus: contextProjectMatches ? contextSynchronizationStatus : "loading",
  }), [
    clips,
    contextProjectMatches,
    contextRevision,
    contextSynchronizationStatus,
    draftId,
    manualRangeEnd,
    manualRangeStart,
    selectedClipId,
    timelineDuration,
    videoFile,
    videoMetadata,
  ]);
  const editorContext = useMemo(
    () => ({...structuralEditorContext, playheadPosition: currentTime}),
    [currentTime, structuralEditorContext],
  );
  editorContextRef.current = editorContext;
  const editorContextSummary = useMemo(() => ({
    projectId: structuralEditorContext.projectId,
    videoFilename: structuralEditorContext.videoFilename,
    timelineClipCount: structuralEditorContext.timelineClips.length,
    selectedClipIds: structuralEditorContext.selectedClipIds,
    selectedRange: structuralEditorContext.selectedRange,
    synchronizationStatus: structuralEditorContext.synchronizationStatus,
  }), [structuralEditorContext]);
  const getEditorContext = useCallback(() => editorContextRef.current, []);

  const incrementContextRevision = useCallback(() => {
    setContextRevision((revision) => revision + 1);
  }, []);

  const updateTimelineTime = useCallback((time: number) => {
    const boundedTime = Math.max(0, Math.min(timelineDurationRef.current, time));
    currentTimeRef.current = boundedTime;
    if (editorContextRef.current) {
      editorContextRef.current = {...editorContextRef.current, playheadPosition: boundedTime};
    }
    setCurrentTime(boundedTime);
  }, []);

  const updateClips = useCallback((nextClips: VideoClip[]) => {
    cancelAutoCut();
    undoHistoryRef.current.push(clipsRef.current);
    redoHistoryRef.current = [];
    const reflowed = reflowTimelineClips(nextClips);
    const nextDuration = reflowed[reflowed.length - 1]?.end ?? 0;
    clipsRef.current = reflowed;
    timelineDurationRef.current = nextDuration;
    incrementContextRevision();
    setClips(reflowed);
    setTimelineDuration(nextDuration);
    setCurrentTime((time) => {
      const boundedTime = Math.min(time, nextDuration);
      currentTimeRef.current = boundedTime;
      return boundedTime;
    });
  }, [cancelAutoCut, incrementContextRevision]);

  const restoreClips = useCallback((nextClips: VideoClip[]) => {
    cancelAutoCut();
    const reflowed = reflowTimelineClips(nextClips);
    const nextDuration = reflowed[reflowed.length - 1]?.end ?? 0;
    const targetTime = Math.max(0, Math.min(currentTimeRef.current, nextDuration));
    clipsRef.current = reflowed;
    timelineDurationRef.current = nextDuration;
    incrementContextRevision();
    setClips(reflowed);
    setTimelineDuration(nextDuration);
    currentTimeRef.current = targetTime;
    setCurrentTime(targetTime);
    const sourcePosition = getSourcePosition(reflowed, targetTime);
    if (sourcePosition && videoRef.current) {
      videoRef.current.currentTime = sourcePosition.sourceTime;
      videoRef.current.playbackRate = sourcePosition.speed;
    }
  }, [cancelAutoCut, incrementContextRevision]);

  const undoClips = useCallback(() => {
    const previous = undoHistoryRef.current.pop();
    if (!previous) return;
    redoHistoryRef.current.push(clipsRef.current);
    restoreClips(previous);
  }, [restoreClips]);

  const redoClips = useCallback(() => {
    const next = redoHistoryRef.current.pop();
    if (!next) return;
    undoHistoryRef.current.push(clipsRef.current);
    restoreClips(next);
  }, [restoreClips]);

  const setVideoSource = useCallback((file: File | null) => {
    cancelAutoCut();
    videoRef.current?.pause();
    editorContextRef.current = null;
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    videoObjectUrlRef.current = null;
    videoMetadataRef.current = null;
    setVideoMetadata(null);
    setReviewSegments([]);
    setSilenceReview([]);
    setSelectedCutIds(new Set());
    setManualRangeStart(null);
    setManualRangeEnd(null);
    const url = file ? URL.createObjectURL(file) : null;
    videoObjectUrlRef.current = url;
    setVideoFile(file);
    setVideoUrl(url);
    incrementContextRevision();
    undoHistoryRef.current = [];
    redoHistoryRef.current = [];
    setClips([]);
    setTimelineDuration(0);
    setCurrentTime(0);
    currentTimeRef.current = 0;
    setSelectedClipId(null);
    setSelectedClipTimeStr(null);
    setIsPlaying(false);
  }, [cancelAutoCut, incrementContextRevision]);

  useEffect(() => () => {
    cancelAutoCut();
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
  }, [cancelAutoCut]);

  useEffect(() => {
    let cancelled = false;
    if (projectIdRef.current !== draftId) {
      projectIdRef.current = draftId;
      incrementContextRevision();
      setVideoSource(null);
    }
    setContextSynchronizationStatus(draftId ? "loading" : "synchronized");
    if (!draftId) return () => {
      cancelled = true;
    };
    void getVideoFromOPFS(draftId).then((file) => {
      if (cancelled) return;
      if (file) setVideoSource(file);
      setContextSynchronizationStatus("synchronized");
    }).catch((error: unknown) => {
      console.error("Failed to load draft video:", error);
      if (!cancelled) setContextSynchronizationStatus("error");
    });
    return () => {
      cancelled = true;
    };
  }, [draftId, incrementContextRevision, setVideoSource]);

  const onVideoLoaded = useCallback((video: HTMLVideoElement) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const nextMetadata = {
      duration: video.duration,
      width: video.videoWidth > 0 ? video.videoWidth : null,
      height: video.videoHeight > 0 ? video.videoHeight : null,
    };
    const previousMetadata = videoMetadataRef.current;
    if (
      !previousMetadata ||
      previousMetadata.duration !== nextMetadata.duration ||
      previousMetadata.width !== nextMetadata.width ||
      previousMetadata.height !== nextMetadata.height
    ) {
      videoMetadataRef.current = nextMetadata;
      setVideoMetadata(nextMetadata);
      incrementContextRevision();
    }
    if (clipsRef.current.length === 0) {
      const initialClip = createClip(0, video.duration, 0);
      clipsRef.current = [initialClip];
      timelineDurationRef.current = video.duration;
      incrementContextRevision();
      setClips([initialClip]);
      setTimelineDuration(video.duration);
    }
  }, [incrementContextRevision]);

  const safePlay = useCallback((video: HTMLVideoElement) => {
    const handlePlayError = (error: unknown) => {
      const errorName = typeof error === "object" && error !== null && "name" in error
        ? error.name
        : undefined;
      if (errorName === "AbortError") return;
      console.error("Video playback failed:", error);
      setNotice("Video playback could not start.");
      setIsPlaying(false);
    };

    try {
      const playPromise = video.play();
      if (playPromise !== undefined) void playPromise.catch(handlePlayError);
    } catch (error: unknown) {
      handlePlayError(error);
    }
  }, []);



  const onVideoTimeUpdate = useCallback((video: HTMLVideoElement) => {
    const sourceTime = video.currentTime;
    const activeClipIndex = clipsRef.current.findIndex((clip) =>
      sourceTime >= clip.sourceStart && sourceTime < clip.sourceEnd,
    );
    const activeClip = clipsRef.current[activeClipIndex];

    if (!activeClip) {
      const nextClip = clipsRef.current.find((clip) => clip.sourceStart >= sourceTime);
      const lastClip = clipsRef.current[clipsRef.current.length - 1];
      if (nextClip) {
        video.currentTime = nextClip.sourceStart;
        video.playbackRate = nextClip.speed;
        updateTimelineTime(nextClip.start);
      } else if (lastClip && sourceTime >= lastClip.sourceEnd - 0.025) {
        video.pause();
        updateTimelineTime(timelineDurationRef.current);
        setIsPlaying(false);
      }
      return;
    }

    video.playbackRate = activeClip.speed;
    updateTimelineTime(activeClip.start + (sourceTime - activeClip.sourceStart) / activeClip.speed);

    if (sourceTime >= activeClip.sourceEnd - 0.025) {
      const nextClip = clipsRef.current[activeClipIndex + 1];
      if (nextClip) {
        video.currentTime = nextClip.sourceStart;
        video.playbackRate = nextClip.speed;
        updateTimelineTime(nextClip.start);
      } else {
        video.pause();
        updateTimelineTime(timelineDurationRef.current);
        setIsPlaying(false);
      }
    }
  }, [updateTimelineTime]);

  const togglePlayback = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
      return;
    }

    let targetTime = currentTimeRef.current;
    if (targetTime >= timelineDurationRef.current && clipsRef.current[0]) {
      targetTime = 0;
      updateTimelineTime(0);
    }
    const clip = clipsRef.current.find((item) => targetTime >= item.start && targetTime < item.end);
    if (!clip) return;
    video.currentTime = clip.sourceStart + (targetTime - clip.start) * clip.speed;
    video.playbackRate = clip.speed;
    video.volume = videoVolume;
    video.muted = false;
    safePlay(video);
    setIsPlaying(true);
  }, [isPlaying, safePlay, updateTimelineTime, videoVolume]);

  const extractAudioInChunks = useCallback(async (
    file: File,
    signal: AbortSignal,
    minDuration: number,
    thresholdDb: number,
  ) => {
    const {FFmpeg, FFFSType} = await import("@ffmpeg/ffmpeg");
    throwIfAborted(signal);
    const ffmpeg = new FFmpeg();
    const coreBaseUrl = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
    const logs: string[] = [];
    const onLog = ({message}: {message: string}) => logs.push(message);
    const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "mp4";
    const inputName = `input.${extension}`;
    const inputDirectory = "/source";
    const inputPath = `${inputDirectory}/${inputName}`;
    const outputName = "audio-chunk.wav";
    const timelineClips = [...clipsRef.current].sort((first, second) => first.start - second.start);
    const timelineDuration = timelineClips[timelineClips.length - 1]?.end ?? 0;
    if (timelineClips.length === 0 || timelineDuration <= 0) {
      throw new Error("The video timeline is empty.");
    }

    let terminated = false;
    let inputDirectoryCreated = false;
    let inputMounted = false;
    let logHandlerAttached = false;
    let coreBlobUrl: string | null = null;
    let wasmBlobUrl: string | null = null;
    const terminate = () => {
      if (terminated) return;
      terminated = true;
      ffmpeg.terminate();
    };
    const removeAbortCleanup = registerAbortCleanup(signal, terminate);
    const detectedSilences: Array<{start: number; end: number}> = [];

    try {
      coreBlobUrl = await createAbortableBlobUrl(
        `${coreBaseUrl}/ffmpeg-core.js`,
        "text/javascript",
        signal,
      );
      wasmBlobUrl = await createAbortableBlobUrl(
        `${coreBaseUrl}/ffmpeg-core.wasm`,
        "application/wasm",
        signal,
      );
      throwIfAborted(signal);
      await ffmpeg.load({coreURL: coreBlobUrl, wasmURL: wasmBlobUrl});
      throwIfAborted(signal);
      URL.revokeObjectURL(coreBlobUrl);
      URL.revokeObjectURL(wasmBlobUrl);
      coreBlobUrl = null;
      wasmBlobUrl = null;
      const directoryCreated = await ffmpeg.createDir(inputDirectory);
      if (!directoryCreated) {
        throw new Error("FFmpeg could not prepare local media storage.");
      }
      inputDirectoryCreated = true;
      const mounted = await ffmpeg.mount(
        FFFSType.WORKERFS,
        {blobs: [{name: inputName, data: file}]},
        inputDirectory,
      );
      if (!mounted) {
        throw new Error("This browser cannot process the local video without copying it into memory.");
      }
      inputMounted = true;
      ffmpeg.on("log", onLog);
      logHandlerAttached = true;
      throwIfAborted(signal);

      const chunkDuration = 60;
      for (let chunkStart = 0; chunkStart < timelineDuration; chunkStart += chunkDuration) {
        throwIfAborted(signal);
        const chunkEnd = Math.min(timelineDuration, chunkStart + chunkDuration);
        const parts = getAudioChunkParts(timelineClips, chunkStart, chunkEnd);
        if (parts.length === 0) continue;
        const filterGraph = buildAudioChunkFilterGraph(parts, thresholdDb);

        logs.length = 0;
        const exitCode = await ffmpeg.exec([
          "-i", inputPath,
          "-filter_complex", filterGraph,
          "-map", "[out]",
          "-ar", "16000",
          "-ac", "1",
          "-c:a", "pcm_s16le",
          outputName,
        ]);
        throwIfAborted(signal);
        if (exitCode !== 0) throw new Error(`FFmpeg failed to extract audio chunk (exit ${exitCode}).`);
        detectedSilences.push(...parseSilenceDetectionLog(
          logs.join("\n"),
          chunkEnd - chunkStart,
        ).map((range) => ({
          start: range.start + chunkStart,
          end: range.end + chunkStart,
        })));

        await ffmpeg.deleteFile(outputName);
        throwIfAborted(signal);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }

      return createSilenceReviewCandidates(
        normalizeCutRanges(detectedSilences, timelineDuration),
        timelineDuration,
        minDuration,
      );
    } finally {
      try {
        if (inputMounted) await ffmpeg.unmount(inputDirectory);
        if (inputDirectoryCreated) await ffmpeg.deleteDir(inputDirectory);
      } finally {
        removeAbortCleanup();
        if (logHandlerAttached) ffmpeg.off("log", onLog);
        if (coreBlobUrl) URL.revokeObjectURL(coreBlobUrl);
        if (wasmBlobUrl) URL.revokeObjectURL(wasmBlobUrl);
        terminate();
      }
    }
  }, []);

  const applyCutsToTimeline = useCallback((cuts: {start: number; end: number }[]) => {
    if (cuts.length === 0) return timelineDurationRef.current;
    const mergedCuts = normalizeCutRanges(cuts, timelineDurationRef.current);
    if (mergedCuts.length === 0) return timelineDurationRef.current;
    const previousTime = currentTimeRef.current;
    const removedBeforePlayhead = mergedCuts.reduce(
      (total, cut) => total + Math.max(0, Math.min(cut.end, previousTime) - cut.start),
      0,
    );
    setManualRangeStart(null);
    setManualRangeEnd(null);
    videoRef.current?.pause();
    setIsPlaying(false);
    const keptClips = splitTimelineClips(clipsRef.current, mergedCuts)
      .map((fragment) => createClip(
        fragment.sourceStart,
        fragment.sourceEnd,
        fragment.start,
        fragment.speed,
      ));

    updateClips(keptClips);
    setSelectedClipId(null);
    const nextDuration = clipsRef.current[clipsRef.current.length - 1]?.end ?? 0;
    const targetTime = Math.max(0, Math.min(nextDuration, previousTime - removedBeforePlayhead));
    const sourcePosition = getSourcePosition(clipsRef.current, targetTime);
    if (sourcePosition && videoRef.current) {
      videoRef.current.currentTime = sourcePosition.sourceTime;
      videoRef.current.playbackRate = sourcePosition.speed;
    }
    updateTimelineTime(targetTime);
    return nextDuration;
  }, [updateClips, updateTimelineTime]);

  const analyzeTimelineCuts = useCallback(async () => {
    if (!videoFile) throw new Error("Import a video before analyzing cuts.");
    if (clipsRef.current.length === 0) throw new Error("There are no video clips on the timeline.");
    if (autoCutControllerRef.current) throw new Error("Auto-Cut analysis is already running.");

    const controller = new AbortController();
    autoCutControllerRef.current = controller;
    const {signal} = controller;
    try {
      const detectedSilences = await extractAudioInChunks(
        videoFile,
        signal,
        minimumSilenceDuration,
        silenceThresholdDb,
      );
      throwIfAborted(signal);

      setReviewSegments([]);
      setSelectedCutIds(new Set());
      setSilenceReview(detectedSilences.map((range) => ({
        id: crypto.randomUUID(),
        ...range,
      })));
      const warning = "Cloud transcription is disabled; only local silence candidates are available. No cuts were applied.";
      setNotice(`${detectedSilences.length} silence candidate${detectedSilences.length === 1 ? "" : "s"} ready to review. ${warning}`);
      return {
        suggestionCount: 0,
        reviewableSilenceCount: detectedSilences.length,
        analysisMode: "local" as const,
        warning,
      };
    } finally {
      if (autoCutControllerRef.current === controller) autoCutControllerRef.current = null;
    }
  }, [extractAudioInChunks, minimumSilenceDuration, silenceThresholdDb, videoFile]);
  const closeChat = useCallback(() => setViewMode("editor"), []);
  const chatVideoContext = useMemo(() => ({onAnalyzeCuts: analyzeTimelineCuts}), [analyzeTimelineCuts]);

  const deleteSelectedClip = () => {
    const selectedClip = clipsRef.current.find((clip) => clip.id === selectedClipId);
    if (!selectedClip) return;
    const cut = {start: selectedClip.start, end: selectedClip.end};
    videoRef.current?.pause();
    setIsPlaying(false);
    updateClips(clipsRef.current.filter((clip) => clip.id !== selectedClip.id));
    setSelectedClipId(null);
    setSelectedClipTimeStr(null);
    setManualRangeStart(null);
    setManualRangeEnd(null);
    setReviewSegments((segments) => segments.flatMap((segment) =>
      mapRangeAfterCuts(segment.start, segment.end, [cut]).map((range, index) => ({
        ...segment,
        id: index === 0 ? segment.id : `${segment.id}-${index}`,
        ...range,
      })),
    ));
    const nextDuration = clipsRef.current[clipsRef.current.length - 1]?.end ?? 0;
    const targetTime = Math.min(selectedClip.start, nextDuration);
    const targetClip = clipsRef.current.find((clip) => targetTime >= clip.start && targetTime < clip.end)
      ?? clipsRef.current[clipsRef.current.length - 1];
    if (targetClip && videoRef.current) {
      videoRef.current.currentTime = targetClip.sourceStart +
        Math.max(0, Math.min(targetClip.end - targetClip.start, targetTime - targetClip.start)) * targetClip.speed;
    }
    updateTimelineTime(targetTime);
    setNotice("Selected timeline clip ripple-deleted.");
  };

  const deleteSelectedSuggestions = () => {
    const selectedSuggestions = reviewSegments.filter((segment) => selectedCutIds.has(segment.id));
    if (selectedSuggestions.length === 0) return;
    const cuts = selectedSuggestions.map(({start, end}) => ({start, end}));
    applyCutsToTimeline(cuts);
    setReviewSegments((segments) => segments
      .filter((segment) => !selectedCutIds.has(segment.id))
      .flatMap((segment) => mapRangeAfterCuts(segment.start, segment.end, cuts)
        .map((range, index) => ({
          ...segment,
          id: index === 0 ? segment.id : `${segment.id}-${index}`,
          ...range,
        }))));
    setSelectedCutIds(new Set());
    setNotice(`Deleted ${selectedSuggestions.length} selected retake suggestion${selectedSuggestions.length === 1 ? "" : "s"}.`);
  };

  const markManualRangeStart = () => {
    setManualRangeStart(currentTimeRef.current);
    setManualRangeEnd(null);
  };

  const markManualRangeEnd = () => {
    const end = currentTimeRef.current;
    if (manualRangeStart === null || end <= manualRangeStart) {
      setNotice("Mark a range start first, then mark a later end.");
      return;
    }
    setManualRangeEnd(end);
  };

  const deleteManualRange = () => {
    if (manualRangeStart === null || manualRangeEnd === null || manualRangeEnd <= manualRangeStart) return;
    const cut = {start: manualRangeStart, end: manualRangeEnd};
    applyCutsToTimeline([cut]);
    setReviewSegments((segments) => segments.flatMap((segment) =>
      mapRangeAfterCuts(segment.start, segment.end, [cut]).map((range, index) => ({
        ...segment,
        id: index === 0 ? segment.id : `${segment.id}-${index}`,
        ...range,
      })),
    ));
    setSelectedCutIds(new Set());
    setManualRangeStart(null);
    setManualRangeEnd(null);
    setNotice("Selected timeline range ripple-deleted.");
  };

  const previewSuggestion = (segment: ReviewSegment) => {
    const sourcePosition = getSourcePosition(clipsRef.current, segment.start);
    const video = videoRef.current;
    if (!sourcePosition || !video) return;
    video.currentTime = sourcePosition.sourceTime;
    video.playbackRate = sourcePosition.speed;
    updateTimelineTime(segment.start);
    safePlay(video);
    setIsPlaying(true);
  };

  const decideSilenceCandidates = (candidateIds: string[], accept: boolean) => {
    const candidates = silenceReview.filter((candidate) => candidateIds.includes(candidate.id));
    if (candidates.length === 0) return;
    const cuts = accept
      ? normalizeCutRanges(candidates, timelineDurationRef.current)
      : [];
    if (cuts.length > 0) {
      applyCutsToTimeline(cuts);
      setReviewSegments((segments) => segments.flatMap((segment) =>
        mapRangeAfterCuts(segment.start, segment.end, cuts).map((range, index) => ({
          ...segment,
          id: index === 0 ? segment.id : `${segment.id}-${index}`,
          ...range,
        })),
      ));
      setSelectedCutIds(new Set());
    }
    setSilenceReview((pending) => pending
      .filter((candidate) => !candidateIds.includes(candidate.id))
      .flatMap((candidate) => mapRangeAfterCuts(candidate.start, candidate.end, cuts)
        .map((range, index) => ({
          ...candidate,
          id: index === 0 ? candidate.id : `${candidate.id}-${index}`,
          ...range,
        }))));
    setNotice(accept
      ? `Accepted ${cuts.length} reviewed silence cut${cuts.length === 1 ? "" : "s"}. Undo is available.`
      : `Rejected ${candidates.length} silence candidate${candidates.length === 1 ? "" : "s"}.`);
  };



































  useEffect(() => {
    const scroller = timelineScrollerRef.current;
    if (scroller) scroller.scrollLeft = currentTime * PIXELS_PER_SECOND;
  }, [currentTime, timelineDuration]);

  useEffect(() => {
    if (!isFullscreen) return;
    const syncFullscreenState = () => setIsFullscreen(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", syncFullscreenState);
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch((error: unknown) => {
        console.error("Could not enter fullscreen:", error);
        setIsFullscreen(false);
        setNotice("Fullscreen mode could not start.");
      });
    }
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, [isFullscreen]);




  const activeVideoClip = clips.find((clip) => currentTime >= clip.start && currentTime < clip.end);






  const handleExport = () => {
    setNotice("Video export is not implemented yet. No video was rendered or downloaded.");
  };

  const handleUndo = () => {
    const canUndo = undoHistoryRef.current.length > 0;
    undoClips();
    if (canUndo) {
      setReviewSegments([]);
      setSelectedCutIds(new Set());
      setSilenceReview([]);
    }
  };
  const handleRedo = () => {
    const canRedo = redoHistoryRef.current.length > 0;
    redoClips();
    if (canRedo) {
      setReviewSegments([]);
      setSelectedCutIds(new Set());
      setSilenceReview([]);
    }
  };

  const handleImportSRT = async (file: File) => {
    try {
      const importedCaptions = parseSrt(await file.text());
      if (importedCaptions.length === 0) {
        setNotice("The selected subtitle file contains no valid captions.");
        return;
      }
      setCaptions(importedCaptions);
      setNotice(`Imported ${importedCaptions.length} captions from ${file.name}.`);
    } catch (error: unknown) {
      console.error("Could not import subtitle file:", error);
      setNotice("Could not read the selected subtitle file.");
    }
  };

  return (
    <div className="relative flex flex-col h-[100dvh] bg-black text-white overflow-hidden font-sans">
      {/* 1. TOP BAR */}
      <header className="h-14 flex items-center justify-between px-4 bg-[#0a0a0a] shrink-0 border-b border-zinc-800 z-10">
        <div className="flex items-center gap-4">
          <button onClick={() => router.back()} className="p-2 hover:bg-zinc-800 rounded-full transition">
            <ChevronLeft size={20} />
          </button>
          <span className="text-sm font-medium text-zinc-300">{format} · 1080p</span>
        </div>
        <button onClick={() => handleExport()} className="bg-[#4ECDC4] text-black px-4 py-1.5 rounded-md font-semibold text-sm">
          Export
        </button>
      </header>

      {/* 2. VIDEO PLAYER */}
      <div className="flex-1 flex items-center justify-center p-2 relative bg-black min-h-0">
        <div className="relative h-full max-h-full aspect-[9/16] bg-zinc-900 border border-zinc-800 overflow-hidden shadow-2xl rounded-lg">
          {videoFile ? (
            <video
              ref={videoRef}
              src={videoUrl || undefined}
              className="w-full h-full object-contain"
              style={{ filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)` }}
              onLoadedMetadata={(event) => onVideoLoaded(event.currentTarget)}
              onTimeUpdate={(event) => onVideoTimeUpdate(event.currentTarget)}
              playsInline
              onClick={togglePlayback}
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-zinc-500 text-sm">
              <span>No video loaded</span>
            </div>
          )}
          <CaptionOverlay
            text={captions.find((caption) => currentTime >= caption.start && currentTime <= caption.end)?.text || ""}
            style={captionStyle}
            timelineTime={currentTime}
            start={captions.find((caption) => currentTime >= caption.start && currentTime <= caption.end)?.start || 0}
            end={captions.find((caption) => currentTime >= caption.start && currentTime <= caption.end)?.end || 0}
          />
        </div>
      </div>

      {/* 3. PLAYBACK CONTROLS */}
      <div className="h-12 bg-[#0a0a0a] flex items-center justify-between px-4 shrink-0 border-b border-zinc-800">
        <div className="flex items-center gap-4 text-zinc-400">
          <button onClick={handleUndo} className="p-1.5 hover:text-white transition"><Undo size={18} /></button>
          <button onClick={handleRedo} className="p-1.5 hover:text-white transition"><Redo size={18} /></button>
        </div>
        <div className="text-xs font-mono text-zinc-400">
          {formatTime(currentTime)} / {formatTime(timelineDuration)}
        </div>
        <button onClick={() => setIsFullscreen(true)} className="text-zinc-400 hover:text-white"><Maximize size={18} /></button>
      </div>

      {/* 4. TIMELINE */}
      <div className="h-44 bg-[#0a0a0a] flex flex-col shrink-0 relative border-b border-zinc-800">
        <div ref={timelineScrollerRef} className="flex-1 overflow-x-auto overflow-y-hidden relative custom-scrollbar">
          <div className="min-w-max h-full flex flex-col relative" style={{ width: `${Math.max(100, timelineDuration * PIXELS_PER_SECOND)}px` }}>
            {/* Timeline Ruler */}
            <div className="h-6 border-b border-zinc-800/50 flex items-end relative select-none">
              {Array.from({length: Math.ceil(timelineDuration) + 1 }).map((_, i) => (
                <div key={i} className="absolute flex flex-col items-center justify-end h-full text-[9px] text-zinc-600 border-l border-zinc-800/50 pb-1" style={{ left: `${i * PIXELS_PER_SECOND}px` }}>
                  {formatTime(i)}
                </div>
              ))}
            </div>

            {/* Tracks */}
            {["V1", "V2", "A1", "A2"].map((track) => (
              <div key={track} className="flex-1 min-h-[28px] flex items-center border-b border-zinc-800/50 relative group">
                <div className="w-12 bg-[#0a0a0a] border-r border-zinc-800/50 h-full flex items-center justify-center text-[10px] text-zinc-500 z-10 sticky left-0">
                  {track}
                </div>
                <div className="flex-1 relative h-full">
                  {track === "V1" && clips.map((clip) => (
                    <div
                      key={clip.id}
                      onClick={() => {
                        setSelectedClipId(clip.id);
                        setSelectedClipTimeStr(formatTime(clip.start));
                      }}
                      className={`absolute top-1 bottom-1 rounded-sm overflow-hidden border bg-[#4ECDC4]/20 border-[#4ECDC4] ${selectedClipId === clip.id ? "ring-2 ring-white z-10" : ""}`}
                      style={{ left: `${clip.start * PIXELS_PER_SECOND}px`, width: `${(clip.end - clip.start) * PIXELS_PER_SECOND}px` }}
                    >
                      <span className="text-[10px] text-white px-1 truncate">Video</span>
                    </div>
                  ))}
                  {track === "V1" && silenceReview.map((candidate) => (
                    <div
                      key={candidate.id}
                      title={`Silence candidate for review: ${formatTime(candidate.start)}–${formatTime(candidate.end)}`}
                      className="absolute top-1 bottom-1 z-10 rounded-sm border border-amber-300 bg-amber-400/40 pointer-events-none"
                      style={{
                        left: `${candidate.start * PIXELS_PER_SECOND}px`,
                        width: `${Math.max(4, (candidate.end - candidate.start) * PIXELS_PER_SECOND)}px`,
                      }}
                    />
                  ))}
                  {track === "V1" && reviewSegments.filter((segment) => segment.isSuggestedCut).map((segment) => (
                    <button
                      key={segment.id}
                      type="button"
                      title={`Suggested cut: ${segment.text}${segment.explanation ? `. ${segment.explanation}` : ""}${segment.bestTakeText ? ` Best take: ${segment.bestTakeText}` : ""}`}
                      aria-label={`Select suggested cut: ${segment.text}${segment.explanation ? `. ${segment.explanation}` : ""}${segment.bestTakeText ? ` Best take: ${segment.bestTakeText}` : ""}`}
                      aria-pressed={selectedCutIds.has(segment.id)}
                      onClick={() => {
                        setSelectedCutIds((selected) => {
                          const next = new Set(selected);
                          if (next.has(segment.id)) next.delete(segment.id);
                          else next.add(segment.id);
                          return next;
                        });
                        previewSuggestion(segment);
                      }}
                      className={`absolute top-1 bottom-1 z-20 rounded-sm border ${selectedCutIds.has(segment.id) ? "bg-red-500/80 border-white ring-1 ring-white" : "bg-red-500/50 border-red-300 hover:bg-red-500/70"}`}
                      style={{
                        left: `${segment.start * PIXELS_PER_SECOND}px`,
                        width: `${Math.max(4, (segment.end - segment.start) * PIXELS_PER_SECOND)}px`,
                      }}
                    />
                  ))}
                </div>
              </div>
            ))}

            {manualRangeStart !== null && manualRangeEnd !== null && (
              <div
                className="absolute top-6 bottom-0 z-10 border-x border-cyan-300 bg-cyan-400/15 pointer-events-none"
                style={{
                  left: `${manualRangeStart * PIXELS_PER_SECOND}px`,
                  width: `${(manualRangeEnd - manualRangeStart) * PIXELS_PER_SECOND}px`,
                }}
              />
            )}
            {manualRangeStart !== null && manualRangeEnd === null && (
              <div
                className="absolute top-6 bottom-0 z-10 w-0.5 bg-cyan-300 pointer-events-none"
                style={{left: `${manualRangeStart * PIXELS_PER_SECOND}px`}}
              />
            )}

            {/* Playhead */}
            <div className="absolute top-0 bottom-0 w-px bg-white z-30 pointer-events-none" style={{ left: `${currentTime * PIXELS_PER_SECOND}px` }}>
              <div className="w-3 h-3 bg-white -ml-1.5 rounded-sm" />
            </div>
          </div>
        </div>
        <div className="h-12 shrink-0 bg-[#111] flex items-center gap-3 px-3 text-[10px] overflow-x-auto whitespace-nowrap">
          <button
            type="button"
            onClick={() => {
              if (!activeVideoClip) return;
              setSelectedClipId(activeVideoClip.id);
              setSelectedClipTimeStr(formatTime(activeVideoClip.start));
            }}
            disabled={!activeVideoClip}
            className="text-zinc-400 hover:text-white disabled:opacity-40"
          >
            Select clip
          </button>
          <button type="button" onClick={markManualRangeStart} disabled={!activeVideoClip} className="text-zinc-400 hover:text-white disabled:opacity-40">
            Mark Start
          </button>
          <button type="button" onClick={markManualRangeEnd} disabled={manualRangeStart === null || !activeVideoClip} className="text-zinc-400 hover:text-white disabled:opacity-40">
            Mark End
          </button>
          <button type="button" onClick={deleteManualRange} disabled={manualRangeStart === null || manualRangeEnd === null} className="text-red-400 hover:text-red-300 font-bold disabled:opacity-40">
            Delete Range
          </button>
          <button type="button" onClick={deleteSelectedClip} disabled={!selectedClipId} className="text-red-400 hover:text-red-300 disabled:opacity-40">
            Ripple Delete
          </button>
          {reviewSegments.length > 0 && (
            <button type="button" onClick={deleteSelectedSuggestions} disabled={selectedCutIds.size === 0} className="text-red-400 hover:text-red-300 disabled:opacity-40">
              Delete Retakes ({selectedCutIds.size})
            </button>
          )}
          <label className="flex items-center gap-1 text-zinc-400">
            Silence ≥
            <input
              type="number"
              min="0.2"
              max="10"
              step="0.1"
              value={minimumSilenceDuration}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= 0.2 && value <= 10) setMinimumSilenceDuration(value);
              }}
              className="w-12 rounded bg-zinc-800 px-1 py-0.5 text-white"
              aria-label="Minimum silence candidate duration in seconds"
            />
            s
          </label>
          <label className="flex items-center gap-1 text-zinc-400">
            Threshold
            <input
              type="number"
              min="-60"
              max="-10"
              step="1"
              value={silenceThresholdDb}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value >= -60 && value <= -10) setSilenceThresholdDb(value);
              }}
              className="w-12 rounded bg-zinc-800 px-1 py-0.5 text-white"
              aria-label="Silence detection threshold in dB"
            />
            dB
          </label>
          {silenceReview.map((candidate) => (
            <span key={candidate.id} className="flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-1 text-amber-200">
              {formatTime(candidate.start)}–{formatTime(candidate.end)}
              <button
                type="button"
                onClick={() => decideSilenceCandidates([candidate.id], true)}
                className="text-green-300 hover:text-green-200"
                aria-label={`Accept silence ${formatTime(candidate.start)} to ${formatTime(candidate.end)}`}
              >
                Accept
              </button>
              <button
                type="button"
                onClick={() => decideSilenceCandidates([candidate.id], false)}
                className="text-zinc-400 hover:text-white"
                aria-label={`Reject silence ${formatTime(candidate.start)} to ${formatTime(candidate.end)}`}
              >
                Reject
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 5. BOTTOM TOOLBAR */}
      <footer className="h-16 bg-[#0a0a0a] flex items-center px-2 gap-2 overflow-x-auto shrink-0 z-30 relative">
        <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              if (draftId) await saveVideoToOPFS(draftId, file);
              setVideoSource(file);
            } catch (error) {
              console.error("Could not import video:", error);
              setNotice("Could not import this video.");
            } finally {
              event.target.value = "";
            }
          }} />
        <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Upload size={20} />
          <span className="text-[10px]">Import</span>
        </button>
        <button type="button" onClick={() => setIsEffectsPanelOpen(true)} className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Sparkles size={20} />
          <span className="text-[10px]">Effects</span>
        </button>
        <button type="button" onClick={() => setIsCaptionPanelOpen(true)} className="flex flex-col items-center min-w-[65px] gap-1 text-[#4ECDC4]">
          <Captions size={20} />
          <span className="text-[10px]">Captions</span>
        </button>
        {/* AI CHAT BUTTON - Replaces Magic Edit & Auto-Cut */}
        <button type="button" onClick={() => setViewMode("chat")} className="flex flex-col items-center justify-center min-w-[75px] gap-1 text-black bg-[#4ECDC4] rounded-xl py-1 px-2 shadow-lg ml-auto">
          <Sparkles size={20} />
          <span className="text-[10px] font-bold">AI Chat</span>
        </button>
      </footer>

      {/* MODALS & OVERLAYS */}
      {isEffectsPanelOpen && <EffectsPanel onClose={() => setIsEffectsPanelOpen(false)} brightness={brightness} setBrightness={setBrightness} contrast={contrast} setContrast={setContrast} saturation={saturation} setSaturation={setSaturation} />}
      {isCaptionPanelOpen && <CaptionPanel onImportSRT={handleImportSRT} wordsPerLine={wordsPerLine} setWordsPerLine={setWordsPerLine} style={captionStyle} setStyle={setCaptionStyle} onClose={() => setIsCaptionPanelOpen(false)} onGenerate={async () => { setNotice("AI caption generation is not connected yet."); }} />}
      {viewMode === "chat" && (
        <AIChatPanel
          onClose={closeChat}
          onCancelAutoCut={cancelAutoCut}
          selectedClipTime={selectedClipTimeStr}
          editorContextSummary={editorContextSummary}
          getEditorContext={getEditorContext}
          videoContext={chatVideoContext}
        />
      )}

      {notice && (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 bg-[#242424] px-4 py-2 text-xs text-white shadow-lg rounded-lg z-[100] border border-[#383838]">
          {notice}
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="ml-3 text-gray-400 hover:text-white"><X size={12} /></button>
        </div>
      )}
    </div>
  );
}

export default function StudioPage() {
  return (
    <Suspense fallback={<main className="h-[100dvh] bg-black" />}>
      <StudioEditor />
    </Suspense>
  );
}