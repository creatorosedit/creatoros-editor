import { NextRequest, NextResponse } from "next/server";
import { authorizeTeamRequest } from "@/lib/api/team-api-auth";

export async function GET(request: NextRequest) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;

  return NextResponse.json({
    code: "PROVIDER_DISABLED",
    error: "External asset downloads are disabled until zero-cost provider terms are verified.",
  }, { status: 503 });
}
