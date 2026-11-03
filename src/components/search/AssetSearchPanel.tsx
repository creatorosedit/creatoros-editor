"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Image, LoaderCircle, Music2, Pause, Play, Search, X } from "lucide-react";
import { saveAssetToOPFS } from "@/lib/video/opfs";

type SearchType = "video" | "image" | "ai" | "music" | "sfx";
type AssetMediaType = "video" | "image" | "audio";

interface SearchResult {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  duration: number;
}

export interface SelectedAsset {
  id: string;
  title: string;
  url: string;
  mediaType: AssetMediaType;
  duration: number;
}

interface AssetSearchPanelProps {
  isOpen: boolean;
  draftId: string | null;
  initialType?: SearchType;
  initialQuery?: string;
  onClose: () => void;
  onSelect: (asset: SelectedAsset) => void;
}

const TABS: Array<{ type: SearchType; label: string }> = [
  { type: "video", label: "Videos" },
  { type: "image", label: "Images" },
  { type: "ai", label: "AI" },
  { type: "music", label: "Music" },
  { type: "sfx", label: "SFX" },
];

function isSearchResult(value: unknown): value is SearchResult {
  return typeof value === "object" && value !== null &&
    "id" in value && typeof value.id === "string" &&
    "title" in value && typeof value.title === "string" &&
    "thumbnail" in value && typeof value.thumbnail === "string" &&
    "url" in value && typeof value.url === "string" &&
    "duration" in value && typeof value.duration === "number";
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function getMediaType(type: SearchType): AssetMediaType {
  if (type === "music" || type === "sfx") return "audio";
  return type === "video" ? "video" : "image";
}

export default function AssetSearchPanel({
  isOpen,
  draftId,
  initialType = "video",
  initialQuery = "",
  onClose,
  onSelect,
}: AssetSearchPanelProps) {
  const [type, setType] = useState<SearchType>(initialType);
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setType(initialType);
    setQuery(initialQuery);
    setResults([]);
    setHasSearched(false);
    setError(null);
  }, [initialQuery, initialType, isOpen]);

  useEffect(() => {
    if (isOpen) return;
    audioRef.current?.pause();
    setPlayingId(null);
  }, [isOpen]);

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
  }, []);

  const search = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (!query.trim()) {
      setError("Enter a search term to find assets.");
      return;
    }
    setIsSearching(true);
    setError(null);
    setHasSearched(true);
    try {
      const params = new URLSearchParams({ query: query.trim(), type });
      const response = await fetch(`/api/search?${params.toString()}`);
      const payload: unknown = await response.json();
      if (
        !response.ok ||
        typeof payload !== "object" ||
        payload === null ||
        !("success" in payload) ||
        payload.success !== true ||
        !("results" in payload) ||
        !Array.isArray(payload.results) ||
        !payload.results.every(isSearchResult)
      ) {
        const message = typeof payload === "object" && payload !== null &&
          "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Asset search failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      setResults(payload.results);
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : "Asset search failed.";
      console.error("Asset search failed:", caught);
      setError(message);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  const togglePreview = async (result: SearchResult) => {
    if (playingId === result.id) {
      audioRef.current?.pause();
      setPlayingId(null);
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(result.url);
    audioRef.current = audio;
    audio.addEventListener("ended", () => setPlayingId(null), { once: true });
    audio.addEventListener("error", () => {
      setPlayingId(null);
      setError("This audio preview could not be played.");
    }, { once: true });
    setPlayingId(result.id);
    try {
      await audio.play();
    } catch (caught: unknown) {
      setPlayingId(null);
      setError(caught instanceof Error ? caught.message : "This audio preview could not be played.");
    }
  };

  const downloadAndSelectAsset = async (result: SearchResult) => {
    setDownloadingId(result.id);
    setError(null);
    try {
      const response = await fetch(`/api/download-asset?url=${encodeURIComponent(result.url)}`);
      if (!response.ok) {
        const payload: unknown = await response.json();
        const message = typeof payload === "object" && payload !== null &&
          "error" in payload && typeof payload.error === "string"
          ? payload.error
          : `Asset download failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      const blob = await response.blob();
      const contentType = response.headers.get("content-type")?.split(";")[0] || blob.type || "application/octet-stream";
      const extension = contentType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "bin";
      const safeName = result.title.replace(/[^a-z0-9-_]+/giu, "-").replace(/^-|-$/gu, "").slice(0, 60) || "asset";
      const file = new File([blob], `${safeName}.${extension}`, { type: contentType });
      const assetId = crypto.randomUUID();
      await saveAssetToOPFS(draftId ?? "studio-assets", assetId, file);
      const url = URL.createObjectURL(file);
      onSelect({
        id: assetId,
        title: result.title,
        url,
        mediaType: getMediaType(type),
        duration: result.duration,
      });
      onClose();
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : "Could not download this asset.";
      console.error("Asset download failed:", caught);
      setError(message);
    } finally {
      setDownloadingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 text-white md:items-center md:p-5">
      <section role="dialog" aria-modal="true" aria-labelledby="asset-search-title" className="flex h-[84dvh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-[#383838] bg-[#111315] shadow-2xl md:h-[min(800px,90vh)] md:max-w-4xl md:rounded-2xl md:border">
        <header className="flex shrink-0 items-center justify-between border-b border-[#2b3033] px-4 py-3">
          <div>
            <h2 id="asset-search-title" className="text-sm font-semibold">Universal Asset Search</h2>
            <p className="mt-1 text-[11px] text-gray-400">Search and add media to this edit.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close asset search" className="rounded-full p-2 text-gray-400 hover:bg-white/10"><X size={18} /></button>
        </header>
        <div className="shrink-0 border-b border-[#2b3033] px-4 pt-3">
          <div role="tablist" aria-label="Asset type" className="flex gap-2 overflow-x-auto">
            {TABS.map((tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={type === tab.type}
                key={tab.type}
                onClick={() => {
                  audioRef.current?.pause();
                  setPlayingId(null);
                  setType(tab.type);
                  setResults([]);
                  setHasSearched(false);
                  setError(null);
                }}
                className={`shrink-0 border-b-2 px-3 py-2 text-xs ${type === tab.type ? "border-[#4ECDC4] text-[#4ECDC4]" : "border-transparent text-gray-400 hover:text-white"}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <form onSubmit={(event) => void search(event)} className="flex gap-2 py-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-[#383838] bg-[#0b0c0d] px-3 focus-within:border-[#4ECDC4]">
              <Search size={16} className="shrink-0 text-gray-500" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search assets" placeholder={`Search ${type === "sfx" ? "sound effects" : type}…`} className="min-w-0 flex-1 bg-transparent py-2.5 text-sm text-white outline-none placeholder:text-gray-600" />
            </label>
            <button type="submit" disabled={isSearching || !query.trim()} className="rounded-lg bg-[#4ECDC4] px-4 text-sm font-semibold text-black disabled:opacity-40">
              {isSearching ? <LoaderCircle size={16} className="animate-spin" /> : "Search"}
            </button>
          </form>
        </div>
        {error && <p role="alert" className="mx-4 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200">{error}</p>}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isSearching ? (
            <p role="status" className="py-12 text-center text-sm text-gray-400">Searching assets…</p>
          ) : results.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {results.map((result) => (
                <article key={result.id} className="overflow-hidden rounded-xl border border-[#303436] bg-[#191c1e]">
                  <div className="relative aspect-video bg-[#0b0c0d]">
                    {type === "music" || type === "sfx" ? (
                      <div className="flex h-full items-center justify-center text-[#4ECDC4]"><Music2 size={30} /></div>
                    ) : result.thumbnail ? (
                      <img src={result.thumbnail} alt="" loading="lazy" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center text-gray-500"><Image size={26} /></div>
                    )}
                    {type === "music" || type === "sfx" ? (
                      <button type="button" onClick={() => void togglePreview(result)} aria-label={`${playingId === result.id ? "Pause" : "Play"} ${result.title}`} className="absolute inset-0 m-auto flex h-10 w-10 items-center justify-center rounded-full bg-black/70 text-white">
                        {playingId === result.id ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
                      </button>
                    ) : result.duration > 0 ? (
                      <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[10px]">{formatDuration(result.duration)}</span>
                    ) : null}
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-xs font-medium text-gray-100" title={result.title}>{result.title}</p>
                    <button type="button" onClick={() => void downloadAndSelectAsset(result)} disabled={downloadingId !== null} className="mt-2 w-full rounded-md bg-[#4ECDC4] px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50">
                      {downloadingId === result.id ? "Downloading…" : "Use"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <p className="py-12 text-center text-sm text-gray-500">
              {hasSearched ? "No assets found. Try a different search." : "Search videos, images, AI assets, music, or sound effects."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
