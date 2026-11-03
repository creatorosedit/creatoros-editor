import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const ALLOWED_HOSTS = [
  "pexels.com",
  "jamendo.com",
  "freesound.org",
  "soundhelix.com",
];
const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_REDIRECTS = 4;

function isAllowedUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    const isAllowedHost = ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    if (url.protocol !== "https:" || !isAllowedHost || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const requestedUrl = request.nextUrl.searchParams.get("url");
  if (!requestedUrl || requestedUrl.length > 4_096 || !isAllowedUrl(requestedUrl)) {
    return NextResponse.json({ error: "A supported HTTPS asset URL is required." }, { status: 400 });
  }

  try {
    let url = requestedUrl;
    let upstream: Response | null = null;
    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      upstream = await fetch(url, { cache: "no-store", redirect: "manual" });
      if (upstream.status < 300 || upstream.status >= 400) break;
      const location = upstream.headers.get("location");
      if (!location || redirectCount === MAX_REDIRECTS) {
        return NextResponse.json({ error: "The asset provider returned too many redirects." }, { status: 502 });
      }
      const redirectedUrl = new URL(location, url).toString();
      if (!isAllowedUrl(redirectedUrl)) {
        return NextResponse.json({ error: "The asset provider redirected to an unsupported host." }, { status: 502 });
      }
      url = redirectedUrl;
    }

    if (!upstream?.ok || !upstream.body) {
      return NextResponse.json({ error: `Asset download failed (HTTP ${upstream?.status ?? 502}).` }, { status: 502 });
    }
    const contentLength = Number(upstream.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "The asset exceeds the 100 MB download limit." }, { status: 413 });
    }

    let bytesSent = 0;
    const limitedBody = upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytesSent += chunk.byteLength;
        if (bytesSent > MAX_FILE_SIZE) {
          controller.error(new Error("The asset exceeds the 100 MB download limit."));
          return;
        }
        controller.enqueue(chunk);
      },
    }));
    const contentType = upstream.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream";
    return new NextResponse(limitedBody, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="asset.${contentType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "bin"}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: unknown) {
    console.error("Asset download failed:", error);
    const message = error instanceof Error ? error.message : "Asset download failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
