import { createPublicKey, verify as verifySignature } from "node:crypto";

type FirebaseClaims = {
  aud?: unknown;
  auth_time?: unknown;
  exp?: unknown;
  firebase?: unknown;
  iat?: unknown;
  iss?: unknown;
  sub?: unknown;
};

type VerifiedTeamUser = { uid: string };

type FirebaseCertificateSet = {
  expiresAt: number;
  certificates: Record<string, string>;
};

type ApiAuthDependencies = {
  projectId?: string;
  fetcher?: typeof fetch;
  verifyToken?: (token: string, projectId: string) => Promise<VerifiedTeamUser>;
  hasActiveMembership?: (token: string, uid: string, projectId: string) => Promise<boolean>;
  consumeRateLimit?: (uid: string, path: string) => boolean;
};

type AuthorizationResult =
  | { ok: true; uid: string }
  | { ok: false; response: Response };

type JsonBodyResult =
  | { ok: true; body: unknown; bytes: number }
  | { ok: false; response: Response };

const certificateUrl = "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com";
const rateLimitWindowMs = 60_000;
const rateLimitByRoute = new Map<string, { startedAt: number; count: number }>();
let cachedCertificates: FirebaseCertificateSet | null = null;

function jsonResponse(status: number, code: string, error: string): Response {
  return Response.json({ code, error }, { status });
}

function parseJwtPart(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

async function getFirebaseCertificates(fetcher: typeof fetch): Promise<Record<string, string>> {
  if (cachedCertificates && cachedCertificates.expiresAt > Date.now()) {
    return cachedCertificates.certificates;
  }

  const response = await fetcher(certificateUrl, { cache: "no-store" });
  if (!response.ok) throw new Error("Firebase signing certificates are unavailable.");

  const certificates: unknown = await response.json();
  if (typeof certificates !== "object" || certificates === null || Array.isArray(certificates)) {
    throw new Error("Firebase signing certificates are invalid.");
  }

  const cacheControl = response.headers.get("cache-control") ?? "";
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/iu)?.[1] ?? 0);
  cachedCertificates = {
    certificates: certificates as Record<string, string>,
    expiresAt: Date.now() + Math.max(0, maxAge) * 1000,
  };
  return cachedCertificates.certificates;
}

export async function verifyFirebaseIdToken(
  token: string,
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<VerifiedTeamUser> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Firebase ID token.");

  let header: unknown;
  let claims: unknown;
  try {
    header = parseJwtPart(parts[0] ?? "");
    claims = parseJwtPart(parts[1] ?? "");
  } catch {
    throw new Error("Invalid Firebase ID token.");
  }
  if (
    typeof header !== "object" ||
    header === null ||
    !("alg" in header) ||
    header.alg !== "RS256" ||
    !("kid" in header) ||
    typeof header.kid !== "string" ||
    typeof claims !== "object" ||
    claims === null
  ) {
    throw new Error("Invalid Firebase ID token.");
  }

  const firebaseClaims = claims as FirebaseClaims;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    firebaseClaims.aud !== projectId ||
    firebaseClaims.iss !== `https://securetoken.google.com/${projectId}` ||
    typeof firebaseClaims.sub !== "string" ||
    firebaseClaims.sub.length === 0 ||
    firebaseClaims.sub.length > 128 ||
    typeof firebaseClaims.exp !== "number" ||
    firebaseClaims.exp <= nowSeconds ||
    typeof firebaseClaims.iat !== "number" ||
    firebaseClaims.iat > nowSeconds + 60 ||
    typeof firebaseClaims.auth_time !== "number" ||
    firebaseClaims.auth_time > nowSeconds + 60 ||
    typeof firebaseClaims.firebase !== "object" ||
    firebaseClaims.firebase === null ||
    !("sign_in_provider" in firebaseClaims.firebase) ||
    firebaseClaims.firebase.sign_in_provider !== "anonymous"
  ) {
    throw new Error("Firebase ID token claims are invalid.");
  }

  const certificates = await getFirebaseCertificates(fetcher);
  const certificate = certificates[header.kid];
  if (!certificate) {
    throw new Error("Firebase ID token signing key is unknown.");
  }
  const signedContent = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2] ?? "", "base64url");
  if (!verifySignature("RSA-SHA256", signedContent, createPublicKey(certificate), signature)) {
    throw new Error("Firebase ID token signature is invalid.");
  }

  return { uid: firebaseClaims.sub };
}

export async function hasActiveFirebaseTeamMembership(
  token: string,
  uid: string,
  projectId: string,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/teamMembers/${encodeURIComponent(uid)}`;
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (response.status === 403 || response.status === 404) return false;
  if (!response.ok) throw new Error(`Firestore membership check failed (HTTP ${response.status}).`);

  const document: unknown = await response.json();
  if (typeof document !== "object" || document === null || !("fields" in document)) return false;
  const fields = document.fields;
  if (typeof fields !== "object" || fields === null) return false;
  const active = "active" in fields ? fields.active : null;
  const role = "role" in fields ? fields.role : null;
  return typeof active === "object" && active !== null && "booleanValue" in active && active.booleanValue === true &&
    typeof role === "object" && role !== null && "stringValue" in role &&
    (role.stringValue === "admin" || role.stringValue === "member");
}

function consumeInMemoryRateLimit(uid: string, path: string): boolean {
  const now = Date.now();
  const key = `${uid}:${path}`;
  const current = rateLimitByRoute.get(key);
  const limit = path.startsWith("/api/ai/") ? 12 : 60;
  if (!current || now - current.startedAt >= rateLimitWindowMs) {
    rateLimitByRoute.set(key, { startedAt: now, count: 1 });
    if (rateLimitByRoute.size > 10_000) {
      for (const [entryKey, entry] of rateLimitByRoute) {
        if (now - entry.startedAt >= rateLimitWindowMs) rateLimitByRoute.delete(entryKey);
      }
    }
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

export async function authorizeTeamRequest(
  request: Request,
  dependencies: ApiAuthDependencies = {},
): Promise<AuthorizationResult> {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/u);
  if (!match?.[1]) {
    return { ok: false, response: jsonResponse(401, "UNAUTHENTICATED", "Sign in with an approved team account.") };
  }

  const projectId = dependencies.projectId ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  if (!projectId) {
    return { ok: false, response: jsonResponse(503, "AUTH_CONFIGURATION_UNAVAILABLE", "Server authentication is not configured.") };
  }

  try {
    const fetcher = dependencies.fetcher ?? fetch;
    const user = await (dependencies.verifyToken ?? ((token, id) => verifyFirebaseIdToken(token, id, fetcher)))(
      match[1],
      projectId,
    );
    if (!(dependencies.consumeRateLimit ?? consumeInMemoryRateLimit)(user.uid, new URL(request.url).pathname)) {
      return { ok: false, response: jsonResponse(429, "RATE_LIMITED", "Too many requests. Wait a minute and try again.") };
    }
    const isMember = await (
      dependencies.hasActiveMembership ??
      ((token, uid, id) => hasActiveFirebaseTeamMembership(token, uid, id, fetcher))
    )(match[1], user.uid, projectId);
    if (!isMember) {
      return { ok: false, response: jsonResponse(403, "TEAM_ACCESS_DENIED", "An active team membership is required.") };
    }
    return { ok: true, uid: user.uid };
  } catch (error: unknown) {
    console.error("Team API authentication failed:", error);
    return { ok: false, response: jsonResponse(503, "AUTHENTICATION_UNAVAILABLE", "Team access could not be verified. Try again shortly.") };
  }
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<JsonBodyResult> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    return { ok: false, response: jsonResponse(413, "REQUEST_TOO_LARGE", "Request body exceeds the allowed size.") };
  }

  const reader = request.body?.getReader();
  if (!reader) return { ok: false, response: jsonResponse(400, "INVALID_JSON", "Request body must be valid JSON.") };

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { ok: false, response: jsonResponse(413, "REQUEST_TOO_LARGE", "Request body exceeds the allowed size.") };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(bytes)), bytes: totalBytes };
  } catch {
    return { ok: false, response: jsonResponse(400, "INVALID_JSON", "Request body must be valid JSON.") };
  }
}
