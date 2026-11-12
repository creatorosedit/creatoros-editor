import { signInAnonymously, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { app, auth, db } from "@/lib/firebase/client";
import {
  checkTeamMembership,
  createSingleFlight,
  isMembershipForUser,
  parseTeamMembership,
} from "./team-auth-policy";
import type { TeamMembership } from "./team-auth-policy";
export {
  checkTeamMembership,
  isAdminMembership,
  isMembershipForUser,
  parseTeamMembership,
} from "./team-auth-policy";
export type {
  MembershipCheck,
  MembershipCheckStatus,
  TeamMembership,
  TeamRole,
} from "./team-auth-policy";

type DiagnosticField = { value: unknown; type: string };
export type TeamMembershipDiagnostics = {
  authenticatedUid: string;
  firebaseProjectId: string | null;
  documentPath: string;
  snapshotExists: boolean | null;
  active: DiagnosticField;
  role: DiagnosticField;
  membershipParserResult: TeamMembership | null;
  readError: { code: string | null; message: string | null } | null;
};

const requestAnonymousSignIn = createSingleFlight(() => signInAnonymously(auth));

export function ensureAuthenticatedUser(): Promise<User> {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return requestAnonymousSignIn().then((credential) => credential.user);
}

export async function getTeamMembership(
  uid: string,
  onDiagnostics?: (diagnostics: TeamMembershipDiagnostics) => void,
): Promise<TeamMembership | null> {
  const membershipRef = doc(db, "teamMembers", uid);
  const diagnosticIdentity = {
    authenticatedUid: uid,
    firebaseProjectId: app.options.projectId ?? null,
    documentPath: membershipRef.path,
  };
  if (process.env.NODE_ENV === "development") {
    console.info("[TeamAccess diagnostics] Authenticated UID, Firebase project ID, and Firestore document path", {
      ...diagnosticIdentity,
    });
  }

  let membershipSnapshot;
  try {
    membershipSnapshot = await getDoc(membershipRef);
  } catch (error: unknown) {
    const errorDetails = error && typeof error === "object"
      ? error as { code?: unknown; message?: unknown }
      : {};
    onDiagnostics?.({
      ...diagnosticIdentity,
      snapshotExists: null,
      active: { value: undefined, type: "undefined" },
      role: { value: undefined, type: "undefined" },
      membershipParserResult: null,
      readError: {
        code: typeof errorDetails.code === "string" ? errorDetails.code : null,
        message: typeof errorDetails.message === "string" ? errorDetails.message : null,
      },
    });
    if (process.env.NODE_ENV === "development") {
      console.error("[TeamAccess diagnostics] Firestore getDoc failed", {
        code: typeof errorDetails.code === "string" ? errorDetails.code : null,
        message: typeof errorDetails.message === "string" ? errorDetails.message : null,
      });
    }
    throw error;
  }

  const snapshotExists = membershipSnapshot.exists();
  const snapshotData = snapshotExists ? membershipSnapshot.data() : undefined;
  const hasActive = snapshotData !== undefined && Object.prototype.hasOwnProperty.call(snapshotData, "active");
  const hasRole = snapshotData !== undefined && Object.prototype.hasOwnProperty.call(snapshotData, "role");
  const membership = snapshotExists ? parseTeamMembership(snapshotData) : null;

  onDiagnostics?.({
    ...diagnosticIdentity,
    snapshotExists,
    active: { value: snapshotData?.active, type: typeof snapshotData?.active },
    role: { value: snapshotData?.role, type: typeof snapshotData?.role },
    membershipParserResult: membership,
    readError: null,
  });

  if (process.env.NODE_ENV === "development") {
    console.info("[TeamAccess diagnostics] Membership snapshot and parser result", {
      snapshotExists,
      active: {
        exists: hasActive,
        value: snapshotData?.active,
        type: typeof snapshotData?.active,
      },
      role: {
        exists: hasRole,
        value: snapshotData?.role,
        type: typeof snapshotData?.role,
      },
      membershipParserResult: membership,
    });
  }

  return membership;
}
