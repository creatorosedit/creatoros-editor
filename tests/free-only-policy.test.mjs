import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {afterEach, test} from "node:test";
import {generateKeyPairSync, sign} from "node:crypto";
import {
  authorizeTeamRequest,
  verifyFirebaseIdToken,
} from "../src/lib/api/team-api-auth.ts";
import {generateGeminiJson} from "../src/lib/ai/gemini.ts";
import {
  APPROVED_AI_MODELS,
  AI_PROVIDER_POLICY,
  FreeQuotaExhaustedError,
  freeQuotaResponse,
  isApprovedAIModel,
} from "../src/lib/ai/provider-policy.ts";
import {persistLocalFirstProject} from "../src/lib/projects/local-first.ts";
import {hasActiveFirebaseTeamMembership} from "../src/lib/api/team-api-auth.ts";

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.GEMINI_API_KEY;
const originalProjectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = originalApiKey;
  if (originalProjectId === undefined) delete process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  else process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = originalProjectId;
});

function makeAnonymousIdToken(projectId, privateKey, uid = "approved-user") {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({alg: "RS256", kid: "test-key"});
  const claims = encode({
    aud: projectId,
    auth_time: now,
    exp: now + 3600,
    firebase: {sign_in_provider: "anonymous"},
    iat: now,
    iss: `https://securetoken.google.com/${projectId}`,
    sub: uid,
  });
  const payload = `${header}.${claims}`;
  const signature = sign("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64url");
  return `${payload}.${signature}`;
}

test("the server allowlist only enables the verified Gemini free-tier model", () => {
  assert.deepEqual(APPROVED_AI_MODELS, ["gemini-3.8-flash"]);
  assert.equal(AI_PROVIDER_POLICY.paidProvidersEnabled, false);
  assert.equal(isApprovedAIModel("gemini-3.8-flash"), true);
  assert.equal(isApprovedAIModel("gemini-2.5-pro"), false);
  assert.equal(isApprovedAIModel("z-ai/glm-4.5-air"), false);
  assert.equal(isApprovedAIModel("openai/gpt-oss-120b"), false);
});

test("server-authenticated Gemini calls cannot select or retry an unapproved provider", async () => {
  process.env.GEMINI_API_KEY = "test-key";
  let callCount = 0;
  let requestedUrl = "";
  globalThis.fetch = async (input) => {
    callCount += 1;
    requestedUrl = String(input);
    return new Response(JSON.stringify({error: {message: "quota exhausted"}}), {status: 429});
  };

  await assert.rejects(generateGeminiJson("prompt", "system", {}), FreeQuotaExhaustedError);
  assert.equal(callCount, 1);
  assert.match(requestedUrl, /models\/gemini-3\.8-flash:generateContent/u);
  assert.doesNotMatch(requestedUrl, /openrouter|groq|gemini-2\.5-pro/u);
  const quotaResponse = freeQuotaResponse(new FreeQuotaExhaustedError());
  assert.equal(quotaResponse.status, 429);
  assert.deepEqual(await quotaResponse.json(), {
    code: "FREE_QUOTA_EXHAUSTED",
    error: "The Gemini free quota is exhausted. Wait for the quota to reset; no other provider was used.",
  });
});

test("Firebase ID token verification checks the signature, project, expiry, and anonymous provider", async () => {
  const projectId = "creatoros-test-project";
  const {privateKey, publicKey} = generateKeyPairSync("rsa", {modulusLength: 2048});
  const token = makeAnonymousIdToken(projectId, privateKey);
  const publicPem = publicKey.export({type: "spki", format: "pem"});
  const fetcher = async () => new Response(
    JSON.stringify({"test-key": publicPem}),
    {headers: {"cache-control": "max-age=3600"}},
  );

  assert.deepEqual(await verifyFirebaseIdToken(token, projectId, fetcher), {uid: "approved-user"});
  await assert.rejects(verifyFirebaseIdToken(token, "another-project", fetcher), /claims are invalid/u);
  await assert.rejects(
    verifyFirebaseIdToken(`${token.slice(0, token.lastIndexOf(".") + 1)}ZmFrZQ`, projectId, fetcher),
    /signature is invalid/u,
  );
});

test("team API authorization rejects unauthenticated callers and non-members, and accepts active members", async (t) => {
  const unauthenticated = await authorizeTeamRequest(new Request("https://creatoros.local/api/ai/chat"));
  assert.equal(unauthenticated.ok, false);
  if (!unauthenticated.ok) assert.equal(unauthenticated.response.status, 401);

  const dependencies = {
    projectId: "creatoros-test-project",
    verifyToken: async (token) => ({uid: token}),
    consumeRateLimit: () => true,
  };
  const makeRequest = (token) => new Request("https://creatoros.local/api/ai/chat", {
    headers: {Authorization: `Bearer ${token}`},
  });

  await t.test("non-member is denied", async () => {
    const result = await authorizeTeamRequest(makeRequest("pending-user"), {
      ...dependencies,
      hasActiveMembership: async () => false,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 403);
  });

  await t.test("active member is authorized with UID derived from the verified token", async () => {
    const result = await authorizeTeamRequest(makeRequest("approved-user"), {
      ...dependencies,
      hasActiveMembership: async (_token, uid) => uid === "approved-user",
    });
    assert.deepEqual(result, {ok: true, uid: "approved-user"});
  });

  await t.test("rate limits are enforced before membership reads", async () => {
    let membershipReads = 0;
    const result = await authorizeTeamRequest(makeRequest("limited-user"), {
      ...dependencies,
      consumeRateLimit: () => false,
      hasActiveMembership: async () => {
        membershipReads += 1;
        return true;
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 429);
    assert.equal(membershipReads, 0);
  });

  await t.test("missing server project configuration fails closed", async () => {
    const result = await authorizeTeamRequest(makeRequest("approved-user"), {
      projectId: "",
      verifyToken: async () => {
        throw new Error("Token verification should not be reached.");
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.response.status, 503);
  });
});

test("Firestore membership lookup accepts only active supported team roles", async () => {
  const requests = [];
  const fetcher = async (input, init) => {
    requests.push({url: String(input), authorization: new Headers(init.headers).get("authorization")});
    return Response.json({
      fields: {
        active: {booleanValue: true},
        role: {stringValue: "member"},
      },
    });
  };
  assert.equal(await hasActiveFirebaseTeamMembership("test-id-token", "approved-user", "creatoros-test", fetcher), true);
  assert.equal(requests[0].authorization, "Bearer test-id-token");
  assert.match(requests[0].url, /teamMembers\/approved-user$/u);

  const inactiveFetcher = async () => Response.json({
    fields: {
      active: {booleanValue: false},
      role: {stringValue: "admin"},
    },
  });
  assert.equal(await hasActiveFirebaseTeamMembership("test-id-token", "inactive-user", "creatoros-test", inactiveFetcher), false);
});

test("Firestore metadata quota errors do not delete locally saved OPFS media", async () => {
  let localFile = null;
  await assert.rejects(
    persistLocalFirstProject(
      async () => {
        localFile = {name: "source.mp4", content: "already stored in OPFS"};
        return true;
      },
      async () => {
        throw new Error("Firestore quota exceeded.");
      },
    ),
    /Firestore quota exceeded/u,
  );
  assert.deepEqual(localFile, {name: "source.mp4", content: "already stored in OPFS"});
});

test("no paid provider dependencies or automatic billing activation are configured", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../src/lib/ai/provider-policy.ts", import.meta.url), "utf8");
  assert.equal("openai" in packageJson.dependencies, false);
  assert.equal("groq-sdk" in packageJson.dependencies, false);
  assert.equal("ffmpeg-static" in packageJson.dependencies, false);
  assert.equal(AI_PROVIDER_POLICY.paidProvidersEnabled, false);
  assert.doesNotMatch(source, /billing.{0,30}(enable|upgrade)|auto.?upgrade/iu);
});
