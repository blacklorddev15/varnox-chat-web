/**
 * Link previews: fetch a URL a user typed and read its Open Graph tags.
 *
 * This is the only place in the app that makes the server fetch an address chosen by a user, so it
 * is written defensively. A naive version is a server-side request forgery hole: `http://localhost:5432`
 * or `http://169.254.169.254/` would be fetched with the server's own network position, which on a
 * cloud host is how metadata credentials get stolen.
 *
 * The defences, in order:
 *
 * 1. Only http and https. `file:`, `gopher:` and the rest are refused before anything else happens.
 * 2. The hostname is resolved first, and every address it resolves to must be public. Checking the
 *    name is not enough - `localhost` and `internal.corp` are only obvious in hindsight.
 * 3. Redirects are followed by hand, so each hop is validated the same way. Handing `redirect:
 *    "follow"` to fetch would let a public URL bounce the request to 127.0.0.1.
 * 4. The body is read with a cap and a timeout. A preview only needs the `<head>`, and an endless
 *    response should not be able to hold a request open or exhaust memory.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const FETCH_TIMEOUT_MS = 5_000;
/** Enough for a document head; anything larger is not a page we want a preview of. */
const MAX_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const MAX_TITLE = 300;
const MAX_DESCRIPTION = 500;
const MAX_IMAGE_URL = 1024;

export type LinkPreview = {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  imageUrl: string | null;
};

/**
 * True for addresses that are not reachable from the public internet, or are worth treating as if
 * they were not: loopback, link-local, and the private ranges, plus their IPv6 equivalents.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const [a, b] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local, including cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (version === 6) {
    const lower = address.toLowerCase().split("%")[0];
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique local
    if (lower.startsWith("fe80")) return true; // link-local
    // An IPv4 address written the IPv6 way must be checked as IPv4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  return true;
}

/** Throws unless the URL is http(s) and resolves only to public addresses. */
async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http and https links can be previewed");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("That address is not reachable");
    return;
  }

  let resolved: Array<{ address: string }>;
  try {
    resolved = await lookup(host, { all: true });
  } catch {
    throw new Error("That host could not be resolved");
  }

  // Every candidate must be public: a name that resolves to both a public and a private address must
  // not be usable, because which one is used is not something this code controls.
  if (resolved.length === 0 || resolved.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("That address is not reachable");
  }
}

/** Reads at most `limit` bytes, so a huge or endless response cannot exhaust memory. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";

  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value?.byteLength ?? 0;
    text += decoder.decode(value, { stream: true });
    if (received >= limit) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }

  return text;
}

/** Fetches a URL through the checks above, following redirects one validated hop at a time. */
async function safeFetch(start: URL): Promise<Response> {
  let current = start;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublicUrl(current);

    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        // Some sites serve nothing without a name, and an honest one is better than a fake browser.
        "user-agent": "VarnoxLinkPreview/1.0 (+https://varnox-chat-web.vercel.app)",
        accept: "text/html,application/xhtml+xml",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // Drain the hop's body so the socket can be reused.
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error("That link redirected nowhere");
      current = new URL(location, current);
      continue;
    }

    if (!response.ok) throw new Error(`That link answered ${response.status}`);
    return response;
  }

  throw new Error("That link redirected too many times");
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
};

/** Minimal entity decoding: enough for titles and descriptions, without pulling in a parser. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const known = ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * Reads a `<meta property="..." content="...">` value.
 *
 * The whole tag is matched before the attributes are read, because attribute order is not fixed and
 * a `content` that appears before `property` is just as valid.
 */
function metaContent(html: string, names: string[]): string | null {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*>`, "i").exec(html)?.[0];
    if (!tag) continue;
    const content = /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (content?.trim()) return content.trim();
  }
  return null;
}

function documentTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html);
  return match?.[1]?.trim() || null;
}

function clamp(value: string | null, max: number): string | null {
  if (!value) return null;
  const decoded = decodeEntities(value).replace(/\s+/g, " ").trim();
  if (!decoded) return null;
  return decoded.length > max ? `${decoded.slice(0, max - 1)}…` : decoded;
}

/**
 * Fetches and parses a preview. Returns null when the page has nothing worth showing, which the
 * caller caches as a miss so the URL is not fetched again.
 */
export async function fetchLinkPreview(rawUrl: string): Promise<LinkPreview | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("That is not a valid link");
  }

  const response = await safeFetch(url);

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("html")) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("That link is not a web page");
  }

  const html = await readCapped(response, MAX_BYTES);

  const title = clamp(metaContent(html, ["og:title", "twitter:title"]) ?? documentTitle(html), MAX_TITLE);
  const description = clamp(metaContent(html, ["og:description", "twitter:description", "description"]), MAX_DESCRIPTION);
  const siteName = clamp(metaContent(html, ["og:site_name"]), 120) ?? url.hostname;
  const rawImage = metaContent(html, ["og:image", "twitter:image"]);

  // A relative image is resolved against the page, and only kept if it is itself a safe address -
  // otherwise the client would be told to load something the server refused to fetch.
  let imageUrl: string | null = null;
  if (rawImage) {
    try {
      const resolved = new URL(decodeEntities(rawImage), url);
      if ((resolved.protocol === "http:" || resolved.protocol === "https:") && resolved.href.length <= MAX_IMAGE_URL) {
        imageUrl = resolved.href;
      }
    } catch {
      imageUrl = null;
    }
  }

  if (!title && !description && !imageUrl) return null;

  return { url: url.href, title, description, siteName, imageUrl };
}
