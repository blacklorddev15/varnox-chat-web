/**
 * What a chat actually is, and where tapping its name should go.
 *
 * This exists as its own module because getting it wrong is not a cosmetic mistake. The chat header
 * pushed to the group screen unconditionally, so opening the info for a one-to-one chat landed on a
 * screen headed "Group info" with a member list, an invite link and a "Leave group" button. From the
 * outside that reads as the app having decided your private chat is a group - and the person on the
 * other end, who was never a member, was telling you they could not see any of it.
 *
 * The rule below is deliberately not "member count > 2 is a group". A two-person group is a real
 * thing, and judging by head-count would relabel it as a direct chat and hide the member list from
 * somebody who needs it. `kind` is the only thing that knows, and it is set when the conversation is
 * created.
 */

/** The fields this decision needs, kept structural so it works on server rows and client rows alike. */
type ConversationShape = {
  kind?: string | null;
  memberCount?: number | null;
  otherMember?: unknown;
};

export type ConversationInfo = {
  /** True when this is a chat between exactly two people. */
  direct: boolean;
  /** The screen the header should open. */
  route: "/chat/contact-info" | "/chat/group-info";
  /** What the header's second line says under the name. */
  subtitle: string;
};

/**
 * A conversation is a group when the server says so. A group with one member is still a group - it
 * is just one nobody was added to, and calling it a direct chat would hide that.
 */
export function describeConversation(conversation: ConversationShape): ConversationInfo {
  const direct = conversation.kind !== "group";
  return {
    direct,
    route: direct ? "/chat/contact-info" : "/chat/group-info",
    // The subtitle doubles as the tap hint, so it is the one place somebody learns what is behind
    // the header. Saying "tap for group info" on a 1:1 is how the wrong screen went unnoticed.
    subtitle: direct ? "tap for contact info" : "tap for group info",
  };
}

/**
 * A conversation whose kind says group but which has nobody else in it.
 *
 * Every message sent here is delivered to the sender and to nobody else. It is worth saying out loud
 * rather than leaving somebody to work it out from a member list that has one entry on it - this is
 * the state a chat lands in when the person being added had a privacy setting that refused, and the
 * app used to create it without a word.
 */
export function isStrandedGroup(conversation: ConversationShape): boolean {
  return conversation.kind === "group" && (conversation.memberCount ?? 0) <= 1;
}
