/**
 * The accounts that may moderate.
 *
 * Moderation used to be "anybody whose role is admin", which is a grant that can be handed out by
 * accident - a role flipped in the database, a seeded test account, the owner column set to the
 * wrong openId - and every one of those quietly produced somebody who could suspend a person, a
 * channel, or a group. The permission is really about who, not what role, so it is written down
 * here as names rather than inferred from a column.
 *
 * Two accounts are listed. Both are the same person's.
 *
 * This lives in `shared/` because it has to hold on both sides and for the same reason: the server
 * uses it to refuse the action, the app uses it to not offer a console that would only be refused.
 * A client-only check would be decoration - the names are in a bundle anybody can read - so every
 * use of it here is paired with the same check on the server.
 */
export const OWNER_USERNAMES: readonly string[] = ["blacklorddev", "blacklorddev15"];

/**
 * Usernames are compared the way they are stored, not the way they are typed.
 *
 * Sign-in already normalises to lower case and trims, and people preface their own handle with an
 * @ when they write it down, so a literal comparison would fail on `@BlackLordDev` - which is
 * exactly the form somebody would paste in when checking whether their own account is the one that
 * qualifies.
 */
export function normalizeAccountUsername(username: string | null | undefined): string {
  return (username ?? "").trim().replace(/^@/, "").toLowerCase();
}

/** Whether this username is one of the accounts allowed to moderate. */
export function isOwnerUsername(username: string | null | undefined): boolean {
  const normalized = normalizeAccountUsername(username);
  return normalized.length > 0 && OWNER_USERNAMES.includes(normalized);
}

/**
 * Whether this signed-in account may moderate, and so whether the console is theirs to see.
 *
 * The name alone decides. The two accounts are also promoted to the admin role on sign-in (see
 * `upsertUser`), but requiring that role here as well would make the permission depend on a derived
 * value that can drift away from the name - and it would fail quietly, leaving an owner with no
 * console and no reason why. The role is a consequence of being an owner, not a second lock on it.
 *
 * Takes a loose shape because callers hold the session user in more than one form, and none of them
 * guarantee these fields.
 */
export function isOwnerAccount(user: { username?: string | null } | null | undefined): boolean {
  return isOwnerUsername(user?.username);
}
