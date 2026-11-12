"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { onAuthStateChanged, type User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import {
  checkTeamMembership,
  ensureAuthenticatedUser,
  getTeamMembership,
  isAdminMembership,
  isMembershipForUser,
  type TeamMembership,
  type TeamMembershipDiagnostics,
} from "@/lib/firebase/team-auth";
import { handleAuthState } from "@/lib/firebase/team-auth-policy";

type AuthStatus = "initializing" | "signing-in" | "authenticated" | "error";
type MembershipStatus = "checking" | "approved" | "pending" | "error";

type TeamAccess = {
  authStatus: AuthStatus;
  membershipStatus: MembershipStatus;
  user: User | null;
  membership: TeamMembership | null;
  isAdmin: boolean;
  error: string | null;
  diagnostics: TeamMembershipDiagnostics | null;
  retry: () => void;
};

const TeamAccessContext = createContext<TeamAccess | null>(null);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed. Check your connection and retry.";
}

function AccessStatus({
  title,
  message,
  error,
  action,
  actionLabel,
}: {
  title: string;
  message: string;
  error?: string | null;
  action?: () => void;
  actionLabel?: string;
}) {
  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#0a0a0a] px-5 text-white">
      <section className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#111414] p-6">
        <div className="mb-4 h-2 w-10 rounded-full bg-[#4ECDC4]" />
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-gray-400">{message}</p>
        {error && <p role="alert" className="mt-3 break-words text-sm text-red-300">{error}</p>}
        {action && actionLabel && (
          <button
            type="button"
            onClick={action}
            className="mt-5 rounded-lg bg-[#4ECDC4] px-4 py-2 text-sm font-semibold text-black"
          >
            {actionLabel}
          </button>
        )}
      </section>
    </main>
  );
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted]")
    .replace(/\bya29\.[0-9A-Za-z._-]+\b/g, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:key|token|access_token|auth)=)[^&\s]+/gi, "$1[redacted]");
}

function formatDiagnosticValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(redactDiagnosticText(value));
  if (value === undefined) return "undefined";
  if (value === null || typeof value === "boolean" || typeof value === "number") return String(value);
  return `[${typeof value}]`;
}

function MembershipDiagnosticPanel({
  diagnostics,
  status,
}: {
  diagnostics: TeamMembershipDiagnostics | null;
  status: MembershipStatus;
}) {
  const parserResult = diagnostics?.membershipParserResult
    ? JSON.stringify(diagnostics.membershipParserResult)
    : diagnostics ? "null" : "Unavailable";
  const readError = diagnostics?.readError
    ? `${diagnostics.readError.code ?? "No code"}: ${diagnostics.readError.message
      ? redactDiagnosticText(diagnostics.readError.message)
      : "No message"}`
    : diagnostics ? "None" : "Unavailable";
  const rows = [
    ["Authenticated UID", diagnostics?.authenticatedUid ?? "Unavailable"],
    ["Firebase project ID", diagnostics?.firebaseProjectId ?? "Unavailable"],
    ["Firestore document path", diagnostics?.documentPath ?? "Unavailable"],
    ["Snapshot exists", diagnostics?.snapshotExists === null || !diagnostics ? "Unavailable" : String(diagnostics.snapshotExists)],
    [
      "active value and JavaScript type",
      diagnostics
        ? `${formatDiagnosticValue(diagnostics.active.value)} (type: ${diagnostics.active.type})`
        : "Unavailable",
    ],
    [
      "role value and JavaScript type",
      diagnostics
        ? `${formatDiagnosticValue(diagnostics.role.value)} (type: ${diagnostics.role.type})`
        : "Unavailable",
    ],
    ["Membership parser result", parserResult],
    ["Final provider status", status],
    ["Firestore read error code/message", readError],
  ];

  return (
    <section
      aria-label="Development membership diagnostics"
      className="mt-4 max-h-[42dvh] overflow-y-auto rounded-lg border border-amber-300/30 bg-black/40 p-3 text-xs"
    >
      <h2 className="mb-2 font-semibold text-amber-200">Development diagnostics</h2>
      <dl className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="border-t border-white/10 pt-2 first:border-0 first:pt-0">
            <dt className="text-gray-400">{label}</dt>
            <dd className="mt-0.5 break-words font-mono text-gray-100">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function PendingAccess({
  uid,
  onRetry,
  diagnostics,
  status,
}: {
  uid: string;
  onRetry: () => void;
  diagnostics: TeamMembershipDiagnostics | null;
  status: MembershipStatus;
}) {
  const [copyMessage, setCopyMessage] = useState("");

  const copyUid = async () => {
    try {
      await navigator.clipboard.writeText(uid);
      setCopyMessage("UID copied.");
    } catch (error: unknown) {
      console.error("Could not copy the Firebase UID:", error);
      setCopyMessage("Could not copy automatically. Select and copy the UID above.");
    }
  };

  return (
    <main className="flex min-h-[100dvh] items-center justify-center bg-[#0a0a0a] px-5 text-white">
      <section className="w-full max-w-md rounded-2xl border border-white/[0.08] bg-[#111414] p-6">
        <div className="mb-4 h-2 w-10 rounded-full bg-[#4ECDC4]" />
        <h1 className="text-xl font-semibold">Access pending approval</h1>
        <p className="mt-2 text-sm leading-6 text-gray-400">
          This Firebase account is not an active team member yet. Send this UID to your administrator for approval.
        </p>
        {process.env.NODE_ENV === "development" && (
          <MembershipDiagnosticPanel diagnostics={diagnostics} status={status} />
        )}
        <p className="mt-5 break-all rounded-lg border border-white/[0.08] bg-black/30 p-3 font-mono text-sm text-[#4ECDC4]">
          {uid}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void copyUid()}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/5"
          >
            Copy Firebase UID
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border border-white/15 px-4 py-2 text-sm font-semibold hover:bg-white/5"
          >
            Check access again
          </button>
        </div>
        {copyMessage && <p role="status" className="mt-2 text-xs text-gray-400">{copyMessage}</p>}
      </section>
    </main>
  );
}

export function useTeamAccess(): TeamAccess {
  const context = useContext(TeamAccessContext);
  if (!context) throw new Error("useTeamAccess must be used within TeamAccessProvider.");
  return context;
}

export function TeamAccessProvider({ children }: { children: ReactNode }) {
  const [authStatus, setAuthStatus] = useState<AuthStatus>("initializing");
  const [membershipStatus, setMembershipStatus] = useState<MembershipStatus>("checking");
  const [user, setUser] = useState<User | null>(null);
  const [membership, setMembership] = useState<TeamMembership | null>(null);
  const [membershipUid, setMembershipUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<TeamMembershipDiagnostics | null>(null);
  const [membershipRetry, setMembershipRetry] = useState(0);

  useEffect(() => {
    let active = true;
    const unsubscribe = onAuthStateChanged(
      auth,
      (authenticatedUser) => {
        if (!active) return;
        handleAuthState(authenticatedUser, {
          authenticated: (authenticatedUser) => {
            setUser(authenticatedUser);
            setMembership(null);
            setMembershipUid(null);
            setDiagnostics(null);
            setMembershipStatus("checking");
            setAuthStatus("authenticated");
            setError(null);
          },
          signingIn: () => {
            setUser(null);
            setMembership(null);
            setMembershipUid(null);
            setDiagnostics(null);
            setMembershipStatus("checking");
            setAuthStatus("signing-in");
            setError(null);
          },
          signIn: ensureAuthenticatedUser,
          onError: (signInError) => {
            if (!active) return;
            setAuthStatus("error");
            setError(describeError(signInError));
          },
        });
      },
      (authError) => {
        if (!active) return;
        setAuthStatus("error");
        setError(describeError(authError));
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    setMembershipStatus("checking");
    setMembership(null);
    setMembershipUid(null);
    setDiagnostics(null);
    setError(null);
    void checkTeamMembership(user.uid, (uid) =>
      getTeamMembership(
        uid,
        process.env.NODE_ENV === "development"
          ? (membershipDiagnostics) => {
            if (active) setDiagnostics(membershipDiagnostics);
          }
          : undefined,
      ),
    ).then((check) => {
      if (!active) return;
      setMembership(check.membership);
      setMembershipUid(check.uid);
      setMembershipStatus(check.status);
      setError(check.error === null ? null : describeError(check.error));
      if (process.env.NODE_ENV === "development") {
        console.info("[TeamAccess diagnostics] Final provider membership status", check.status);
      }
    });
    return () => {
      active = false;
    };
  }, [user, membershipRetry]);

  const retry = useCallback(() => {
    if (authStatus === "error") {
      setAuthStatus("signing-in");
      setError(null);
      void ensureAuthenticatedUser().catch((signInError: unknown) => {
        setAuthStatus("error");
        setError(describeError(signInError));
      });
      return;
    }
    setMembershipRetry((current) => current + 1);
  }, [authStatus]);

  const hasCurrentMembership = isMembershipForUser(user?.uid ?? null, membershipUid);
  const currentMembership = hasCurrentMembership ? membership : null;
  const currentMembershipStatus = hasCurrentMembership ? membershipStatus : "checking";

  const value = useMemo<TeamAccess>(() => ({
    authStatus,
    membershipStatus: currentMembershipStatus,
    user,
    membership: currentMembership,
    isAdmin: isAdminMembership(currentMembership),
    error,
    diagnostics,
    retry,
  }), [authStatus, currentMembership, currentMembershipStatus, diagnostics, error, retry, user]);

  let content;
  if (authStatus === "initializing") {
    content = <AccessStatus title="Initializing authentication" message="Restoring your secure team session…" />;
  } else if (authStatus === "signing-in") {
    content = <AccessStatus title="Signing in" message="Preparing your private team workspace…" />;
  } else if (authStatus === "error") {
    content = (
      <AccessStatus
        title="Authentication unavailable"
        message="CreatorOS could not authenticate this session. Check your connection and try again."
        error={error}
        action={retry}
        actionLabel="Retry"
      />
    );
  } else if (currentMembershipStatus === "checking") {
    content = <AccessStatus title="Checking team membership" message="Verifying access to the shared workspace…" />;
  } else if (currentMembershipStatus === "error") {
    content = (
      <AccessStatus
        title="Could not verify team access"
        message="Membership verification failed. Your workspace remains locked until access can be verified."
        error={error}
        action={retry}
        actionLabel="Retry"
      />
    );
  } else if (currentMembershipStatus === "pending") {
    content = user
      ? <PendingAccess uid={user.uid} onRetry={retry} diagnostics={diagnostics} status={currentMembershipStatus} />
      : null;
  } else {
    content = children;
  }

  return <TeamAccessContext.Provider value={value}>{content}</TeamAccessContext.Provider>;
}
