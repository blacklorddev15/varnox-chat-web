import { describe, expect, it } from "vitest";
import { verifyResendCredentials } from "../server/_core/phoneAuth";

describe("Resend credentials", () => {
  it("are accepted by the Resend domains endpoint", async () => {
    await expect(verifyResendCredentials()).resolves.toBe(true);
  }, 15_000);
});
