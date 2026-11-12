import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authorizeTeamRequest } from "@/lib/api/team-api-auth";

export const runtime = "nodejs";

const SearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(200),
  type: z.enum(["video", "image", "music", "sfx", "ai"]),
});

export async function GET(request: NextRequest) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;

  const parsed = SearchRequestSchema.safeParse({
    query: request.nextUrl.searchParams.get("query"),
    type: request.nextUrl.searchParams.get("type"),
  });
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: "Provide a search query and supported asset type." }, { status: 400 });
  }
  return NextResponse.json({
    success: false,
    code: "PROVIDER_DISABLED",
    error: `${parsed.data.type} search is disabled until its zero-cost usage terms are verified.`,
  }, { status: 503 });
}
