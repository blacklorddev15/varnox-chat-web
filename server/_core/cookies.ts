import type { CookieOptions, Request } from "express";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isIpAddress(host: string) {
  // Basic IPv4 check and IPv6 presence detection.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  return host.includes(":");
}

function isSecureRequest(req: Request) {
  if (req.protocol === "https") return true;

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) return false;

  const protoList = Array.isArray(forwardedProto) ? forwardedProto : forwardedProto.split(",");

  return protoList.some((proto) => proto.trim().toLowerCase() === "https");
}

/**
 * Hosts that genuinely need one cookie shared across their subdomains.
 *
 * The previous logic derived a parent domain from any three-part hostname, so
 * "varnox-chat-web.vercel.app" produced Domain=.vercel.app. vercel.app is on the Public
 * Suffix List and browsers reject cookies scoped to a public suffix, so the session
 * cookie was silently dropped and every visitor had to sign in again on every visit.
 */
const SHARED_COOKIE_DOMAINS = ["manuspre.computer", "manus.computer"];

/**
 * Extract parent domain for cookie sharing across subdomains.
 * e.g., "3000-xxx.manuspre.computer" -> ".manuspre.computer"
 * This allows cookies set by 3000-xxx to be read by 8081-xxx
 *
 * Any other host (vercel.app, a custom domain, localhost) gets a host-only cookie.
 */
function getParentDomain(hostname: string): string | undefined {
  // Don't set domain for localhost or IP addresses
  if (LOCAL_HOSTS.has(hostname) || isIpAddress(hostname)) {
    return undefined;
  }

  const shared = SHARED_COOKIE_DOMAINS.find(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );

  // Host-only cookie for everything else: safer, and it is what actually persists.
  if (!shared) {
    return undefined;
  }

  return "." + shared;
}

export function getSessionCookieOptions(
  req: Request,
): Pick<CookieOptions, "domain" | "httpOnly" | "path" | "sameSite" | "secure"> {
  const hostname = req.hostname;
  const domain = getParentDomain(hostname);

  return {
    domain,
    httpOnly: true,
    path: "/",
    // "lax" rather than "none": the API is called same-origin from the app, and None requires
    // Secure on every browser and is refused outright by third-party cookie policies.
    sameSite: "lax",
    secure: isSecureRequest(req),
  };
}
