// Client session state. The API key is exchanged once for an HttpOnly
// cookie; after that the browser never holds the secret. All /console/api
// calls ride the cookie.

export type SessionState =
  | { state: "loading" }
  | { state: "signed-out" }
  | { state: "signed-in"; keyName: string };

let current = $state<SessionState>({ state: "loading" });

export const session = {
  get state() {
    return current;
  },
  set(value: SessionState) {
    current = value;
  }
};

let inFlight: Promise<void> | null = null;

export async function loadSession(): Promise<void> {
  if (current.state === "signed-in") return;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const res = await fetch("/console/api/me", { credentials: "same-origin" });
      if (res.ok) {
        const me = await res.json();
        current = { state: "signed-in", keyName: me.key?.name ?? "API key" };
      } else {
        current = { state: "signed-out" };
      }
    } catch {
      current = { state: "signed-out" };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function signOutLocal() {
  current = { state: "signed-out" };
}
