import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  type: z.enum(["video", "image", "music", "sfx", "ai"]),
});

type AssetResult = {
  id: string;
  title: string;
  thumbnail: string;
  url: string;
  duration: number;
};

const MOCK_RESULTS: Record<SearchRequestSchemaType["type"], AssetResult[]> = {
  video: [
    { id: "mock-video-1", title: "Morning city commute", thumbnail: "https://images.pexels.com/photos/466685/pexels-photo-466685.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://videos.pexels.com/video-files/3195394/3195394-hd_1920_1080_25fps.mp4", duration: 12 },
    { id: "mock-video-2", title: "Quiet coffee shop", thumbnail: "https://images.pexels.com/photos/302899/pexels-photo-302899.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://videos.pexels.com/video-files/3129671/3129671-hd_1920_1080_25fps.mp4", duration: 9 },
    { id: "mock-video-3", title: "Person working on a laptop", thumbnail: "https://images.pexels.com/photos/4974914/pexels-photo-4974914.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://videos.pexels.com/video-files/3191883/3191883-hd_1920_1080_25fps.mp4", duration: 15 },
    { id: "mock-video-4", title: "Sunlight through trees", thumbnail: "https://images.pexels.com/photos/15286/pexels-photo.jpg?auto=compress&cs=tinysrgb&w=640", url: "https://videos.pexels.com/video-files/3129595/3129595-hd_1920_1080_25fps.mp4", duration: 8 },
  ],
  image: [
    { id: "mock-image-1", title: "Creative team planning", thumbnail: "https://images.pexels.com/photos/3184325/pexels-photo-3184325.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/3184325/pexels-photo-3184325.jpeg", duration: 0 },
    { id: "mock-image-2", title: "Phone and coffee", thumbnail: "https://images.pexels.com/photos/4348404/pexels-photo-4348404.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/4348404/pexels-photo-4348404.jpeg", duration: 0 },
    { id: "mock-image-3", title: "City skyline at dusk", thumbnail: "https://images.pexels.com/photos/466685/pexels-photo-466685.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/466685/pexels-photo-466685.jpeg", duration: 0 },
    { id: "mock-image-4", title: "Hands using a laptop", thumbnail: "https://images.pexels.com/photos/1181244/pexels-photo-1181244.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/1181244/pexels-photo-1181244.jpeg", duration: 0 },
  ],
  ai: [
    { id: "mock-ai-1", title: "Cinematic creative workspace", thumbnail: "https://images.pexels.com/photos/3184325/pexels-photo-3184325.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/3184325/pexels-photo-3184325.jpeg", duration: 0 },
    { id: "mock-ai-2", title: "Thoughtful moment by a window", thumbnail: "https://images.pexels.com/photos/4348404/pexels-photo-4348404.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/4348404/pexels-photo-4348404.jpeg", duration: 0 },
    { id: "mock-ai-3", title: "Warm evening city lights", thumbnail: "https://images.pexels.com/photos/466685/pexels-photo-466685.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/466685/pexels-photo-466685.jpeg", duration: 0 },
    { id: "mock-ai-4", title: "Minimal desk and laptop", thumbnail: "https://images.pexels.com/photos/1181244/pexels-photo-1181244.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://images.pexels.com/photos/1181244/pexels-photo-1181244.jpeg", duration: 0 },
  ],
  music: [
    { id: "mock-music-1", title: "Gentle piano bed", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3", duration: 372 },
    { id: "mock-music-2", title: "Ambient focus", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3", duration: 298 },
    { id: "mock-music-3", title: "Reflective soundtrack", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-3.mp3", duration: 310 },
    { id: "mock-music-4", title: "Uplifting instrumental", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-4.mp3", duration: 291 },
  ],
  sfx: [
    { id: "mock-sfx-1", title: "Soft transition whoosh", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://cdn.freesound.org/previews/411/411642_5121236-lq.mp3", duration: 2 },
    { id: "mock-sfx-2", title: "Subtle cinematic impact", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://cdn.freesound.org/previews/411/411642_5121236-lq.mp3", duration: 1 },
    { id: "mock-sfx-3", title: "Gentle notification chime", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://cdn.freesound.org/previews/411/411642_5121236-lq.mp3", duration: 1 },
    { id: "mock-sfx-4", title: "Light airy sweep", thumbnail: "https://images.pexels.com/photos/164821/pexels-photo-164821.jpeg?auto=compress&cs=tinysrgb&w=640", url: "https://cdn.freesound.org/previews/411/411642_5121236-lq.mp3", duration: 2 },
  ],
};

type SearchRequestSchemaType = z.infer<typeof SearchRequestSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pexelsImageResult(value: unknown): AssetResult | null {
  if (!isRecord(value) || typeof value.id !== "number" || typeof value.url !== "string") return null;
  const src = isRecord(value.src) ? value.src : null;
  const image = src && (typeof src.large === "string" ? src.large : src.original);
  if (typeof image !== "string") return null;
  return {
    id: String(value.id),
    title: typeof value.alt === "string" && value.alt.trim() ? value.alt : "Pexels photo",
    thumbnail: typeof src?.medium === "string" ? src.medium : image,
    url: image,
    duration: 0,
  };
}

function pexelsVideoResult(value: unknown): AssetResult | null {
  if (!isRecord(value) || typeof value.id !== "number" || !Array.isArray(value.video_files)) return null;
  const files = value.video_files.filter(isRecord);
  const selectedFile = files.find((file) => file.quality === "hd" && typeof file.link === "string") ??
    files.find((file) => typeof file.link === "string");
  if (!selectedFile || typeof selectedFile.link !== "string") return null;
  return {
    id: String(value.id),
    title: "Pexels video",
    thumbnail: typeof value.image === "string" ? value.image : "",
    url: selectedFile.link,
    duration: typeof value.duration === "number" ? value.duration : 0,
  };
}

async function searchPexels(query: string, type: "video" | "image" | "ai"): Promise<AssetResult[]> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return MOCK_RESULTS[type];
  const endpoint = type !== "video"
    ? `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=24`
    : `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=24`;
  const response = await fetch(endpoint, { headers: { Authorization: apiKey }, cache: "no-store" });
  if (!response.ok) throw new Error(`Pexels search failed (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error("Pexels returned an invalid response.");
  const rows = type !== "video" ? body.photos : body.videos;
  if (!Array.isArray(rows)) throw new Error("Pexels returned no searchable results.");
  return rows.flatMap((row) => {
    const result = type !== "video" ? pexelsImageResult(row) : pexelsVideoResult(row);
    return result ? [result] : [];
  });
}

async function searchJamendo(query: string): Promise<AssetResult[]> {
  const clientId = process.env.JAMENDO_CLIENT_ID;
  if (!clientId) return MOCK_RESULTS.music;
  const endpoint = new URL("https://api.jamendo.com/v3.0/tracks/");
  endpoint.searchParams.set("client_id", clientId);
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("limit", "24");
  endpoint.searchParams.set("search", query);
  endpoint.searchParams.set("audioformat", "mp32");
  const response = await fetch(endpoint, { cache: "no-store" });
  if (!response.ok) throw new Error(`Jamendo search failed (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.results)) throw new Error("Jamendo returned an invalid response.");
  return body.results.flatMap((row): AssetResult[] => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.name !== "string" || typeof row.audio !== "string") return [];
    return [{
      id: row.id,
      title: row.name,
      thumbnail: typeof row.album_image === "string" ? row.album_image : "",
      url: row.audio,
      duration: typeof row.duration === "number" ? row.duration : 0,
    }];
  });
}

async function searchFreesound(query: string): Promise<AssetResult[]> {
  const apiKey = process.env.FREESOUND_API_KEY;
  if (!apiKey) return MOCK_RESULTS.sfx;
  const endpoint = new URL("https://freesound.org/apiv2/search/text/");
  endpoint.searchParams.set("query", query);
  endpoint.searchParams.set("fields", "id,name,duration,previews,images");
  endpoint.searchParams.set("page_size", "24");
  endpoint.searchParams.set("token", apiKey);
  const response = await fetch(endpoint, { cache: "no-store" });
  if (!response.ok) throw new Error(`Freesound search failed (HTTP ${response.status}).`);
  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.results)) throw new Error("Freesound returned an invalid response.");
  return body.results.flatMap((row): AssetResult[] => {
    if (!isRecord(row) || typeof row.id !== "number" || typeof row.name !== "string" || !isRecord(row.previews)) return [];
    const preview = row.previews["preview-hq-mp3"] ?? row.previews["preview-lq-mp3"];
    if (typeof preview !== "string") return [];
    const images = isRecord(row.images) ? row.images : null;
    return [{
      id: String(row.id),
      title: row.name,
      thumbnail: typeof images?.waveform_l === "string" ? images.waveform_l : "",
      url: preview,
      duration: typeof row.duration === "number" ? row.duration : 0,
    }];
  });
}

export async function GET(request: NextRequest) {
  const parsed = SearchRequestSchema.safeParse({
    query: request.nextUrl.searchParams.get("query"),
    type: request.nextUrl.searchParams.get("type"),
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Provide a search query and supported asset type." }, { status: 400 });
  }
  const { query, type } = parsed.data;
  try {
    const results = type === "music"
      ? await searchJamendo(query)
      : type === "sfx"
        ? await searchFreesound(query)
        : await searchPexels(query, type);
    return NextResponse.json({ success: true, results });
  } catch (error: unknown) {
    console.error("Asset search failed:", error);
    const message = error instanceof Error ? error.message : "Asset search failed.";
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
