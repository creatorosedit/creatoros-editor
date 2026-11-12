import { NextResponse } from "next/server";
import { authorizeTeamRequest } from "@/lib/api/team-api-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;

  return NextResponse.json({
    code: "PROVIDER_DISABLED",
    error: "Cloud transcription is disabled because no zero-cost provider is verified. Local silence detection remains available; no audio was uploaded.",
  }, { status: 503 });
}
