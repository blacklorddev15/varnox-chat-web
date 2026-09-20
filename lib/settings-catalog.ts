/**
 * The single list of what Settings contains.
 *
 * Both the Settings screen and its search read from here, so an entry cannot exist in one and be
 * invisible to the other - which is what a search box over a hand-written second list would give
 * you the moment somebody added a row.
 *
 * `icon` is a plain string rather than the icon component's prop type on purpose: naming that type
 * would pull `@expo/vector-icons` into this module, and with it React Native, which would make the
 * search logic untestable outside a device. The screen casts when it renders.
 */

/**
 * The routes a settings entry may point at, spelled out rather than left as `string`.
 *
 * Expo Router is configured with `typedRoutes`, so navigation wants a known route. Naming them here
 * keeps this module free of the router's generated types while still compiling once those types
 * exist - and a typo in a path becomes a compile error instead of a dead row.
 */
export type SettingsRoute =
  | "/chat/profile"
  | "/verify-email"
  | "/security/two-step"
  | "/security/linked-devices"
  | "/security/change-number"
  | "/security/delete-account"
  | "/chat/settings"
  | "/chat/privacy"
  | "/chat/starred"
  | "/chat/storage"
  | "/chat/appeals"
  | "/chat/broadcasts"
  | "/chat/support"
  | "/admin";

export type SettingsTarget =
  /** A screen of its own. */
  | { kind: "route"; href: SettingsRoute }
  /** A section rendered by the generic detail screen. */
  | { kind: "section"; section: string };

export type SettingsEntry = {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  /**
   * Words a person might search for that do not appear in the title or subtitle.
   *
   * This is what makes search useful rather than literal: looking for "fingerprint" or "lock"
   * should find two-step verification even though neither word is in its name.
   */
  keywords: string;
  target: SettingsTarget;
  /** Only shown to administrators, and only findable by them. */
  adminOnly?: boolean;
};

export const SETTINGS_ENTRIES: SettingsEntry[] = [
  {
    id: "profile",
    title: "Profile",
    subtitle: "Your name, photo, about and phone number",
    icon: "person-outline",
    keywords: "avatar picture username about me edit",
    target: { kind: "route", href: "/chat/profile" },
  },
  {
    id: "verify-email",
    title: "Verify email",
    subtitle: "Protect your account and recovery access",
    icon: "verified",
    keywords: "address confirm recovery",
    target: { kind: "route", href: "/verify-email" },
  },
  {
    id: "privacy",
    title: "Privacy",
    subtitle: "Photo, about, status, who can add you to groups",
    icon: "lock-outline",
    keywords: "blocked read receipt last seen visibility who can see photo profile audience audience",
    // A screen of its own now. It used to point at the generic detail page, which rendered the same
    // two toggles as every other section and had nothing to do with privacy.
    target: { kind: "route", href: "/chat/privacy" },
  },
  {
    id: "security",
    title: "Two-step verification",
    subtitle: "Require a PIN to open this device's copy of the app",
    icon: "password",
    keywords: "pin lock passcode fingerprint biometric security",
    target: { kind: "route", href: "/security/two-step" },
  },
  {
    id: "devices",
    title: "Linked devices",
    subtitle: "See where your account is signed in, and end any of them",
    icon: "devices",
    keywords: "sessions sign out log out revoke where am i signed in",
    target: { kind: "route", href: "/security/linked-devices" },
  },
  {
    id: "change-number",
    title: "Change number",
    subtitle: "Move your account to a different phone number",
    icon: "phone-iphone",
    keywords: "phone mobile migrate new number",
    target: { kind: "route", href: "/security/change-number" },
  },
  {
    id: "delete-account",
    title: "Delete my account",
    subtitle: "Remove your account and everything in it",
    icon: "delete-forever",
    keywords: "close remove erase data permanent",
    target: { kind: "route", href: "/security/delete-account" },
  },
  {
    id: "chats",
    title: "Chats",
    subtitle: "Theme, chat history, default message timer",
    icon: "chat-bubble-outline",
    keywords: "wallpaper disappearing timer export history theme dark",
    target: { kind: "route", href: "/chat/settings" },
  },
  {
    id: "notifications",
    title: "Notifications",
    subtitle: "Messages, groups and calls",
    icon: "notifications-none",
    keywords: "alerts push sound mute",
    target: { kind: "section", section: "notifications" },
  },
  {
    id: "starred",
    title: "Starred messages",
    subtitle: "Find saved messages across chats",
    icon: "star-border",
    keywords: "saved favourite bookmarked",
    target: { kind: "route", href: "/chat/starred" },
  },
  {
    id: "storage",
    title: "Storage and data",
    subtitle: "What this account is keeping, and how much",
    icon: "folder-open",
    keywords: "media usage size space downloads network bytes",
    target: { kind: "route", href: "/chat/storage" },
  },
  {
    id: "blocked",
    title: "Blocked contacts",
    subtitle: "Manage people you have blocked",
    icon: "block",
    keywords: "blocked ban ignore",
    target: { kind: "section", section: "blocked" },
  },
  {
    id: "appeals",
    title: "Appeal history",
    subtitle: "Track account review requests",
    icon: "history",
    keywords: "ban suspended review restore",
    target: { kind: "route", href: "/chat/appeals" },
  },
  {
    id: "broadcasts",
    title: "Broadcast lists",
    subtitle: "Send one message to several people at once",
    icon: "campaign",
    keywords: "list bulk many recipients",
    target: { kind: "route", href: "/chat/broadcasts" },
  },
  {
    id: "support",
    title: "Varnox Support Bot",
    subtitle: "Get help with login, privacy, and safety",
    icon: "support-agent",
    keywords: "help contact us problem issue",
    target: { kind: "route", href: "/chat/support" },
  },
  {
    id: "admin",
    title: "Admin moderation",
    subtitle: "Bans, suspensions and abuse reports",
    icon: "admin-panel-settings",
    keywords: "ban suspend reports queue moderate",
    target: { kind: "route", href: "/admin" },
    adminOnly: true,
  },
];

/** Every entry the given viewer may see. */
export function visibleSettingsEntries(isAdmin: boolean): SettingsEntry[] {
  return SETTINGS_ENTRIES.filter((entry) => !entry.adminOnly || isAdmin);
}

/** Lower-cased haystack for one entry, built once per call rather than per keystroke. */
function haystack(entry: SettingsEntry): string {
  return `${entry.title} ${entry.subtitle} ${entry.keywords}`.toLowerCase();
}

/**
 * Filters the catalogue for a search box.
 *
 * An empty query returns everything, because a search screen that starts blank looks broken. Results
 * are ranked so a title match comes before a match that was only found through the keyword list:
 * searching "block" should offer Blocked contacts first, not Privacy.
 */
export function searchSettings(query: string, isAdmin = false): SettingsEntry[] {
  const entries = visibleSettingsEntries(isAdmin);
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return entries;

  const terms = trimmed.split(/\s+/).filter(Boolean);

  return entries
    .map((entry) => {
      const hay = haystack(entry);
      // Every term must appear somewhere: "chat theme" should not match everything about chats.
      if (!terms.every((term) => hay.includes(term))) return null;

      const title = entry.title.toLowerCase();
      // A term matching the title outright is the strongest signal.
      const titleHit = terms.some((term) => title.includes(term));
      // A prefix of the title is next best, so "notif" ranks Notifications above Privacy.
      const prefixHit = title.startsWith(terms[0]);
      const score = (titleHit ? 2 : 0) + (prefixHit ? 1 : 0);
      return { entry, score };
    })
    .filter((match): match is { entry: SettingsEntry; score: number } => match !== null)
    // Ties keep catalogue order, which is the order the Settings screen itself uses.
    .sort((a, b) => b.score - a.score)
    .map((match) => match.entry);
}
