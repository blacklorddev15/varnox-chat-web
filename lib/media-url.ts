import { getApiBaseUrl } from "@/constants/oauth";

/**
 * Turns a stored media path (for example `/api/media/12`) into something <Image> can load.
 * Absolute, file: and blob: URLs are passed through untouched, which is what the web picker
 * hands back before an upload.
 */
export function resolveMediaUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("http") || url.startsWith("file:") || url.startsWith("blob:")) return url;
  return `${getApiBaseUrl()}${url}`;
}

/**
 * Profile photo for a user. Returns undefined when they have never set one, so callers can
 * fall back to initials. `avatarUpdatedAt` is part of the URL so a new photo is not masked by
 * a cached response.
 */
export function avatarUrl(userId: number, avatarUpdatedAt?: string | Date | null): string | undefined {
  if (!avatarUpdatedAt) return undefined;
  const stamp = typeof avatarUpdatedAt === "string" ? avatarUpdatedAt : avatarUpdatedAt.toISOString();
  return resolveMediaUrl(`/api/avatar/${userId}?v=${encodeURIComponent(stamp)}`);
}

/** "3h", "2d" - the short stamps the updates list shows. */
export function shortTime(value?: string | Date | null): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
