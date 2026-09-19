import { describe, expect, it } from "vitest";
import { verifyResendCredentials } from "../server/_core/phoneAuth";

// This calls Resend's live API, so it can only pass where credentials exist. Skipping when the key
// is absent keeps `pnpm test` meaningful locally and in CI instead of reporting a failure that says
// nothing about the code.
const hasCredentials = Boolean(process.env.RESEND_API_KEY);

describe.skipIf(!hasCredentials)("Resend credentials", () => {
  it("are accepted by the Resend domains endpoint", async () => {
    await expect(verifyResendCredentials()).resolves.toBe(true);
  }, 15_000);
});
