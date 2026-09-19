import { describe, expect, it } from "vitest";
import { normalizeEmail, normalizePhone } from "../server/_core/phoneAuth";
import { normalizeUsername, validatePassword } from "../server/_core/passwordAuth";

describe("phone authentication", () => {
  it("normalizes common formatted international numbers", () => {
    expect(normalizePhone("+1 (555) 123-4567")).toBe("15551234567");
    expect(normalizePhone("447700900000")).toBe("447700900000");
  });

  it("rejects numbers without a valid country-coded length", () => {
    expect(() => normalizePhone("5551234")).toThrow();
    expect(() => normalizePhone("abc")).toThrow();
  });

  it("normalizes and validates email addresses", () => {
    expect(normalizeEmail("  Alex@Example.COM ")).toBe("alex@example.com");
    expect(() => normalizeEmail("not-an-email")).toThrow();
  });

  it("normalizes usernames and enforces password length", () => {
    expect(normalizeUsername("  BlackLordDev  ")).toBe("blacklorddev");
    expect(() => normalizeUsername("bad name")).toThrow();
    expect(validatePassword("TestPass123")).toBe("TestPass123");
    expect(() => validatePassword("short")).toThrow();
  });
});
