import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { SESSION_TOKEN_KEY, USER_INFO_KEY } from "@/constants/oauth";

export type User = {
  id: number;
  openId: string;
  username?: string | null;
  name: string | null;
  email: string | null;
  emailVerifiedAt?: string | null;
  loginMethod: string | null;
  role?: "user" | "admin";
  moderationStatus?: string;
  suspendedUntil?: string | null;
  moderationReason?: string | null;
  about?: string | null;
  // Returned by auth.me (the full user row); the change-number screen shows the current one.
  phone?: string | null;
  avatarUpdatedAt?: string | null;
  lastSignedIn: Date;
};

/**
 * Browser storage for the session token.
 *
 * The web client used to discard the token the server returns at sign-in and rely purely on
 * the httpOnly cookie. Any cookie policy that drops it (a public-suffix domain, WebView cookie
 * settings, ITP, an expired session after the page was already open) then left the cached user
 * making the UI look signed in while every authenticated request failed.
 */
function webStorage(): Storage | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Auth changes have to reach every useAuth() consumer.
 *
 * Each call used to keep its own copy of the user, fetched once on mount and never refreshed.
 * After signing in, the root layout's copy was still null, so its guard saw "no user on a
 * protected route" and replaced the route straight back to /login - the screen looked as
 * though nothing had happened, and only a manual reload (which re-read the cookie) landed on
 * the hub. Sign-in, OAuth return and sign-out all publish through here instead.
 */
let currentUser: User | null = null;
const authListeners = new Set<() => void>();

export function getAuthUser(): User | null {
  return currentUser;
}

export function subscribeToAuth(listener: () => void): () => void {
  authListeners.add(listener);
  return () => {
    authListeners.delete(listener);
  };
}

function emitAuthChange(): void {
  for (const listener of Array.from(authListeners)) {
    try {
      listener();
    } catch {
      // one broken listener must not stop the others
    }
  }
}

export async function getSessionToken(): Promise<string | null> {
  try {
    const storage = webStorage();
    if (storage) {
      const stored = storage.getItem(SESSION_TOKEN_KEY);
      console.log("[Auth] Web session token:", stored ? "present" : "missing");
      return stored;
    }

    // Use SecureStore for native
    console.log("[Auth] Getting session token...");
    const token = await SecureStore.getItemAsync(SESSION_TOKEN_KEY);
    console.log(
      "[Auth] Session token retrieved from SecureStore:",
      token ? `present (${token.substring(0, 20)}...)` : "missing",
    );
    return token;
  } catch (error) {
    console.error("[Auth] Failed to get session token:", error);
    return null;
  }
}

export async function setSessionToken(token: string): Promise<void> {
  try {
    const storage = webStorage();
    if (storage) {
      storage.setItem(SESSION_TOKEN_KEY, token);
      console.log("[Auth] Web session token stored");
      emitAuthChange();
      return;
    }

    // Use SecureStore for native
    console.log("[Auth] Setting session token...", token.substring(0, 20) + "...");
    await SecureStore.setItemAsync(SESSION_TOKEN_KEY, token);
    console.log("[Auth] Session token stored in SecureStore successfully");
    emitAuthChange();
  } catch (error) {
    console.error("[Auth] Failed to set session token:", error);
    throw error;
  }
}

export async function removeSessionToken(): Promise<void> {
  try {
    const storage = webStorage();
    if (storage) {
      storage.removeItem(SESSION_TOKEN_KEY);
      console.log("[Auth] Web session token removed");
      emitAuthChange();
      return;
    }

    // Use SecureStore for native
    console.log("[Auth] Removing session token...");
    await SecureStore.deleteItemAsync(SESSION_TOKEN_KEY);
    console.log("[Auth] Session token removed from SecureStore successfully");
    emitAuthChange();
  } catch (error) {
    console.error("[Auth] Failed to remove session token:", error);
  }
}

export async function getUserInfo(): Promise<User | null> {
  try {
    console.log("[Auth] Getting user info...");

    let info: string | null = null;
    if (Platform.OS === "web") {
      // Use localStorage for web
      info = window.localStorage.getItem(USER_INFO_KEY);
    } else {
      // Use SecureStore for native
      info = await SecureStore.getItemAsync(USER_INFO_KEY);
    }

    if (!info) {
      console.log("[Auth] No user info found");
      return null;
    }
    const user = JSON.parse(info);
    console.log("[Auth] User info retrieved:", user);
    return user;
  } catch (error) {
    console.error("[Auth] Failed to get user info:", error);
    return null;
  }
}

export async function setUserInfo(user: User): Promise<void> {
  try {
    console.log("[Auth] Setting user info...", user);

    if (Platform.OS === "web") {
      // Use localStorage for web
      window.localStorage.setItem(USER_INFO_KEY, JSON.stringify(user));
      console.log("[Auth] User info stored in localStorage successfully");
      currentUser = user;
      emitAuthChange();
      return;
    }

    // Use SecureStore for native
    await SecureStore.setItemAsync(USER_INFO_KEY, JSON.stringify(user));
    console.log("[Auth] User info stored in SecureStore successfully");
    currentUser = user;
    emitAuthChange();
  } catch (error) {
    console.error("[Auth] Failed to set user info:", error);
  }
}

export async function clearUserInfo(): Promise<void> {
  try {
    if (Platform.OS === "web") {
      // Use localStorage for web
      window.localStorage.removeItem(USER_INFO_KEY);
      currentUser = null;
      emitAuthChange();
      return;
    }

    // Use SecureStore for native
    await SecureStore.deleteItemAsync(USER_INFO_KEY);
    currentUser = null;
    emitAuthChange();
  } catch (error) {
    console.error("[Auth] Failed to clear user info:", error);
  }
}
