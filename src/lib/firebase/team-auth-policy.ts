export type TeamRole = "admin" | "member";
export type TeamMembership = { role: TeamRole; active: true };
export type MembershipCheckStatus = "approved" | "pending" | "error";
export type MembershipCheck = {
  uid: string;
  status: MembershipCheckStatus;
  membership: TeamMembership | null;
  error: unknown | null;
};

export async function checkTeamMembership(
  uid: string,
  readMembership: (uid: string) => Promise<TeamMembership | null>,
): Promise<MembershipCheck> {
  try {
    const membership = await readMembership(uid);
    return {
      uid,
      status: membership ? "approved" : "pending",
      membership,
      error: null,
    };
  } catch (error: unknown) {
    return { uid, status: "error", membership: null, error };
  }
}

export function isMembershipForUser(userUid: string | null, membershipUid: string | null): boolean {
  return userUid !== null && userUid === membershipUid;
}

export function createSingleFlight<T>(operation: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = Promise.resolve().then(operation).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

export function parseTeamMembership(value: unknown): TeamMembership | null {
  if (typeof value !== "object" || value === null) return null;
  const membership = value as Record<string, unknown>;
  if (membership.active !== true) return null;
  if (membership.role !== "admin" && membership.role !== "member") return null;
  return { role: membership.role, active: true };
}

export function isAdminMembership(membership: TeamMembership | null): boolean {
  return membership?.active === true && membership.role === "admin";
}

export function handleAuthState<UserType>(
  user: UserType | null,
  handlers: {
    authenticated: (user: UserType) => void;
    signingIn: () => void;
    signIn: () => Promise<unknown>;
    onError: (error: unknown) => void;
  },
): void {
  if (user) {
    handlers.authenticated(user);
    return;
  }
  handlers.signingIn();
  void handlers.signIn().catch(handlers.onError);
}
