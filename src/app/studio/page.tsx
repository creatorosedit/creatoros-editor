"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Captions,
  ChevronLeft,
  ChevronRight,
  Copy,
  Eye,
  Layout,
  Maximize2,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  Search,
  Scissors,
  SkipBack,
  SkipForward,
  Sparkles,
  Type,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { getVideoFromOPFS, saveVideoToOPFS } from "@/lib/video/opfs";
import AssetSearchPanel, { type SelectedAsset } from "@/components/search/AssetSearchPanel";
import { EditingPlanSchema, type EditingIntensity, type UniversalEditingPlan } from "@/types/editing-plan";

interface VideoClip {
  id: string;
  start: number;
  end: number;
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  zoomEffects: ZoomEffect[];
}

interface Cut {
  start: number;
  end: number;
  reason: "silence" | "retake";
}

interface TranscriptWord {
  word: string;
  start: number;
  end: number;
}

interface ReviewSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  isSuggestedCut: boolean;
  reason: "silence" | "retake" | null;
}

type BrollLayout = "full" | "split" | "pip";
type BrollType = "image" | "video";

interface BrollTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

interface BrollPointer {
  x: number;
  y: number;
}

interface BrollGesture {
  clipId: string;
  transform: BrollTransform;
  pointers: Map<number, BrollPointer>;
  origin: BrollPointer;
  distance: number;
  angle: number;
}

interface EditedTranscriptSegment {
  word: string;
  start: number;
  end: number;
}

interface BrollPlanItem {
  id: string;
  type: "broll";
  start: number;
  end: number;
  layout: BrollLayout;
  assetType: BrollType;
  searchQuery: string;
  enabled: boolean;
  asset: SelectedAsset | null;
}

interface BrollClip extends Omit<BrollPlanItem, "enabled"> {
  prompt: string;
  aspectRatio: string;
  url: string | null;
  track: "v2";
  transform: BrollTransform;
}

interface ZoomPlanItem {
  id: string;
  type: "zoom";
  start: number;
  end: number;
  effect: "zoom_in_slow" | "zoom_out_slow" | "punch_in";
  enabled: boolean;
  asset: null;
}

interface AudioPlanItem {
  id: string;
  type: "sfx" | "music";
  start?: number;
  end?: number;
  mood?: string;
  searchQuery: string;
  volume: number;
  enabled: boolean;
  asset: SelectedAsset | null;
}

type MagicEditPlanItem = BrollPlanItem | ZoomPlanItem | AudioPlanItem;

interface ZoomEffect {
  id: string;
  start: number;
  end: number;
  track: "v1";
  effect: ZoomPlanItem["effect"];
}

interface AudioClip {
  id: string;
  title: string;
  start: number;
  end: number;
  url: string | null;
  volume: number;
  track: "a1" | "a2";
}

interface PlanAssetSearch {
  itemId: string;
  type: "video" | "image" | "music" | "sfx";
  query: string;
}

const PIXELS_PER_SECOND = 50;

function formatTime(time: number): string {
  const minutes = Math.floor(time / 60);
  const seconds = Math.floor(time % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getBrollPointerGeometry(pointers: Map<number, BrollPointer>) {
  const points = [...pointers.values()];
  if (points.length === 0) {
    return { origin: { x: 0, y: 0 }, distance: 0, angle: 0 };
  }
  const origin = points.reduce(
    (center, point) => ({ x: center.x + point.x / points.length, y: center.y + point.y / points.length }),
    { x: 0, y: 0 },
  );
  const first = points[0] ?? { x: 0, y: 0 };
  const second = points[1] ?? first;
  return {
    origin,
    distance: Math.hypot(second.x - first.x, second.y - first.y),
    angle: Math.atan2(second.y - first.y, second.x - first.x) * (180 / Math.PI),
  };
}

function createClip(sourceStart: number, sourceEnd: number, start: number, speed = 1): VideoClip {
  return {
    id: crypto.randomUUID(),
    start,
    end: start + (sourceEnd - sourceStart) / speed,
    sourceStart,
    sourceEnd,
    speed,
    zoomEffects: [],
  };
}

function reflowClips(clips: VideoClip[]): VideoClip[] {
  let cursor = 0;
  return [...clips]
    .sort((first, second) => first.start - second.start)
    .map((clip) => {
      const duration = Math.max(0, (clip.sourceEnd - clip.sourceStart) / clip.speed);
      const result = { ...clip, start: cursor, end: cursor + duration };
      cursor = result.end;
      return result;
    })
    .filter((clip) => clip.end - clip.start > 0.001);
}

function isReviewSegment(value: unknown): value is ReviewSegment {
  if (typeof value !== "object" || value === null) return false;
  return "id" in value &&
    typeof value.id === "string" &&
    "text" in value &&
    typeof value.text === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    "end" in value &&
    typeof value.end === "number" &&
    Number.isFinite(value.end) &&
    value.end > value.start &&
    "isSuggestedCut" in value &&
    typeof value.isSuggestedCut === "boolean" &&
    "reason" in value &&
    (value.reason === null || value.reason === "silence" || value.reason === "retake");
}

function isTimedCut(value: unknown): value is { start: number; end: number } {
  if (typeof value !== "object" || value === null) return false;
  return "start" in value &&
    typeof value.start === "number" &&
    Number.isFinite(value.start) &&
    "end" in value &&
    typeof value.end === "number" &&
    Number.isFinite(value.end) &&
    value.end > value.start;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((line) => typeof line === "string");
}

function buildEditedTranscript(originalWords: TranscriptWord[], cuts: Pick<Cut, "start" | "end">[]): EditedTranscriptSegment[] {
  const sortedCuts = cuts
    .filter((cut) => Number.isFinite(cut.start) && Number.isFinite(cut.end) && cut.end > cut.start)
    .sort((first, second) => first.start - second.start);
  const mergedCuts: Array<{ start: number; end: number }> = [];
  for (const cut of sortedCuts) {
    const previous = mergedCuts[mergedCuts.length - 1];
    if (previous && cut.start <= previous.end) {
      previous.end = Math.max(previous.end, cut.end);
    } else {
      mergedCuts.push({ ...cut });
    }
  }

  return originalWords
    .filter((word) => !mergedCuts.some((cut) => word.start < cut.end && word.end > cut.start))
    .map((word) => {
      const shiftAmount = mergedCuts
        .filter((cut) => cut.end <= word.start)
        .reduce((sum, cut) => sum + cut.end - cut.start, 0);
      return {
        word: word.word,
        start: word.start - shiftAmount,
        end: word.end - shiftAmount,
      };
    })
    .sort((first, second) => first.start - second.start);
}

function StudioEditor() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedFormat = searchParams.get("format");
  const format = (["9:16", "16:9", "1:1", "4:5"] as const).find((ratio) => ratio === requestedFormat) ?? "9:16";
  const draftId = searchParams.get("draftId") ?? searchParams.get("id");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const brollImageInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const timelineScrollerRef = useRef<HTMLDivElement>(null);
  const reviewPreviewEndRef = useRef<number | null>(null);
  const reviewPreviewFrameRef = useRef<number | null>(null);
  const currentTimeRef = useRef(0);
  const clipsRef = useRef<VideoClip[]>([]);
  const brollClipsRef = useRef<BrollClip[]>([]);
  const brollGestureRef = useRef<BrollGesture | null>(null);
  const audioElementsRef = useRef(new Map<string, HTMLAudioElement>());
  const failedAudioPlaybackRef = useRef(new Set<string>());
  const assetUrlsRef = useRef(new Set<string>());
  const undoHistoryRef = useRef<VideoClip[][]>([]);
  const redoHistoryRef = useRef<VideoClip[][]>([]);
  const timelineDurationRef = useRef(0);
  const videoObjectUrlRef = useRef<string | null>(null);

  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [sourceDuration, setSourceDuration] = useState(0);
  const [clips, setClips] = useState<VideoClip[]>([]);
  const [timelineDuration, setTimelineDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const videoVolume = 1;
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [script, setScript] = useState("");
  const [scriptLines, setScriptLines] = useState<string[]>([]);
  const [isProcessingScript, setIsProcessingScript] = useState(false);
  const [silenceThreshold, setSilenceThreshold] = useState(0.7);
  const [isAutoCutting, setIsAutoCutting] = useState(false);
  const [autoCutError, setAutoCutError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewSegments, setReviewSegments] = useState<ReviewSegment[]>([]);
  const [silenceCuts, setSilenceCuts] = useState<Cut[]>([]);
  const [selectedCutIds, setSelectedCutIds] = useState<Set<string>>(new Set());
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [previewingSegmentId, setPreviewingSegmentId] = useState<string | null>(null);
  const [editedTranscript, setEditedTranscript] = useState<EditedTranscriptSegment[]>([]);
  const [originalTranscriptWords, setOriginalTranscriptWords] = useState<TranscriptWord[]>([]);
  const [magicEditPlan, setMagicEditPlan] = useState<MagicEditPlanItem[]>([]);
  const [universalEditingPlan, setUniversalEditingPlan] = useState<UniversalEditingPlan | null>(null);
  const [aiIntensity, setAiIntensity] = useState<EditingIntensity>("professional");
  const [aiModel, setAiModel] = useState<"groq" | "openrouter">("openrouter");
  const [brollClips, setBrollClips] = useState<BrollClip[]>([]);
  const [audioClips, setAudioClips] = useState<AudioClip[]>([]);
  const [isMagicEditPlanOpen, setIsMagicEditPlanOpen] = useState(false);
  const [isGeneratingMagicEditPlan, setIsGeneratingMagicEditPlan] = useState(false);
  const [magicEditError, setMagicEditError] = useState<string | null>(null);
  const [magicEditMessage, setMagicEditMessage] = useState("");
  const [magicEditChat, setMagicEditChat] = useState<Array<{ role: "user" | "assistant"; text: string }>>([]);
  const [assetSearch, setAssetSearch] = useState<PlanAssetSearch | null>(null);
  const [selectedBrollClipId, setSelectedBrollClipId] = useState<string | null>(null);

  clipsRef.current = clips;
  brollClipsRef.current = brollClips;
  timelineDurationRef.current = timelineDuration;

  const updateTimelineTime = useCallback((time: number) => {
    const boundedTime = Math.max(0, Math.min(timelineDurationRef.current, time));
    currentTimeRef.current = boundedTime;
    setCurrentTime(boundedTime);
  }, []);

  const updateClips = useCallback((nextClips: VideoClip[]) => {
    undoHistoryRef.current.push(clipsRef.current);
    redoHistoryRef.current = [];
    const reflowed = reflowClips(nextClips);
    const nextDuration = reflowed[reflowed.length - 1]?.end ?? 0;
    clipsRef.current = reflowed;
    timelineDurationRef.current = nextDuration;
    setClips(reflowed);
    setTimelineDuration(nextDuration);
    setCurrentTime((time) => {
      const boundedTime = Math.min(time, nextDuration);
      currentTimeRef.current = boundedTime;
      return boundedTime;
    });
  }, []);

  const restoreClips = useCallback((nextClips: VideoClip[]) => {
    const reflowed = reflowClips(nextClips);
    const nextDuration = reflowed[reflowed.length - 1]?.end ?? 0;
    clipsRef.current = reflowed;
    timelineDurationRef.current = nextDuration;
    setClips(reflowed);
    setTimelineDuration(nextDuration);
    setCurrentTime((time) => {
      const boundedTime = Math.min(time, nextDuration);
      currentTimeRef.current = boundedTime;
      return boundedTime;
    });
  }, []);

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

  const setVideoSource = useCallback((file: File) => {
    videoRef.current?.pause();
    reviewPreviewEndRef.current = null;
    if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
    reviewPreviewFrameRef.current = null;
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    audioElementsRef.current.forEach((audio) => audio.pause());
    audioElementsRef.current.clear();
    failedAudioPlaybackRef.current.clear();
    assetUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    assetUrlsRef.current.clear();
    brollClipsRef.current = [];
    setBrollClips([]);
    setAudioClips([]);
    setMagicEditPlan([]);
    setMagicEditChat([]);
    setMagicEditError(null);
    setAssetSearch(null);
    setEditedTranscript([]);
    setOriginalTranscriptWords([]);
    setSelectedBrollClipId(null);
    const url = URL.createObjectURL(file);
    videoObjectUrlRef.current = url;
    setVideoFile(file);
    setVideoUrl(url);
    setSourceDuration(0);
    undoHistoryRef.current = [];
    redoHistoryRef.current = [];
    setClips([]);
    setTimelineDuration(0);
    setCurrentTime(0);
    currentTimeRef.current = 0;
    setSelectedClipId(null);
    setIsPlaying(false);
    setPreviewingSegmentId(null);
  }, []);

  useEffect(() => () => {
    if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
    if (videoObjectUrlRef.current) URL.revokeObjectURL(videoObjectUrlRef.current);
    assetUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    void getVideoFromOPFS(draftId).then((file) => {
      if (!cancelled && file) setVideoSource(file);
    }).catch((error: unknown) => {
      console.error("Failed to load draft video:", error);
    });
    return () => {
      cancelled = true;
    };
  }, [draftId, setVideoSource]);

  useEffect(() => {
    audioClips.forEach((clip) => {
      const audio = audioElementsRef.current.get(clip.id);
      if (!audio || !clip.url) return;
      const active = isPlaying && currentTime >= clip.start && currentTime < clip.end;
      if (!active) {
        audio.pause();
        return;
      }
      const targetTime = currentTime - clip.start;
      if (Math.abs(audio.currentTime - targetTime) > 0.25) audio.currentTime = targetTime;
      audio.volume = clip.volume;
      if (audio.paused && !failedAudioPlaybackRef.current.has(clip.id)) {
        void audio.play().catch((error: unknown) => {
          failedAudioPlaybackRef.current.add(clip.id);
          console.error("Timeline audio playback failed:", error);
          setNotice("Timeline audio could not be played.");
        });
      }
    });
  }, [audioClips, currentTime, isPlaying]);

  const onVideoLoaded = useCallback((video: HTMLVideoElement) => {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    setSourceDuration(video.duration);
    if (clipsRef.current.length === 0) {
      const initialClip = createClip(0, video.duration, 0);
      clipsRef.current = [initialClip];
      timelineDurationRef.current = video.duration;
      setClips([initialClip]);
      setTimelineDuration(video.duration);
    }
  }, []);

  const safePlay = useCallback((video: HTMLVideoElement) => {
    const handlePlayError = (error: unknown) => {
      const errorName = typeof error === "object" && error !== null && "name" in error
        ? error.name
        : undefined;
      if (errorName === "AbortError") return;
      console.error("Video playback failed:", error);
      setNotice("Video playback could not start.");
      reviewPreviewEndRef.current = null;
      if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
      reviewPreviewFrameRef.current = null;
      setIsPlaying(false);
      setPreviewingSegmentId(null);
    };

    try {
      const playPromise = video.play();
      if (playPromise !== undefined) void playPromise.catch(handlePlayError);
    } catch (error: unknown) {
      handlePlayError(error);
    }
  }, []);

  const seekTimeline = useCallback((time: number) => {
    const boundedTime = Math.max(0, Math.min(timelineDurationRef.current, time));
    updateTimelineTime(boundedTime);
    const clip = clipsRef.current.find((item) => boundedTime >= item.start && boundedTime < item.end);
    if (clip && videoRef.current) {
      videoRef.current.currentTime = clip.sourceStart + (boundedTime - clip.start) * clip.speed;
      videoRef.current.playbackRate = clip.speed;
    } else if (boundedTime >= timelineDurationRef.current) {
      const lastClip = clipsRef.current[clipsRef.current.length - 1];
      if (lastClip && videoRef.current) videoRef.current.currentTime = lastClip.sourceEnd;
    }
  }, [updateTimelineTime]);

  const onVideoTimeUpdate = useCallback((video: HTMLVideoElement) => {
    const sourceTime = video.currentTime;
    if (reviewPreviewEndRef.current !== null) {
      if (sourceTime >= reviewPreviewEndRef.current) {
        reviewPreviewEndRef.current = null;
        if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
        reviewPreviewFrameRef.current = null;
        video.pause();
        setIsPlaying(false);
        setPreviewingSegmentId(null);
      }
      return;
    }

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
      reviewPreviewEndRef.current = null;
      if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
      reviewPreviewFrameRef.current = null;
      video.pause();
      setIsPlaying(false);
      setPreviewingSegmentId(null);
      return;
    }

    let targetTime = currentTimeRef.current;
    failedAudioPlaybackRef.current.clear();
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
    audioClips.forEach((audioClip) => {
      if (!audioClip.url || targetTime < audioClip.start || targetTime >= audioClip.end) return;
      const audio = audioElementsRef.current.get(audioClip.id);
      if (!audio) return;
      audio.currentTime = targetTime - audioClip.start;
      audio.volume = audioClip.volume;
      void audio.play().catch((error: unknown) => {
        failedAudioPlaybackRef.current.add(audioClip.id);
        console.error("Timeline audio playback failed:", error);
        setNotice("Timeline audio could not be played.");
      });
    });
    safePlay(video);
    setIsPlaying(true);
  }, [audioClips, isPlaying, safePlay, updateTimelineTime, videoVolume]);

  const extractAudioAndFindSilences = useCallback(async (file: File, threshold: number) => {
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import("@ffmpeg/ffmpeg"),
      import("@ffmpeg/util"),
    ]);
    const ffmpeg = new FFmpeg();
    const coreBaseUrl = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";
    const logs: string[] = [];
    const onLog = ({ message }: { message: string }) => logs.push(message);
    const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() || "mp4";
    const inputName = `input.${extension}`;

    try {
      await ffmpeg.load({
        coreURL: await toBlobURL(`${coreBaseUrl}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${coreBaseUrl}/ffmpeg-core.wasm`, "application/wasm"),
      });
      ffmpeg.on("log", onLog);
      await ffmpeg.writeFile(inputName, new Uint8Array(await file.arrayBuffer()));
      await ffmpeg.exec([
        "-i", inputName,
        "-vn",
        "-ar", "16000",
        "-ac", "1",
        "-b:a", "32k",
        "audio.mp3",
      ]);
      const audioData = await ffmpeg.readFile("audio.mp3");
      if (typeof audioData === "string") throw new Error("FFmpeg returned invalid audio data.");
      const audioBuffer = new ArrayBuffer(audioData.byteLength);
      new Uint8Array(audioBuffer).set(audioData);
      const audioFile = new File([audioBuffer], "audio.mp3", { type: "audio/mpeg" });

      await ffmpeg.exec([
        "-i", inputName,
        "-af", `silencedetect=noise=-35dB:d=${threshold}`,
        "-f", "null",
        "-",
      ]);

      const output = logs.join("\n");
      const events = [...output.matchAll(/silence_(start|end):\s*(-?\d+(?:\.\d+)?)/gu)];
      const silenceCuts: Cut[] = [];
      let silenceStart: number | null = null;
      for (const event of events) {
        const time = Number(event[2]);
        if (!Number.isFinite(time)) continue;
        if (event[1] === "start") silenceStart = time;
        else if (silenceStart !== null) {
          silenceCuts.push({ start: silenceStart, end: time, reason: "silence" });
          silenceStart = null;
        }
      }
      if (silenceStart !== null) {
        silenceCuts.push({ start: silenceStart, end: sourceDuration, reason: "silence" });
      }
      return { audioFile, silenceCuts };
    } finally {
      ffmpeg.off("log", onLog);
      ffmpeg.terminate();
    }
  }, [sourceDuration]);

  const transcribeAudio = useCallback(async (audioFile: File) => {
    const formData = new FormData();
    formData.append("audio", audioFile, audioFile.name);
    const response = await fetch("/api/ai/whisper", { method: "POST", body: formData });
    const result: unknown = await response.json();
    if (
      !response.ok ||
      typeof result !== "object" ||
      result === null ||
      !("transcriptText" in result) ||
      typeof result.transcriptText !== "string" ||
      !("transcriptWords" in result) ||
      !Array.isArray(result.transcriptWords)
    ) {
      const message = typeof result === "object" && result !== null && "error" in result &&
        typeof result.error === "string"
        ? result.error
        : `Transcription failed (HTTP ${response.status}).`;
      throw new Error(message);
    }
    return { transcriptText: result.transcriptText, transcriptWords: result.transcriptWords as TranscriptWord[] };
  }, []);

  const applyCutsToTimeline = useCallback((cuts: { start: number; end: number }[]) => {
    if (cuts.length === 0) return timelineDurationRef.current;
    videoRef.current?.pause();
    setIsPlaying(false);
    const keptClips: VideoClip[] = [];
    for (const clip of clipsRef.current) {
      let fragments = [{ start: clip.sourceStart, end: clip.sourceEnd }];
      for (const cut of cuts) {
        fragments = fragments.flatMap((fragment) => {
          if (cut.end <= fragment.start || cut.start >= fragment.end) return [fragment];
          const remaining = [];
          if (cut.start > fragment.start) remaining.push({ start: fragment.start, end: cut.start });
          if (cut.end < fragment.end) remaining.push({ start: cut.end, end: fragment.end });
          return remaining;
        });
      }
      for (const fragment of fragments) {
        if (fragment.end - fragment.start > 0.05) {
          keptClips.push(createClip(fragment.start, fragment.end, clip.start, clip.speed));
        }
      }
    }

    updateClips(keptClips);
    setSelectedClipId(null);
    const nextDuration = keptClips.reduce(
      (total, clip) => total + (clip.sourceEnd - clip.sourceStart) / clip.speed,
      0,
    );
    const firstClip = reflowClips(keptClips)[0];
    if (firstClip && videoRef.current) videoRef.current.currentTime = firstClip.sourceStart;
    updateTimelineTime(0);
    return nextDuration;
  }, [updateClips, updateTimelineTime]);

  const runAutoCut = async () => {
    if (!videoFile) {
      setAutoCutError("Import a video before running Auto-Cut.");
      return;
    }
    if (!script.trim()) {
      setAutoCutError("Enter the video script before running Auto-Cut.");
      return;
    }
    if (scriptLines.length === 0) {
      setAutoCutError("Process the script with AI before running Auto-Cut.");
      return;
    }

    setAutoCutError(null);
    setIsAutoCutting(true);
    try {
      const { audioFile, silenceCuts } = await extractAudioAndFindSilences(videoFile, silenceThreshold);
      const { transcriptText, transcriptWords } = await transcribeAudio(audioFile);
      setOriginalTranscriptWords(transcriptWords);
      const response = await fetch("/api/ai/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          script: script.trim(),
          scriptLines,
          transcriptText,
          transcriptWords,
          silenceSegments: silenceCuts.map(({ start, end }) => ({ start, end })),
        }),
      });
      const result: unknown = await response.json();
      if (
        !response.ok ||
        typeof result !== "object" ||
        result === null ||
        !("segments" in result) ||
        !Array.isArray(result.segments) ||
        !result.segments.every(isReviewSegment) ||
        !("silenceCuts" in result) ||
        !Array.isArray(result.silenceCuts) ||
        !result.silenceCuts.every(isTimedCut) ||
        !("scriptLines" in result) ||
        !isStringArray(result.scriptLines)
      ) {
        const message = typeof result === "object" && result !== null && "error" in result &&
          typeof result.error === "string"
          ? result.error
          : `Retake detection failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      const segments = result.segments;
      setScriptLines(result.scriptLines);
      setReviewSegments(segments);
      setEditedTranscript([]);
      setSilenceCuts(result.silenceCuts.map(({ start, end }) => ({ start, end, reason: "silence" })));
      setSelectedCutIds(new Set(segments.filter((segment) => segment.isSuggestedCut).map((segment) => segment.id)));
      setIsSheetOpen(false);
      setIsReviewOpen(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Auto-Cut failed.";
      console.error("Auto-Cut failed:", error);
      setAutoCutError(message);
    } finally {
      setIsAutoCutting(false);
    }
  };

  const processScriptWithAI = async () => {
    if (!script.trim()) {
      setAutoCutError("Enter the video script before processing it.");
      return;
    }

    setAutoCutError(null);
    setIsProcessingScript(true);
    try {
      const response = await fetch("/api/ai/align", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clean-script", script: script.trim() }),
      });
      const result: unknown = await response.json();
      if (
        !response.ok ||
        typeof result !== "object" ||
        result === null ||
        !("scriptLines" in result) ||
        !isStringArray(result.scriptLines) ||
        result.scriptLines.length === 0
      ) {
        const message = typeof result === "object" && result !== null && "error" in result &&
          typeof result.error === "string"
          ? result.error
          : `Script preprocessing failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      setScriptLines(result.scriptLines);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Script preprocessing failed.";
      console.error("Script preprocessing failed:", error);
      setAutoCutError(message);
    } finally {
      setIsProcessingScript(false);
    }
  };

  const toggleSegment = (segmentId: string) => {
    setSelectedCutIds((selected) => {
      const next = new Set(selected);
      if (next.has(segmentId)) next.delete(segmentId);
      else next.add(segmentId);
      return next;
    });
  };

  const playReviewSegment = useCallback((segment: ReviewSegment) => {
    const video = videoRef.current;
    if (!video) return;

    if (previewingSegmentId === segment.id) {
      reviewPreviewEndRef.current = null;
      if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
      reviewPreviewFrameRef.current = null;
      video.pause();
      setIsPlaying(false);
      setPreviewingSegmentId(null);
      return;
    }

    if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
    reviewPreviewEndRef.current = segment.end;
    setPreviewingSegmentId(segment.id);
    video.pause();
    video.currentTime = segment.start;
    video.playbackRate = 1;
    video.volume = videoVolume;
    video.muted = false;
    safePlay(video);
    setIsPlaying(true);

    let previousPreviewTime = segment.start;
    const monitorPlayback = () => {
      if (reviewPreviewEndRef.current === null) return;
      if (video.currentTime >= reviewPreviewEndRef.current) {
        reviewPreviewEndRef.current = null;
        reviewPreviewFrameRef.current = null;
        video.pause();
        setIsPlaying(false);
        setPreviewingSegmentId(null);
        return;
      }
      const activeSilence = silenceCuts.find((cut) =>
        video.currentTime >= cut.start && previousPreviewTime < cut.end,
      );
      if (activeSilence) {
        video.currentTime = activeSilence.end;
        previousPreviewTime = activeSilence.end;
      } else {
        previousPreviewTime = video.currentTime;
      }
      reviewPreviewFrameRef.current = requestAnimationFrame(monitorPlayback);
    };
    reviewPreviewFrameRef.current = requestAnimationFrame(monitorPlayback);
  }, [previewingSegmentId, safePlay, silenceCuts, videoVolume]);

  const applySelectedCuts = () => {
    const selectedCuts = reviewSegments
      .filter((segment) => selectedCutIds.has(segment.id))
      .map(({ start, end }) => ({ start, end }));
    const cuts = [...selectedCuts, ...silenceCuts];
    reviewPreviewEndRef.current = null;
    if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
    reviewPreviewFrameRef.current = null;
    videoRef.current?.pause();
    setIsPlaying(false);
    setPreviewingSegmentId(null);
    const newDuration = applyCutsToTimeline(cuts);
    setEditedTranscript(buildEditedTranscript(originalTranscriptWords, cuts));
    setIsReviewOpen(false);
    setNotice(`Auto-Cut complete. New duration: ${newDuration.toFixed(2)}s.`);
  };

  const closeReview = () => {
    reviewPreviewEndRef.current = null;
    if (reviewPreviewFrameRef.current !== null) cancelAnimationFrame(reviewPreviewFrameRef.current);
    reviewPreviewFrameRef.current = null;
    videoRef.current?.pause();
    setIsPlaying(false);
    setPreviewingSegmentId(null);
    setIsReviewOpen(false);
  };

  const generateMagicEditPlan = async (userMessage?: string) => {
    const duration = timelineDuration;
    const contextLines = scriptLines.length > 0
      ? scriptLines
      : script.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const transcript = editedTranscript.length > 0 ? editedTranscript : [];
    const fallbackLines = contextLines.length > 0 ? contextLines : transcript.map((segment) => segment.word);
    if (!duration || fallbackLines.length === 0) {
      setMagicEditError("Import a video and add a script or transcript before creating a Magic Edit plan.");
      setIsMagicEditPlanOpen(true);
      return;
    }

    setMagicEditError(null);
    setIsGeneratingMagicEditPlan(true);
    setIsMagicEditPlanOpen(true);
    try {
      const response = await fetch("/api/ai/magic-edit-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scriptLines: fallbackLines,
          transcript,
          duration,
          intensity: aiIntensity,
          aiModel,
          ...(userMessage && universalEditingPlan ? { currentPlan: universalEditingPlan, userMessage } : {}),
        }),
      });
      const result: unknown = await response.json();
      const validatedPlan = EditingPlanSchema.safeParse(result);
      if (!response.ok || !validatedPlan.success) {
        const message = typeof result === "object" && result !== null && "error" in result && typeof result.error === "string"
          ? result.error
          : `Magic Edit plan generation failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      const plan = validatedPlan.data;
      const nextPlan: MagicEditPlanItem[] = plan.timeline_operations.map((operation) => {
        const previous = magicEditPlan.find((candidate) => candidate.id === operation.id);
        const enabled = previous?.enabled ?? true;
        const details = operation.details;
        if (operation.type === "zoom" && operation.track === "v1") {
          const effect = details.effect === "zoom_in" ? "zoom_in_slow"
            : details.effect === "zoom_out" ? "zoom_out_slow"
              : details.effect === "punch_in" ? "punch_in" : null;
          if (!effect) throw new Error("The generated plan contains an unsupported zoom effect.");
          return {
            id: operation.id,
            type: "zoom",
            start: operation.start_time,
            end: operation.end_time,
            effect,
            enabled,
            asset: null,
          };
        }
        if (operation.type === "broll" && operation.track === "v2") {
          const layout = details.layout;
          const searchQuery = details.searchQuery;
          if (
            (layout !== "full" && layout !== "split" && layout !== "pip") ||
            typeof searchQuery !== "string" ||
            (details.assetType !== "png" && details.assetType !== "image")
          ) {
            throw new Error("The generated plan contains invalid B-roll details.");
          }
          return {
            id: operation.id,
            type: "broll",
            start: operation.start_time,
            end: operation.end_time,
            layout,
            assetType: "image",
            searchQuery,
            enabled,
            asset: previous?.type === "broll" ? previous.asset : null,
          };
        }
        if (operation.type === "sfx" && operation.track === "a1") {
          const { searchQuery, volume } = details;
          if (typeof searchQuery !== "string" || typeof volume !== "number") {
            throw new Error("The generated plan contains invalid SFX details.");
          }
          return {
            id: operation.id,
            type: "sfx",
            start: operation.start_time,
            end: operation.end_time,
            searchQuery,
            volume,
            enabled,
            asset: previous?.type === "sfx" ? previous.asset : null,
          };
        }
        if (operation.type === "music" && operation.track === "a2") {
          const { mood, searchQuery, volume } = details;
          if (typeof mood !== "string" || typeof searchQuery !== "string" || typeof volume !== "number") {
            throw new Error("The generated plan contains invalid music details.");
          }
          return {
            id: operation.id,
            type: "music",
            start: operation.start_time,
            end: operation.end_time,
            mood,
            searchQuery,
            volume,
            enabled,
            asset: previous?.type === "music" ? previous.asset : null,
          };
        }
        throw new Error(`The generated ${operation.type} operation uses an unsupported timeline track.`);
      });
      setUniversalEditingPlan(plan);
      setMagicEditPlan(nextPlan);
      if (userMessage) {
        setMagicEditChat((messages) => [...messages, { role: "user", text: userMessage }, { role: "assistant", text: "Updated the edit plan." }]);
        setMagicEditMessage("");
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Magic Edit plan generation failed.";
      console.error("Magic Edit plan generation failed:", error);
      setMagicEditError(message);
    } finally {
      setIsGeneratingMagicEditPlan(false);
    }
  };

  const updateMagicEditItem = (id: string, enabled: boolean) => {
    setMagicEditPlan((items) => items.map((item) => item.id === id ? { ...item, enabled } : item));
  };

  const openAssetSearch = (item: MagicEditPlanItem) => {
    if (item.type === "zoom") return;
    const type = item.type === "broll" ? item.assetType : item.type === "music" ? "music" : "sfx";
    setAssetSearch({ itemId: item.id, type, query: item.searchQuery });
  };

  const attachPlanAsset = (asset: SelectedAsset) => {
    assetUrlsRef.current.add(asset.url);
    if (!assetSearch) return;
    setMagicEditPlan((items) => items.map((item) => {
      if (item.id !== assetSearch.itemId) return item;
      if (item.type === "broll") {
        return { ...item, asset, assetType: asset.mediaType === "video" ? "video" : "image" };
      }
      if (item.type === "sfx" || item.type === "music") return { ...item, asset };
      return item;
    }));
    setAssetSearch(null);
  };

  const applyMagicEditPlan = () => {
    const enabledItems = magicEditPlan.filter((item) => item.enabled);
    const operations = universalEditingPlan?.timeline_operations ?? [];
    const enabledOperations = operations.filter((operation) =>
      enabledItems.some((item) => item.id === operation.id && item.type === operation.type),
    );
    if (enabledItems.length === 0 || !universalEditingPlan) {
      setMagicEditError("Turn on at least one item before applying the plan.");
      return;
    }
    if (enabledOperations.length !== enabledItems.length) {
      setMagicEditError("The reviewed plan no longer matches its timeline operations. Generate the plan again.");
      return;
    }

    const enabledZooms = enabledOperations.flatMap((operation) => {
      const item = enabledItems.find((candidate): candidate is ZoomPlanItem =>
        candidate.id === operation.id && candidate.type === "zoom",
      );
      return operation.type === "zoom" && operation.track === "v1" && item
        ? [{ ...item, start: operation.start_time, end: operation.end_time, track: operation.track }]
        : [];
    });
    const enabledBroll = enabledOperations.flatMap((operation) => {
      const item = enabledItems.find((candidate): candidate is BrollPlanItem =>
        candidate.id === operation.id && candidate.type === "broll",
      );
      return operation.type === "broll" && operation.track === "v2" && item
        ? [{ ...item, start: operation.start_time, end: operation.end_time, track: operation.track }]
        : [];
    });
    const enabledAudio = enabledOperations.flatMap((operation) => {
      const item = enabledItems.find((candidate): candidate is AudioPlanItem =>
        candidate.id === operation.id && (candidate.type === "sfx" || candidate.type === "music"),
      );
      const track = item?.type === "music" && operation.track === "a2" ? operation.track
        : item?.type === "sfx" && operation.track === "a1" ? operation.track : null;
      return (operation.type === "sfx" || operation.type === "music") && item && track
        ? [{ item, start: operation.start_time, end: operation.end_time, track }]
        : [];
    });
    if (enabledZooms.length + enabledBroll.length + enabledAudio.length !== enabledItems.length) {
      setMagicEditError("The plan contains an operation assigned to an unsupported track.");
      return;
    }

    const zoomEffectsToApply = enabledZooms.map(({ id, start, end, track, effect }) => ({
      id,
      start,
      end,
      track,
      effect,
    }));
    const nextVideoClips = clipsRef.current.map((clip) => ({
      ...clip,
      zoomEffects: [
        ...clip.zoomEffects,
        ...zoomEffectsToApply.filter((effect) => effect.start < clip.end && effect.end > clip.start),
      ],
    }));
    const nextBrollClips = [
      ...brollClips,
      ...enabledBroll.map((item): BrollClip => ({
        id: item.id,
        type: "broll",
        start: item.start,
        end: item.end,
        layout: item.layout,
        assetType: item.assetType,
        searchQuery: item.searchQuery,
        asset: item.asset,
        prompt: item.searchQuery,
        aspectRatio: item.layout === "pip" ? "1:1" : format,
        url: item.asset?.url ?? null,
        track: item.track,
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
      })),
    ];
    const nextAudioClips = [
      ...audioClips,
      ...enabledAudio.map(({ item, start, end, track }) => ({
        id: item.id,
        title: item.asset?.title ?? item.searchQuery,
        start,
        end,
        url: item.asset?.url ?? null,
        volume: item.volume / 100,
        track,
      })),
    ];
    updateClips(nextVideoClips);
    setBrollClips(nextBrollClips);
    setAudioClips(nextAudioClips);

    if (process.env.NODE_ENV !== "production") {
      const finalTimelineClips = [
        ...nextVideoClips.map((clip) => ({ ...clip, type: "video" as const, track: "v1" as const })),
        ...nextBrollClips.map(({ id, start, end, track }) => ({ id, type: "broll" as const, start, end, track })),
        ...nextAudioClips.map(({ id, start, end, track }) => ({
          id,
          type: track === "a1" ? "sfx" as const : "music" as const,
          start,
          end,
          track,
        })),
      ];
      console.info("Magic Edit final timeline clips:", finalTimelineClips);
    }

    setIsMagicEditPlanOpen(false);
    setMagicEditError(null);
    setNotice(`Applied ${enabledOperations.length} Magic Edit item${enabledOperations.length === 1 ? "" : "s"} to the timeline.`);
  };

  const replaceBrollImage = (clipId: string, file: File) => {
    if (!file.type.startsWith("image/")) {
      setNotice("Choose an image file to replace this B-Roll placeholder.");
      return;
    }
    const nextUrl = URL.createObjectURL(file);
    assetUrlsRef.current.add(nextUrl);
    setBrollClips((current) => current.map((clip) => {
      if (clip.id !== clipId) return clip;
      return {
        ...clip,
        assetType: "image",
        url: nextUrl,
        asset: { id: crypto.randomUUID(), title: file.name, url: nextUrl, mediaType: "image", duration: 0 },
      };
    }));
  };

  const updateBrollTransform = (clipId: string, updates: Partial<BrollTransform>) => {
    setBrollClips((current) => current.map((clip) =>
      clip.id === clipId ? { ...clip, transform: { ...clip.transform, ...updates } } : clip,
    ));
  };

  const copyBrollPrompt = async (prompt: string) => {
    try {
      await navigator.clipboard.writeText(prompt);
      setNotice("Prompt Copied!");
    } catch (error: unknown) {
      console.error("Could not copy B-Roll prompt:", error);
      setNotice("Could not copy prompt.");
    }
  };

  const startBrollGesture = (event: ReactPointerEvent<HTMLImageElement>, clip: BrollClip) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const currentGesture = brollGestureRef.current?.clipId === clip.id
      ? brollGestureRef.current
      : {
        clipId: clip.id,
        transform: clip.transform,
        pointers: new Map<number, BrollPointer>(),
        origin: { x: event.clientX, y: event.clientY },
        distance: 0,
        angle: 0,
      };
    currentGesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const geometry = getBrollPointerGeometry(currentGesture.pointers);
    currentGesture.transform = clip.transform;
    currentGesture.origin = geometry.origin;
    currentGesture.distance = geometry.distance;
    currentGesture.angle = geometry.angle;
    brollGestureRef.current = currentGesture;
  };

  const moveBrollGesture = (event: ReactPointerEvent<HTMLImageElement>) => {
    const gesture = brollGestureRef.current;
    if (!gesture || !gesture.pointers.has(event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const geometry = getBrollPointerGeometry(gesture.pointers);
    const twoPointers = gesture.pointers.size > 1;
    const updates: Partial<BrollTransform> = {
      x: Math.max(-100, Math.min(100, gesture.transform.x + geometry.origin.x - gesture.origin.x)),
      y: Math.max(-100, Math.min(100, gesture.transform.y + geometry.origin.y - gesture.origin.y)),
    };
    if (twoPointers && gesture.distance > 0) {
      updates.scale = Math.max(0.1, Math.min(3, gesture.transform.scale * geometry.distance / gesture.distance));
      const rotationDelta = ((geometry.angle - gesture.angle + 540) % 360) - 180;
      updates.rotation = Math.max(-180, Math.min(180, gesture.transform.rotation + rotationDelta));
    }
    updateBrollTransform(gesture.clipId, updates);
  };

  const endBrollGesture = (event: ReactPointerEvent<HTMLImageElement>) => {
    const gesture = brollGestureRef.current;
    if (!gesture) return;
    gesture.pointers.delete(event.pointerId);
    if (gesture.pointers.size === 0) {
      brollGestureRef.current = null;
      return;
    }
    const latestTransform = brollClipsRef.current.find((clip) => clip.id === gesture.clipId)?.transform;
    if (latestTransform) gesture.transform = latestTransform;
    const geometry = getBrollPointerGeometry(gesture.pointers);
    gesture.origin = geometry.origin;
    gesture.distance = geometry.distance;
    gesture.angle = geometry.angle;
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

  const seekTime = useCallback((delta: number) => {
    seekTimeline(currentTimeRef.current + delta);
  }, [seekTimeline]);
  const uniqueTracks = ["Video", "B-Roll", "SFX", "Music"];
  const activeBrollClip = brollClips.find((clip) => currentTime >= clip.start && currentTime < clip.end);
  const activeVideoClip = clips.find((clip) => currentTime >= clip.start && currentTime < clip.end);
  const activeZoomEffect = activeVideoClip?.zoomEffects.find((effect) =>
    currentTime >= effect.start && currentTime < effect.end,
  );
  const zoomProgress = activeZoomEffect
    ? Math.max(0, Math.min(1, (currentTime - activeZoomEffect.start) / (activeZoomEffect.end - activeZoomEffect.start)))
    : 0;
  const zoomScale = !activeZoomEffect
    ? 1
    : activeZoomEffect.effect === "zoom_in_slow"
      ? 1 + zoomProgress * 0.12
      : activeZoomEffect.effect === "zoom_out_slow"
        ? 1.12 - zoomProgress * 0.12
        : 1.16;
  const selectedBrollClip = brollClips.find((clip) => clip.id === selectedBrollClipId);
  const selectedVideoClip = clips.find((clip) => clip.id === selectedClipId);

  return (
    <div className="flex flex-col h-[100dvh] bg-black text-white overflow-hidden font-sans">
      {/* 1. TOP BAR */}
      <header className="h-14 flex items-center justify-between px-4 bg-[#0a0a0a] shrink-0">
        <button type="button" onClick={() => router.back()} className="p-2"><ChevronLeft size={24} /></button>
        <div className="text-sm font-semibold text-gray-300">{format} · 1080p</div>
        <button type="button" className="bg-[#4ECDC4] text-black px-4 py-1.5 rounded-md text-xs font-bold">
          Export
        </button>
      </header>

      {/* 2. PREVIEW AREA */}
      <main aria-label="Video preview" className="flex-1 relative flex items-center justify-center bg-black overflow-hidden p-2">
        <div className="relative h-full max-h-full max-w-full border border-[#4ECDC4] bg-black" style={{ aspectRatio: format.replace(":", " / ") }}>
          {videoUrl ? (
            <video
              ref={videoRef}
              src={videoUrl}
              preload="auto"
              playsInline
              onLoadedMetadata={(event) => onVideoLoaded(event.currentTarget)}
              onTimeUpdate={(event) => onVideoTimeUpdate(event.currentTarget)}
              className={`transition-transform duration-100 ${activeBrollClip?.layout === "split"
                ? "absolute left-0 top-0 h-full w-1/2 object-cover"
                : "h-full w-full object-contain"}`}
              style={{ transform: `scale(${zoomScale})` }}
              onClick={togglePlayback}
            />
          ) : (
            <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center justify-center h-full text-gray-500 gap-4">
              <Upload size={40} className="text-[#4ECDC4]" />
              <span className="text-sm">Import a video to start editing</span>
            </button>
          )}
          {videoUrl && activeBrollClip?.url && activeBrollClip.assetType === "image" && (
            <img
              src={activeBrollClip.url}
              alt={activeBrollClip.prompt}
              onPointerDown={(event) => startBrollGesture(event, activeBrollClip)}
              onPointerMove={moveBrollGesture}
              onPointerUp={endBrollGesture}
              onPointerCancel={endBrollGesture}
              onClick={(event) => event.stopPropagation()}
              style={{
                transform: `translate(${activeBrollClip.transform.x}px, ${activeBrollClip.transform.y}px) scale(${activeBrollClip.transform.scale}) rotate(${activeBrollClip.transform.rotation}deg)`,
              }}
              className={`${
                activeBrollClip.layout === "full"
                  ? "absolute inset-0 w-full h-full object-cover z-20 touch-none cursor-grab active:cursor-grabbing"
                  : activeBrollClip.layout === "split"
                    ? "absolute right-0 top-0 w-1/2 h-full object-cover z-20 touch-none cursor-grab active:cursor-grabbing"
                    : "absolute bottom-4 right-4 w-1/3 max-w-[150px] aspect-square rounded-lg border-2 border-white/50 shadow-lg z-20 object-cover touch-none cursor-grab active:cursor-grabbing"
              }`}
            />
          )}
          {videoUrl && activeBrollClip?.url && activeBrollClip.assetType === "video" && (
            <video
              src={activeBrollClip.url}
              aria-label={activeBrollClip.prompt}
              autoPlay
              loop
              muted
              playsInline
              className={`absolute z-20 ${
                activeBrollClip.layout === "full"
                  ? "inset-0 h-full w-full object-cover"
                  : activeBrollClip.layout === "split"
                    ? "right-0 top-0 h-full w-1/2 object-cover"
                    : "bottom-4 right-4 aspect-square w-1/3 max-w-[150px] rounded-lg border-2 border-white/50 object-cover"
              }`}
            />
          )}
        </div>
        {audioClips.map((clip) => (
          clip.url ? <audio
            key={clip.id}
            ref={(element) => {
              if (element) audioElementsRef.current.set(clip.id, element);
              else audioElementsRef.current.delete(clip.id);
            }}
            src={clip.url}
            preload="auto"
          /> : null
        ))}
      </main>

      {/* 3. PLAYBACK CONTROLS (Two thin layers) */}
      <div className="flex flex-col shrink-0 bg-[#0a0a0a] border-b border-[#1a1a1a]">
        <div className="h-9 flex justify-between items-center px-4 border-b border-[#1a1a1a]">
          <div className="flex gap-4">
            <button type="button" onClick={undoClips}><Undo2 size={16} className="text-gray-400" /></button>
            <button type="button" onClick={redoClips}><Redo2 size={16} className="text-gray-400" /></button>
          </div>
          <div className="text-[11px] font-mono text-gray-400 tracking-wider">
            {formatTime(currentTime)} / {formatTime(timelineDuration)}
          </div>
          <button type="button" onClick={() => setIsFullscreen(true)}><Maximize2 size={16} className="text-gray-400" /></button>
        </div>
        <div className="h-14 flex justify-center items-center gap-6">
          <button type="button" onClick={() => seekTime(-1)}><SkipBack size={20} /></button>
          <button type="button" onClick={() => seekTime(-1 / 30)}><ChevronLeft size={24} /></button>
          <button type="button" onClick={togglePlayback} className="w-10 h-10 bg-[#222] rounded-full flex items-center justify-center">
            {isPlaying ? <Pause size={20} fill="white" /> : <Play size={20} fill="white" className="ml-1" />}
          </button>
          <button type="button" onClick={() => seekTime(1 / 30)}><ChevronRight size={24} /></button>
          <button type="button" onClick={() => seekTime(1)}><SkipForward size={20} /></button>
        </div>
      </div>

      {/* 4. TIMELINE */}
      <div aria-label="Video timeline" className="h-[224px] flex bg-[#121212] border-t border-[#222] shrink-0 relative overflow-hidden">
        <div className="w-12 bg-[#0a0a0a] border-r border-[#222] flex flex-col z-10 shrink-0">
          <div className="h-6 border-b border-[#222]"></div>
          {uniqueTracks.map((track) => (
            <div key={track} aria-label={`${track} track`} className="h-10 border-b border-[#222] flex items-center justify-center gap-1">
              <Eye size={12} className="text-gray-500" />
              <span className="text-[9px] text-gray-500">{
                track === "Video" ? "V1" : track === "B-Roll" ? "V2" : track === "SFX" ? "A1" : "A2"
              }</span>
            </div>
          ))}
        </div>
        <div
          ref={timelineScrollerRef}
          className="flex-1 relative overflow-x-auto overflow-y-hidden no-scrollbar"
          onScroll={(event) => {
            const scroller = event.currentTarget;
            updateTimelineTime(scroller.scrollLeft / PIXELS_PER_SECOND);
          }}
        >
          <div className="absolute top-0 bottom-0 left-1/2 w-[2px] bg-white z-30 -translate-x-1/2">
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-3 bg-white rounded-sm"></div>
          </div>
          <div className="flex h-full min-w-max pl-[50%] pr-[50%]">
            <div className="absolute top-0 left-0 right-0 h-6 border-b border-[#222] bg-[#1a1a1a]"></div>
            {uniqueTracks.map((track) => (
              <div key={track} className="relative w-[200vw] h-10 border-b border-[#222] mt-6">
                {track === "Video" ? clips.map((clip) => (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => {
                        setSelectedClipId(clip.id);
                        setSelectedBrollClipId(null);
                        seekTimeline(clip.start);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          setSelectedClipId(clip.id);
                          setSelectedBrollClipId(null);
                        }
                      }}
                      style={{
                        left: `${clip.start * PIXELS_PER_SECOND}px`,
                        width: `${Math.max(4, (clip.end - clip.start) * PIXELS_PER_SECOND)}px`,
                      }}
                      className={`absolute top-0 h-full bg-[#4ECDC4]/20 border border-[#4ECDC4] rounded-sm overflow-hidden flex items-center ${selectedClipId === clip.id ? "ring-1 ring-[#4ECDC4]" : ""}`}
                    >
                      {clip.zoomEffects.map((effect) => {
                        const start = Math.max(effect.start, clip.start);
                        const end = Math.min(effect.end, clip.end);
                        return (
                          <span
                            key={effect.id}
                            aria-label={`V1 zoom: ${effect.effect.replace(/_/gu, " ")}`}
                            style={{
                              left: `${(start - clip.start) * PIXELS_PER_SECOND}px`,
                              width: `${Math.max(4, (end - start) * PIXELS_PER_SECOND)}px`,
                            }}
                            className="pointer-events-none absolute top-0 h-full border border-blue-300/80 bg-blue-400/40"
                          />
                        );
                      })}
                      <span className="relative z-10 text-[10px] text-white px-1">Video</span>
                    </div>
                  )) : track === "B-Roll" ? brollClips.filter((clip) => clip.track === "v2").map((clip) => (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`B-Roll placeholder: ${clip.prompt}`}
                      onClick={() => {
                        setSelectedClipId(clip.id);
                        setSelectedBrollClipId(clip.id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          setSelectedClipId(clip.id);
                          setSelectedBrollClipId(clip.id);
                        }
                      }}
                      style={{
                        left: `${clip.start * PIXELS_PER_SECOND}px`,
                        width: `${Math.max(12, (clip.end - clip.start) * PIXELS_PER_SECOND)}px`,
                      }}
                      className={`absolute top-0 flex h-full items-center gap-1 overflow-hidden rounded-sm border border-dashed border-[#4ECDC4] bg-[#4ECDC4]/10 px-1 text-[9px] text-white ${selectedClipId === clip.id ? "ring-1 ring-[#4ECDC4]" : ""}`}
                    >
                      {clip.url && clip.assetType === "image" ? (
                        <img src={clip.url} alt="" className="h-full min-w-0 flex-1 object-cover" />
                      ) : clip.url && clip.assetType === "video" ? (
                        <span className="truncate">{clip.prompt}</span>
                      ) : (
                        <>
                          <Upload size={12} className="shrink-0 text-[#4ECDC4]" />
                          <span className="truncate">{clip.prompt}</span>
                        </>
                      )}
                    </div>
                  )) : track === "SFX" || track === "Music" ? audioClips.filter((clip) =>
                    track === "SFX" ? clip.track === "a1" : clip.track === "a2",
                  ).map((clip) => (
                    <div
                      key={clip.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`${track} clip: ${clip.title}`}
                      onClick={() => seekTimeline(clip.start)}
                      style={{
                        left: `${clip.start * PIXELS_PER_SECOND}px`,
                        width: `${Math.max(12, (clip.end - clip.start) * PIXELS_PER_SECOND)}px`,
                      }}
                      className={`absolute top-0 flex h-full items-center overflow-hidden rounded-sm border px-1 text-[9px] text-white ${track === "SFX" ? "border-orange-400/70 bg-orange-400/20" : "border-purple-400/70 bg-purple-400/20"}`}
                    >
                      <span className="truncate">{clip.title}</span>
                    </div>
                  )) : null}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 5. BOTTOM TOOLBAR */}
      <footer className="h-16 bg-[#0a0a0a] border-t border-[#222] flex items-center px-2 gap-2 overflow-x-auto shrink-0">
        <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Plus size={20} />
          <span className="text-[10px]">Media</span>
        </button>
        <button type="button" className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Music size={20} />
          <span className="text-[10px]">Audio</span>
        </button>
        <button type="button" className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Captions size={20} />
          <span className="text-[10px]">Captions</span>
        </button>
        <button type="button" className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Type size={20} />
          <span className="text-[10px]">Text</span>
        </button>
        <button type="button" className="flex flex-col items-center min-w-[65px] gap-1 text-gray-300">
          <Layout size={20} />
          <span className="text-[10px]">Overlay</span>
        </button>
        <button type="button" className="flex flex-col items-center min-w-[65px] gap-1 text-[#4ECDC4]">
          <Sparkles size={20} />
          <span className="text-[10px]">Effects</span>
        </button>
        <button type="button" onClick={() => { setMagicEditError(null); setIsMagicEditPlanOpen(true); }} disabled={isGeneratingMagicEditPlan || isAutoCutting || isProcessingScript} className="flex flex-col items-center min-w-[75px] gap-1 text-[#4ECDC4] disabled:opacity-50">
          <Sparkles size={20} />
          <span className="text-[10px] font-bold">{isGeneratingMagicEditPlan ? "Planning…" : "Magic Edit"}</span>
        </button>
        <button type="button" onClick={() => setIsSheetOpen(true)} className="flex flex-col items-center min-w-[65px] gap-1 text-[#4ECDC4] bg-[#4ECDC4]/10 px-2 py-1 rounded-md">
          <Scissors size={20} />
          <span className="text-[10px] font-bold">Auto-Cut</span>
        </button>
      </footer>

      <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
          if (draftId) await saveVideoToOPFS(draftId, file);
          setVideoSource(file);
        } catch (error: unknown) {
          console.error("Media import failed:", error);
          setNotice(error instanceof Error ? error.message : "Could not import this video.");
        } finally {
          event.target.value = "";
        }
      }} />
      <input ref={brollImageInputRef} type="file" accept="image/*" className="hidden" onChange={(event) => {
        const file = event.target.files?.[0];
        if (file && selectedBrollClipId) replaceBrollImage(selectedBrollClipId, file);
        event.target.value = "";
      }} />

      {isSheetOpen && <button type="button" aria-label="Close Auto-Cut" onClick={() => setIsSheetOpen(false)} className="fixed inset-0 z-40 bg-black/60" />}
      <section role="dialog" aria-modal="true" aria-label="Auto-Cut" className={`fixed bottom-0 left-0 right-0 z-50 flex h-[80vh] flex-col rounded-t-2xl border-t border-[#333] bg-[#1a1a1a] text-white shadow-2xl transition-transform ${isSheetOpen ? "translate-y-0" : "pointer-events-none translate-y-full"}`}>
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#333] px-4">
          <h2 className="text-sm font-semibold">Auto-Cut</h2>
          <button type="button" onClick={() => setIsSheetOpen(false)} aria-label="Close" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <label className="text-xs font-medium text-gray-300">
            Script
            <textarea value={script} onChange={(event) => {
              setScript(event.target.value);
              setScriptLines([]);
              setAutoCutError(null);
            }} disabled={isProcessingScript || isAutoCutting} placeholder="Paste the video script..." rows={3} className="mt-2 h-32 w-full resize-y rounded-lg border border-[#383838] bg-[#111] p-3 text-sm text-white placeholder:text-gray-600 focus:border-[#4ECDC4] focus:outline-none disabled:opacity-60" />
          </label>
          <button type="button" onClick={() => void processScriptWithAI()} disabled={!script.trim() || isProcessingScript || isAutoCutting} className="flex w-full shrink-0 items-center justify-center rounded-lg border border-[#4ECDC4]/50 px-4 py-2 text-sm font-medium text-[#4ECDC4] disabled:opacity-40">
            {isProcessingScript ? "Processing Script…" : "Process Script with AI"}
          </button>
          {scriptLines.length > 0 && (
            <ol aria-label="Processed script lines" className="max-h-40 shrink-0 list-decimal space-y-1 overflow-y-auto rounded-lg border border-[#333] bg-[#111] p-3 pl-8 text-xs text-gray-300">
              {scriptLines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}
            </ol>
          )}
          <label className="text-xs font-medium text-gray-300">
            Silence threshold · {silenceThreshold.toFixed(1)}s
            <input aria-label="Silence threshold" type="range" min="0.1" max="2" step="0.1" value={silenceThreshold} onChange={(event) => setSilenceThreshold(Number(event.target.value))} className="mt-2 w-full accent-[#4ECDC4]" />
          </label>
          {autoCutError && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">{autoCutError}</p>}
          <button type="button" onClick={() => void runAutoCut()} disabled={!videoUrl || isAutoCutting || isProcessingScript || !script.trim() || scriptLines.length === 0} className="mt-auto flex w-full items-center justify-center rounded-lg bg-[#4ECDC4] px-4 py-3 text-sm font-bold text-black disabled:opacity-40">
            {isAutoCutting ? "Running Auto-Cut…" : "Run Auto-Cut"}
          </button>
        </div>
      </section>
      {isReviewOpen && (
        <div className="fixed inset-0 z-[70] flex items-end justify-end bg-black/45 text-white md:items-center md:p-5">
          <section role="dialog" aria-modal="true" aria-labelledby="review-cuts-title" className="flex h-[76dvh] w-full flex-col overflow-hidden border-t border-[#383838] bg-[#111315] shadow-2xl md:h-full md:max-h-[900px] md:w-[min(560px,52vw)] md:rounded-2xl md:border">
            <header className="flex shrink-0 items-center justify-between border-b border-[#2b3033] px-5 py-4">
              <div>
                <h2 id="review-cuts-title" className="text-lg font-semibold tracking-tight">Text-Based Editing</h2>
                <p className="mt-1 text-xs text-gray-400">Preview the transcript and choose segments to remove.</p>
              </div>
              <button type="button" onClick={closeReview} aria-label="Close Text-Based Editing" className="rounded-full p-2 text-gray-400 hover:bg-white/10 hover:text-white">
                <X size={20} />
              </button>
            </header>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4 sm:p-5">
              {reviewSegments.length === 0 ? (
                <p className="rounded-xl border border-[#303030] bg-[#191c1e] p-5 text-center text-sm text-gray-400">
                  No transcript segments were found.
                </p>
              ) : reviewSegments.map((segment) => {
                const isSelected = selectedCutIds.has(segment.id);
                return (
                  <article
                    key={segment.id}
                    className={`rounded-xl border p-3.5 sm:p-4 transition-colors duration-200 ${isSelected ? "bg-red-900/20 border-red-500/50" : "bg-[#1a1a1a] border-[#333]"}`}
                  >
                    <div className="mb-2 flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="font-mono text-xs font-medium tabular-nums text-gray-400">
                          {formatTime(segment.start)} - {formatTime(segment.end)}
                        </span>
                        {segment.isSuggestedCut && (
                          <span className="rounded-full bg-red-400/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-red-300">
                            Suggested {segment.reason}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => playReviewSegment(segment)}
                        aria-label={`${previewingSegmentId === segment.id ? "Pause" : "Play"} segment ${formatTime(segment.start)} to ${formatTime(segment.end)}`}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-white transition-colors hover:bg-white/15"
                      >
                        {previewingSegmentId === segment.id
                          ? <Pause size={14} fill="currentColor" />
                          : <Play size={14} fill="currentColor" className="ml-0.5" />}
                      </button>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm leading-6 text-gray-100">
                        {segment.text}
                      </p>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isSelected}
                        aria-label={`${isSelected ? "Remove" : "Keep"} segment ${segment.id}`}
                        onClick={() => toggleSegment(segment.id)}
                        className={`relative w-11 h-6 rounded-full transition-colors flex items-center ${isSelected ? "bg-red-500" : "bg-emerald-500"}`}
                      >
                        <span className={`absolute left-0.5 w-5 h-5 bg-white rounded-full transition-transform ${isSelected ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <footer className="shrink-0 border-t border-[#2b3033] bg-[#111315] p-4 sm:px-5">
              <button type="button" onClick={applySelectedCuts} className="w-full rounded-xl bg-[#4ECDC4] px-5 py-3.5 text-sm font-bold text-black transition-colors hover:bg-[#70ded6]">
                Apply Selected Cuts
                <span className="ml-2 font-medium opacity-70">({selectedCutIds.size + silenceCuts.length})</span>
              </button>
            </footer>
          </section>
        </div>
      )}
      {isMagicEditPlanOpen && (
        <div className="fixed inset-0 z-[70] flex items-end justify-end bg-black/55 text-white md:items-center md:p-5">
          <section role="dialog" aria-modal="true" aria-labelledby="magic-edit-plan-title" className="flex h-[86dvh] w-full flex-col overflow-hidden border-t border-[#383838] bg-[#111315] shadow-2xl md:h-full md:max-h-[900px] md:w-[min(680px,60vw)] md:rounded-2xl md:border">
            <header className="flex h-14 shrink-0 items-center justify-between border-b border-[#2b3033] px-4">
              <div>
                <h2 id="magic-edit-plan-title" className="text-sm font-semibold">Magic Edit Plan</h2>
                <p className="mt-0.5 text-[10px] text-gray-400">Review Zoom, B-roll, SFX, and Music before applying.</p>
              </div>
              <button type="button" onClick={() => setIsMagicEditPlanOpen(false)} aria-label="Close Magic Edit plan" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
            </header>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-3 rounded-xl border border-[#303030] bg-[#191c1e] p-3">
                <label className="text-[10px] text-gray-400">Editing intensity
                  <select
                    value={aiIntensity}
                    onChange={(event) => {
                      const intensity = event.target.value;
                      if (intensity === "subtle" || intensity === "professional" || intensity === "dynamic") {
                        setAiIntensity(intensity);
                      }
                    }}
                    className="mt-1 w-full rounded-md border border-[#383838] bg-[#111] p-2 text-xs text-white"
                  >
                    <option value="subtle">Subtle</option>
                    <option value="professional">Professional</option>
                    <option value="dynamic">Dynamic</option>
                  </select>
                </label>
                <label className="text-[10px] text-gray-400">AI model
                  <select
                    value={aiModel}
                    onChange={(event) => {
                      const model = event.target.value;
                      if (model === "openrouter" || model === "groq") setAiModel(model);
                    }}
                    className="mt-1 w-full rounded-md border border-[#383838] bg-[#111] p-2 text-xs text-white"
                  >
                    <option value="openrouter">OpenRouter (Best)</option>
                    <option value="groq">Groq (Fast)</option>
                  </select>
                </label>
              </div>
              {magicEditError && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">{magicEditError}</p>}
              {isGeneratingMagicEditPlan && <p role="status" className="text-sm text-gray-400">Creating your complete edit plan…</p>}
              {magicEditPlan.map((item, index) => {
                const title = item.type === "broll" ? "B-roll" : item.type === "zoom" ? "Zoom" : item.type === "sfx" ? "Sound effect" : "Music";
                const timeLabel = item.type === "zoom" || item.type === "broll"
                  ? `${item.start.toFixed(1)}s - ${item.end.toFixed(1)}s`
                  : item.type === "sfx" ? `${(item.start ?? 0).toFixed(1)}s` : "Full timeline";
                return (
                  <article key={item.id} className={`rounded-xl border p-3.5 transition-colors ${item.enabled ? "border-[#4ECDC4]/40 bg-[#4ECDC4]/[0.06]" : "border-[#333] bg-[#191c1e] opacity-60"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="text-xs font-semibold">{title} {index + 1}</h3>
                        <p className="mt-1 font-mono text-[11px] text-gray-400">{timeLabel}</p>
                        {item.type === "zoom" && <p className="mt-2 text-xs text-gray-200">{item.effect.replace(/_/gu, " ")}</p>}
                        {item.type === "broll" && (
                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <label className="text-[10px] text-gray-400">Layout
                              <select value={item.layout} onChange={(event) => {
                                const layout = event.target.value as BrollLayout;
                                setMagicEditPlan((items) => items.map((candidate) =>
                                  candidate.id === item.id && candidate.type === "broll" ? { ...candidate, layout } : candidate,
                                ));
                              }} className="mt-1 w-full rounded-md border border-[#383838] bg-[#111] p-2 text-xs text-white">
                                <option value="full">Full screen</option>
                                <option value="split">Split</option>
                                <option value="pip">Picture-in-Picture</option>
                              </select>
                            </label>
                            <p className="self-end pb-2 text-[10px] text-gray-400">{item.assetType} asset</p>
                          </div>
                        )}
                        {(item.type === "broll" || item.type === "sfx" || item.type === "music") && (
                          <p className="mt-2 break-words text-xs text-gray-200">
                            {item.type === "music" ? `${item.mood}: ` : ""}{item.searchQuery}
                          </p>
                        )}
                        {(item.type === "sfx" || item.type === "music") && (
                          <label className="mt-2 block text-[10px] text-gray-400">Volume · {item.volume}%
                            <input aria-label={`${title} volume`} type="range" min="0" max="100" step="1" value={item.volume} onChange={(event) => {
                              const volume = Number(event.target.value);
                              setMagicEditPlan((items) => items.map((candidate) =>
                                candidate.id === item.id && (candidate.type === "sfx" || candidate.type === "music")
                                  ? { ...candidate, volume }
                                  : candidate,
                              ));
                            }} className="mt-1 w-full accent-[#4ECDC4]" />
                          </label>
                        )}
                        {item.asset && <p className="mt-2 truncate text-[10px] text-[#4ECDC4]">Attached: {item.asset.title}</p>}
                        {(item.type === "broll" || item.type === "sfx" || item.type === "music") && (
                          <button type="button" onClick={() => openAssetSearch(item)} className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-[#4ECDC4]/40 px-2.5 py-1.5 text-[10px] font-medium text-[#4ECDC4] hover:bg-[#4ECDC4]/10">
                            <Search size={12} /> Search Asset
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={item.enabled}
                        aria-label={`${item.enabled ? "Turn off" : "Turn on"} ${title} ${index + 1}`}
                        onClick={() => updateMagicEditItem(item.id, !item.enabled)}
                        className={`relative mt-1 flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${item.enabled ? "bg-[#4ECDC4]" : "bg-gray-600"}`}
                      >
                        <span className={`absolute left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${item.enabled ? "translate-x-5" : "translate-x-0"}`} />
                      </button>
                    </div>
                  </article>
                );
              })}
              {!isGeneratingMagicEditPlan && magicEditPlan.length === 0 && !magicEditError && (
                <p className="py-8 text-center text-sm text-gray-400">Generate a plan to start reviewing your edit.</p>
              )}
            </div>
            <div className="shrink-0 border-t border-[#2b3033] bg-[#111315]">
              {magicEditChat.length > 0 && (
                <div aria-label="Magic Edit conversation" className="max-h-24 space-y-1 overflow-y-auto px-4 pt-3">
                  {magicEditChat.slice(-4).map((message, index) => (
                    <p key={`${index}-${message.text}`} className={`text-[10px] ${message.role === "user" ? "text-gray-300" : "text-[#4ECDC4]"}`}>
                      {message.role === "user" ? "You: " : "Magic Edit: "}{message.text}
                    </p>
                  ))}
                </div>
              )}
              <div className="px-4 pt-3">
                <button
                  type="button"
                  onClick={() => void generateMagicEditPlan()}
                  disabled={isGeneratingMagicEditPlan || isAutoCutting || isProcessingScript}
                  className="w-full rounded-lg bg-[#4ECDC4] px-4 py-2.5 text-xs font-bold text-black disabled:opacity-40"
                >
                  {isGeneratingMagicEditPlan ? "Generating Plan…" : magicEditPlan.length > 0 ? "Regenerate Plan" : "Generate Plan"}
                </button>
              </div>
              <form onSubmit={(event) => {
                event.preventDefault();
                const message = magicEditMessage.trim();
                if (message) void generateMagicEditPlan(message);
              }} className="flex gap-2 p-4">
                <input value={magicEditMessage} onChange={(event) => setMagicEditMessage(event.target.value)} disabled={isGeneratingMagicEditPlan} aria-label="Ask to revise the Magic Edit plan" placeholder="Make zooms faster, add more b-roll…" className="min-w-0 flex-1 rounded-lg border border-[#383838] bg-[#0b0c0d] px-3 py-2.5 text-xs text-white outline-none placeholder:text-gray-600 focus:border-[#4ECDC4]" />
                <button type="submit" disabled={!magicEditMessage.trim() || isGeneratingMagicEditPlan || magicEditPlan.length === 0} className="rounded-lg border border-[#383838] px-3 text-xs font-medium text-white disabled:opacity-40">Send</button>
              </form>
              <div className="px-4 pb-4">
                <button type="button" onClick={applyMagicEditPlan} disabled={magicEditPlan.length === 0 || !magicEditPlan.some((item) => item.enabled) || isGeneratingMagicEditPlan} className="w-full rounded-xl bg-[#4ECDC4] px-5 py-3.5 text-sm font-bold text-black transition-colors hover:bg-[#70ded6] disabled:opacity-40">
                  Apply Plan
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
      {selectedBrollClip && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 text-white md:items-center md:p-5">
          <section role="dialog" aria-modal="true" aria-labelledby="broll-inspector-title" className="w-full rounded-t-2xl border-t border-[#383838] bg-[#111315] p-5 shadow-2xl md:max-w-md md:rounded-2xl md:border">
            <header className="mb-4 flex items-center justify-between">
              <h2 id="broll-inspector-title" className="text-sm font-semibold">{selectedBrollClip.url ? "B-Roll Asset" : "B-Roll Placeholder"}</h2>
              <button type="button" onClick={() => {
                setSelectedBrollClipId(null);
                setSelectedClipId(null);
              }} aria-label="Close B-Roll inspector" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
            </header>
            <p className="mb-3 font-mono text-xs text-gray-400">{selectedBrollClip.start.toFixed(1)}s - {selectedBrollClip.end.toFixed(1)}s · {selectedBrollClip.layout} · {selectedBrollClip.assetType}</p>
            <p className="mb-3 text-sm leading-6 text-gray-200">{selectedBrollClip.prompt}</p>
            <button type="button" onClick={() => void copyBrollPrompt(selectedBrollClip.prompt)} className="mb-5 inline-flex items-center justify-center gap-2 rounded-lg border border-[#383838] px-4 py-2 text-sm text-white hover:bg-white/10">
              <Copy size={14} />
              Copy Prompt
            </button>
            {selectedBrollClip.url && selectedBrollClip.assetType === "image" && <img src={selectedBrollClip.url} alt={selectedBrollClip.prompt} className="mb-4 max-h-48 w-full rounded-lg object-contain" />}
            {selectedBrollClip.url && selectedBrollClip.assetType === "video" && <video src={selectedBrollClip.url} controls className="mb-4 max-h-48 w-full rounded-lg object-contain" />}
            <fieldset className="mb-5 rounded-lg border border-[#383838] p-3">
              <legend className="px-1 text-xs font-semibold text-white">Transform</legend>
              <label className="mb-3 block text-[11px] text-gray-400">
                Position X · {selectedBrollClip.transform.x}
                <input aria-label="Position X" type="range" min="-100" max="100" step="1" value={selectedBrollClip.transform.x} onChange={(event) => updateBrollTransform(selectedBrollClip.id, { x: Number(event.target.value) })} className="mt-1 w-full accent-[#4ECDC4]" />
              </label>
              <label className="mb-3 block text-[11px] text-gray-400">
                Position Y · {selectedBrollClip.transform.y}
                <input aria-label="Position Y" type="range" min="-100" max="100" step="1" value={selectedBrollClip.transform.y} onChange={(event) => updateBrollTransform(selectedBrollClip.id, { y: Number(event.target.value) })} className="mt-1 w-full accent-[#4ECDC4]" />
              </label>
              <label className="mb-3 block text-[11px] text-gray-400">
                Scale · {selectedBrollClip.transform.scale.toFixed(1)}
                <input aria-label="Scale" type="range" min="0.1" max="3" step="0.1" value={selectedBrollClip.transform.scale} onChange={(event) => updateBrollTransform(selectedBrollClip.id, { scale: Number(event.target.value) })} className="mt-1 w-full accent-[#4ECDC4]" />
              </label>
              <label className="block text-[11px] text-gray-400">
                Rotation · {selectedBrollClip.transform.rotation}°
                <input aria-label="Rotation" type="range" min="-180" max="180" step="1" value={selectedBrollClip.transform.rotation} onChange={(event) => updateBrollTransform(selectedBrollClip.id, { rotation: Number(event.target.value) })} className="mt-1 w-full accent-[#4ECDC4]" />
              </label>
            </fieldset>
            <button type="button" onClick={() => brollImageInputRef.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#4ECDC4] px-4 py-3 text-sm font-bold text-black">
              <Upload size={16} />
              {selectedBrollClip.url ? "Replace Image" : "Upload Image"}
            </button>
          </section>
        </div>
      )}
      {selectedVideoClip && !selectedBrollClip && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/55 text-white md:items-center md:p-5">
          <section role="dialog" aria-modal="true" aria-labelledby="video-inspector-title" className="w-full rounded-t-2xl border-t border-[#383838] bg-[#111315] p-5 shadow-2xl md:max-w-md md:rounded-2xl md:border">
            <header className="mb-4 flex items-center justify-between">
              <h2 id="video-inspector-title" className="text-sm font-semibold">Video Properties</h2>
              <button type="button" onClick={() => setSelectedClipId(null)} aria-label="Close Video Properties" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
            </header>
            <p className="mb-4 font-mono text-xs text-gray-400">{selectedVideoClip.start.toFixed(1)}s - {selectedVideoClip.end.toFixed(1)}s · V1</p>
          </section>
        </div>
      )}
      <AssetSearchPanel
        isOpen={assetSearch !== null}
        draftId={draftId}
        initialType={assetSearch?.type ?? "video"}
        initialQuery={assetSearch?.query ?? ""}
        onClose={() => setAssetSearch(null)}
        onSelect={attachPlanAsset}
      />
      {notice && <div role="status" className="fixed bottom-20 left-1/2 z-[60] -translate-x-1/2 rounded-lg border border-[#383838] bg-[#242424] px-4 py-2 text-xs text-white shadow-lg">{notice}<button type="button" onClick={() => setNotice(null)} aria-label="Dismiss notification" className="ml-3 text-gray-400"><X size={12} /></button></div>}
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
