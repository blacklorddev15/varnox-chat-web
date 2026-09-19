import type { Express, Request, Response } from "express";
import { ONE_YEAR_MS, COOKIE_NAME } from "../../shared/const.js";
import { getSessionCookieOptions } from "./cookies";
import { sdk } from "./sdk";
import { getUserByOpenId, upsertUser } from "../db";
import { ENV } from "./env";

const PHONE_RE = /^\+?[1-9]\d{7,14}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const attempts = new Map<string, { count: number; resetAt: number }>();
const challenges = new Map<string, { code: string; phone: string; email: string; expiresAt: number }>();

export function normalizePhone(value: unknown) {
  const phone = String(value ?? "").replace(/[\s().-]/g, "");
  const normalized = phone.startsWith("+") ? phone.slice(1) : phone;
  if (!PHONE_RE.test(`+${normalized}`)) throw new Error("Enter a valid phone number with country code");
  return normalized;
}

export function normalizeEmail(value: unknown) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 320) throw new Error("Enter a valid email address");
  return email;
}

function checkRateLimit(key: string) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + 15 * 60 * 1000 });
    return;
  }
  if (current.count >= 5) throw new Error("Too many code requests. Try again later.");
  current.count += 1;
}

async function sendEmailCode(email: string, code: string) {
  if (!ENV.resendApiKey || !ENV.resendFrom) {
    if (ENV.isProduction) throw new Error("Email login is not configured on this server");
    console.log(`[EmailAuth] Development code for ${email}: ${code}`);
    return false;
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${ENV.resendApiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: ENV.resendFrom,
      to: [email],
      subject: "Your Varnox Chat verification code",
      text: `Your Varnox Chat verification code is ${code}. It expires in 10 minutes.`,
      html: `<p>Your Varnox Chat verification code is:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes.</p>`,
    }),
  });
  if (!response.ok) throw new Error("The email provider rejected the message");
  return true;
}

export async function verifyResendCredentials() {
  if (!ENV.resendApiKey) throw new Error("RESEND_API_KEY is not configured");
  const response = await fetch("https://api.resend.com/domains?limit=1", {
    headers: { Authorization: `Bearer ${ENV.resendApiKey}` },
  });
  if (!response.ok) throw new Error(`Resend credentials rejected (${response.status})`);
  return true;
}

function userResponse(user: any) {
  return {
    id: user.id,
    openId: user.openId,
    name: user.name,
    email: user.email,
    loginMethod: user.loginMethod,
    role: user.role,
    moderationStatus: user.moderationStatus,
    suspendedUntil: user.suspendedUntil?.toISOString() ?? null,
    moderationReason: user.moderationReason,
    lastSignedIn: (user.lastSignedIn ?? new Date()).toISOString(),
  };
}

export function registerPhoneAuthRoutes(app: Express) {
  app.post("/api/auth/phone/start", async (req: Request, res: Response) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      const email = normalizeEmail(req.body?.email);
      checkRateLimit(`${phone}:${email}`);
      const requestId = `email-${crypto.randomUUID()}`;
      const code = String(Math.floor(100000 + Math.random() * 900000));
      challenges.set(requestId, { code, phone, email, expiresAt: Date.now() + 10 * 60 * 1000 });
      const delivered = await sendEmailCode(email, code);
      res.json({
        requestId,
        phoneMasked: `••••••${phone.slice(-4)}`,
        emailMasked: email.replace(/^(.{2}).*(@.*)$/, "$1••••$2"),
        devCode: delivered ? undefined : code,
        developmentMode: !delivered,
      });
    } catch (error) {
      console.error("[EmailAuth] Start failed", error);
      res.status(400).json({ error: error instanceof Error ? error.message : "Could not send verification code" });
    }
  });

  app.post("/api/auth/phone/check", async (req: Request, res: Response) => {
    try {
      const phone = normalizePhone(req.body?.phone);
      const email = normalizeEmail(req.body?.email);
      const requestId = String(req.body?.requestId ?? "");
      const code = String(req.body?.code ?? "").replace(/\D/g, "");
      if (!requestId || code.length < 4 || code.length > 10) throw new Error("Enter the verification code");
      const challenge = challenges.get(requestId);
      if (!challenge || challenge.expiresAt < Date.now() || challenge.code !== code || challenge.phone !== phone || challenge.email !== email) {
        throw new Error("The verification code is invalid");
      }
      challenges.delete(requestId);

      const openId = `phone:${phone}`;
      const lastSignedIn = new Date();
      await upsertUser({ openId, name: phone, email, loginMethod: "email-phone", lastSignedIn });
      const user = await getUserByOpenId(openId);
      if (!user) throw new Error("Account storage is not available yet");
      if (user.moderationStatus === "banned") throw new Error(`This Varnox account is banned${user.moderationReason ? `: ${user.moderationReason}` : "."}`);
      if (user.moderationStatus === "suspended" && (!user.suspendedUntil || user.suspendedUntil > new Date())) throw new Error(`This Varnox account is suspended${user.suspendedUntil ? ` until ${user.suspendedUntil.toLocaleString()}` : ""}${user.moderationReason ? `: ${user.moderationReason}` : "."}`);
      const sessionToken = await sdk.createSessionToken(openId, { name: phone, expiresInMs: ONE_YEAR_MS });
      const cookieOptions = getSessionCookieOptions(req);
      res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
      res.json({ app_session_id: sessionToken, user: userResponse(user) });
    } catch (error) {
      console.error("[EmailAuth] Check failed", error);
      res.status(400).json({ error: error instanceof Error ? error.message : "The verification code is invalid" });
    }
  });
}
