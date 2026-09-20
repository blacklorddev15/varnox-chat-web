import { describe, expect, it } from "vitest";
import { OWNER_USERNAMES, isOwnerAccount, isOwnerUsername, normalizeAccountUsername } from "../shared/owners";

describe("moderation owners", () => {
  it("lists exactly the two accounts that may moderate", () => {
    expect(OWNER_USERNAMES).toEqual(["blacklorddev", "blacklorddev15"]);
  });

  it("matches the owner accounts whatever case or leading @ they arrive in", () => {
    // The forms somebody would actually type when checking whether their own account qualifies.
    expect(isOwnerUsername("blacklorddev")).toBe(true);
    expect(isOwnerUsername("BlackLordDev")).toBe(true);
    expect(isOwnerUsername("  blacklorddev  ")).toBe(true);
    expect(isOwnerUsername("@blacklorddev")).toBe(true);
    expect(isOwnerUsername("blacklorddev15")).toBe(true);
    expect(isOwnerUsername("@BlackLordDev15")).toBe(true);
  });

  it("does not treat a lookalike as an owner", () => {
    // Near misses matter here: a prefix or a space-separated variant must not pass.
    expect(isOwnerUsername("blacklorddev1")).toBe(false);
    expect(isOwnerUsername("blacklorddev155")).toBe(false);
    expect(isOwnerUsername("blacklorddev 15")).toBe(false);
    expect(isOwnerUsername("notblacklorddev")).toBe(false);
    expect(isOwnerUsername("blacklord")).toBe(false);
  });

  it("treats a missing or blank username as nobody", () => {
    expect(isOwnerUsername(null)).toBe(false);
    expect(isOwnerUsername(undefined)).toBe(false);
    expect(isOwnerUsername("")).toBe(false);
    expect(isOwnerUsername("   ")).toBe(false);
    expect(isOwnerUsername("@")).toBe(false);
  });

  it("normalizes the way usernames are stored", () => {
    expect(normalizeAccountUsername("  @BlackLordDev ")).toBe("blacklorddev");
    expect(normalizeAccountUsername(null)).toBe("");
  });

  it("decides on the name, not on the role", () => {
    // The role must not be able to veto an owner. It is set alongside the name, and requiring it
    // here too would mean an owner whose role had drifted saw no console and no reason for it.
    //
    // These go through a variable because a real caller holds the whole session user - role, id,
    // email and all - and only the name is meant to be read. A literal would be rejected for
    // carrying fields the parameter does not name, which is not the thing under test.
    const ownsAsAdmin = { role: "admin", username: "blacklorddev", id: 1 };
    const ownsWithoutRole = { username: "blacklorddev15" };
    const ownsAsPlainUser = { role: "user", username: "blacklorddev" };
    const roleButNoName = { role: "admin", username: "someoneelse" };

    expect(isOwnerAccount(ownsAsAdmin)).toBe(true);
    expect(isOwnerAccount(ownsWithoutRole)).toBe(true);
    expect(isOwnerAccount(ownsAsPlainUser)).toBe(true);
    // And a role on its own grants nothing: this is the account a stray promotion produces.
    //
    // A bare `{ role: "admin" }` is not asserted separately - the parameter does not name `role`, so
    // such an object does not typecheck at all, which is a stronger statement than a false return.
    expect(isOwnerAccount(roleButNoName)).toBe(false);
  });

  it("does not treat an anonymous session as an owner", () => {
    expect(isOwnerAccount(null)).toBe(false);
    expect(isOwnerAccount(undefined)).toBe(false);
    expect(isOwnerAccount({})).toBe(false);
    expect(isOwnerAccount({ username: null })).toBe(false);
  });
});
