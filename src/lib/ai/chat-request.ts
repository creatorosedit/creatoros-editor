import { z } from "zod";
import type { EditorContext } from "@/lib/editor/editor-context";

export const MAX_CHAT_REQUEST_BYTES = 512 * 1024;

const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  editorContext: z.unknown().optional(),
  context: z.string().max(1_000).optional(),
}).strict();

export interface ChatRequest {
  message: string;
  editorContext: EditorContext | null;
  legacyContext: string | null;
}

export function parseChatRequest(
  payload: unknown,
  bodyBytes: number,
  validateContext: (value: unknown) => EditorContext,
): ChatRequest {
  if (!Number.isFinite(bodyBytes) || bodyBytes < 0 || bodyBytes > MAX_CHAT_REQUEST_BYTES) {
    throw new Error("Chat request exceeds the maximum allowed size.");
  }
  const request = ChatRequestSchema.parse(payload);
  return {
    message: request.message,
    editorContext: request.editorContext === undefined
      ? null
      : validateContext(request.editorContext),
    legacyContext: request.context ?? null,
  };
}
