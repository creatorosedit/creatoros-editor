import assert from "node:assert/strict";
import {test} from "node:test";
import {
  checkTeamMembership,
  createSingleFlight,
  handleAuthState,
  isAdminMembership,
  isMembershipForUser,
  parseTeamMembership,
} from "../src/lib/firebase/team-auth-policy.ts";
import {mapSharedDrafts} from "../src/lib/projects/shared-drafts.ts";

test("reuses one in-flight anonymous sign-in and permits a retry after failure", async () => {
  let calls = 0;
  let rejectFirst;
  const signIn = createSingleFlight(() => {
    calls += 1;
    if (calls === 1) return new Promise((resolve, reject) => {
      rejectFirst = reject;
    });
    return Promise.resolve("signed-in");
  });

  const first = signIn();
  const concurrent = signIn();
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(first, concurrent);
  rejectFirst(new Error("network unavailable"));
  await assert.rejects(first, /network unavailable/u);
  assert.equal(await signIn(), "signed-in");
  assert.equal(calls, 2);
});

test("auth state reuses an existing user and starts sign-in only when absent", async () => {
  const states = [];
  let signIns = 0;
  const handlers = {
    authenticated: (user) => states.push(["authenticated", user]),
    signingIn: () => states.push(["signing-in"]),
    signIn: async () => {
      signIns += 1;
    },
    onError: (error) => states.push(["error", error]),
  };

  handleAuthState({uid: "existing-user"}, handlers);
  handleAuthState(null, handlers);
  await Promise.resolve();

  assert.deepEqual(states.map(([state]) => state), ["authenticated", "signing-in"]);
  assert.equal(signIns, 1);
});

test("membership parser rejects missing, inactive, and unsupported roles", () => {
  assert.equal(parseTeamMembership(null), null);
  assert.equal(parseTeamMembership({role: "member", active: false}), null);
  assert.equal(parseTeamMembership({role: "owner", active: true}), null);
  assert.equal(parseTeamMembership({role: "admin", active: "true"}), null);
  assert.equal(parseTeamMembership({role: "admin"}), null);
  assert.equal(parseTeamMembership({active: true}), null);
});

test("membership parser accepts only active admin and member roles", () => {
  assert.deepEqual(parseTeamMembership({role: "admin", active: true}), {role: "admin", active: true});
  assert.deepEqual(parseTeamMembership({role: "member", active: true}), {role: "member", active: true});
});

test("admin permission distinguishes active admins from members", () => {
  assert.equal(isAdminMembership(parseTeamMembership({role: "admin", active: true})), true);
  assert.equal(isAdminMembership(parseTeamMembership({role: "member", active: true})), false);
  assert.equal(isAdminMembership(parseTeamMembership({role: "admin", active: false})), false);
  assert.equal(isAdminMembership(null), false);
});

test("membership check approves valid records and leaves missing records pending", async () => {
  const adminCheck = await checkTeamMembership("admin-uid", async (uid) => {
    assert.equal(uid, "admin-uid");
    return parseTeamMembership({role: "admin", active: true});
  });
  assert.deepEqual(adminCheck, {
    uid: "admin-uid",
    status: "approved",
    membership: {role: "admin", active: true},
    error: null,
  });

  const memberCheck = await checkTeamMembership("member-uid", async () =>
    parseTeamMembership({role: "member", active: true}));
  assert.equal(memberCheck.status, "approved");

  const inactiveCheck = await checkTeamMembership("inactive-uid", async () =>
    parseTeamMembership({role: "member", active: false}));
  assert.equal(inactiveCheck.status, "pending");

  const missingCheck = await checkTeamMembership("missing-uid", async () => null);
  assert.equal(missingCheck.status, "pending");
});

test("membership read failures remain errors rather than becoming pending", async () => {
  const readError = new Error("permission denied");
  const check = await checkTeamMembership("team-uid", async () => {
    throw readError;
  });

  assert.equal(check.status, "error");
  assert.equal(check.membership, null);
  assert.equal(check.error, readError);
});

test("membership from a previous authenticated UID cannot be reused", () => {
  assert.equal(isMembershipForUser("new-uid", "old-uid"), false);
  assert.equal(isMembershipForUser("new-uid", "new-uid"), true);
  assert.equal(isMembershipForUser(null, "old-uid"), false);
});

test("shared project mapping includes legacy guest-owned drafts without changing their documents", () => {
  const legacyDocument = {
    id: "legacy-project",
    createdBy: "old-browser-guest-id",
    createdAt: 12,
    topic: "Legacy edit",
    handoffId: "handoff-1",
  };
  const currentDocument = {
    id: "current-project",
    createdBy: "firebase-uid",
    createdAt: 24,
    topic: "New edit",
  };
  const mapped = mapSharedDrafts([
    {id: "legacy-project", data: () => legacyDocument},
    {id: "current-project", data: () => currentDocument},
  ]);

  assert.deepEqual(mapped.map(({id}) => id), ["current-project", "legacy-project"]);
  assert.equal(mapped[1].topic, "Legacy edit");
  assert.deepEqual(legacyDocument, {
    id: "legacy-project",
    createdBy: "old-browser-guest-id",
    createdAt: 12,
    topic: "Legacy edit",
    handoffId: "handoff-1",
  });
});
