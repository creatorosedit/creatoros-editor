export const AI_PROVIDER_POLICY = Object.freeze({
  provider: "google-gemini-developer-api",
  model: "gemini-3.8-flash",
  paidProvidersEnabled: false,
});

export const APPROVED_AI_MODELS = Object.freeze([AI_PROVIDER_POLICY.model]);

export function isApprovedAIModel(model: string): boolean {
  return APPROVED_AI_MODELS.some((approvedModel) => approvedModel === model);
}

export class FreeQuotaExhaustedError extends Error {
  readonly code = "FREE_QUOTA_EXHAUSTED";

  constructor(message = "The Gemini free quota is exhausted. Wait for the quota to reset; no other provider was used.") {
    super(message);
    this.name = "FreeQuotaExhaustedError";
  }
}

export function isFreeQuotaExhaustedError(error: unknown): error is FreeQuotaExhaustedError {
  return error instanceof FreeQuotaExhaustedError;
}

export function freeQuotaResponse(error: unknown): Response | null {
  if (!isFreeQuotaExhaustedError(error)) return null;
  return Response.json(
    { code: error.code, error: error.message },
    { status: 429 },
  );
}
