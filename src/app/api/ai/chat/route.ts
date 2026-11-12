import { NextResponse } from "next/server";
import { generateGeminiText } from "@/lib/ai/gemini";
import { freeQuotaResponse } from "@/lib/ai/provider-policy";
import { parseChatRequest, MAX_CHAT_REQUEST_BYTES, type ChatRequest } from "@/lib/ai/chat-request";
import { formatEditorContextForPrompt, validateEditorContext } from "@/lib/editor/editor-context";
import { authorizeTeamRequest, readJsonBody } from "@/lib/api/team-api-auth";

export async function POST(request: Request) {
  const authorization = await authorizeTeamRequest(request);
  if (!authorization.ok) return authorization.response;

  const parsedBody = await readJsonBody(request, MAX_CHAT_REQUEST_BYTES);
  if (!parsedBody.ok) return parsedBody.response;

  let chatRequest: ChatRequest;
  try {
    chatRequest = parseChatRequest(parsedBody.body, parsedBody.bytes, validateEditorContext);
  } catch {
    return NextResponse.json({ error: "Chat request or editor context is invalid." }, { status: 400 });
  }

  const editorContextText = chatRequest.editorContext
    ? formatEditorContextForPrompt(chatRequest.editorContext)
    : `No structured editor context was provided. Legacy context: ${chatRequest.legacyContext ?? "unavailable"}.`;
  const systemPrompt = [
    "You are an expert AI Video Director. Keep answers short.",
    "Use the supplied editor context as metadata only. It does not mean you have watched, seen, or analyzed the actual video.",
    "Distinguish clearly between the entire active timeline, a selected clip, a selected timeline range, and no active video.",
    "If a clip or range is selected, answer about that selection when relevant; otherwise refer to the active timeline.",
    "Do not claim to have analyzed the video content unless actual video data has been provided in a future feature.",
    `Current editor context:\n${editorContextText}`,
  ].join("\n\n");

  try {
    const text = await generateGeminiText(chatRequest.message, systemPrompt, request.signal);
    return NextResponse.json({ text, model: "gemini-3.8-flash" });
  } catch (error: unknown) {
    const quotaResponse = freeQuotaResponse(error);
    if (quotaResponse) return quotaResponse;
    console.error("AI chat failed:", error);
    const message = error instanceof Error ? error.message : "AI chat failed.";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
