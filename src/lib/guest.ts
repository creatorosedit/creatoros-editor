const GUEST_ID_KEY = "creatoros-guest-id";

export function getGuestId(): string {
  if (typeof window === "undefined") {
    throw new Error("Guest identity is only available in the browser.");
  }

  const storedId = window.localStorage.getItem(GUEST_ID_KEY);
  if (storedId) return storedId;

  const guestId = crypto.randomUUID();
  window.localStorage.setItem(GUEST_ID_KEY, guestId);
  return guestId;
}
