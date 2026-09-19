/**
 * @mention parsing for group messages.
 *
 * Pure and separate from the UI so the boundary rules can be tested directly. Those rules are the
 * whole difficulty: "@Ann" must not light up inside "@Anna", and "Ann Marie" must win over "Ann".
 * Getting that wrong is not cosmetic - it decides who appears to have been mentioned.
 */

export type MentionSegment = { text: string; mention: boolean };

/** Longest first, so a two-word name is preferred over its first word. */
function orderedCandidates(names: string[]): string[] {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
}

/**
 * Splits text into plain runs and mention runs.
 *
 * Returns a single plain run when nothing matches, so callers can render the simple case cheaply.
 */
export function parseMentions(text: string, names: string[]): MentionSegment[] {
  if (!text) return [];

  const candidates = orderedCandidates(names);
  if (candidates.length === 0) return [{ text, mention: false }];

  const segments: MentionSegment[] = [];
  let plain = "";
  let index = 0;

  while (index < text.length) {
    // An "@" only opens a mention at a word boundary. Without this, "ben@Ann.com" would name Ann.
    const opensMention = text[index] === "@" && (index === 0 || !/[a-z0-9_]/i.test(text[index - 1]));
    if (!opensMention) {
      plain += text[index];
      index += 1;
      continue;
    }

    const afterAt = text.slice(index + 1).toLowerCase();
    const hit = candidates.find((name) => {
      const lower = name.toLowerCase();
      if (!afterAt.startsWith(lower)) return false;
      // A mention ends at a word boundary: "@Ann" inside "@Anna" is a different person.
      const next = afterAt.charAt(lower.length);
      return next === "" || !/[a-z0-9_]/i.test(next);
    });

    if (!hit) {
      plain += text[index];
      index += 1;
      continue;
    }

    if (plain) {
      segments.push({ text: plain, mention: false });
      plain = "";
    }
    segments.push({ text: text.slice(index, index + 1 + hit.length), mention: true });
    index += 1 + hit.length;
  }

  if (plain) segments.push({ text: plain, mention: false });
  return segments;
}

/**
 * The canonical names mentioned in a piece of text.
 *
 * Returns the caller's own spelling rather than what was typed, so "@ann" and "@Ann" both resolve
 * to the member actually named "Ann" - which is what a notification or highlight needs.
 */
export function mentionedNames(text: string, names: string[]): string[] {
  const found = parseMentions(text, names)
    .filter((segment) => segment.mention)
    .map((segment) => segment.text.slice(1));

  const canonical = new Map(names.map((name) => [name.trim().toLowerCase(), name.trim()]));
  return [...new Set(found.map((typed) => canonical.get(typed.toLowerCase()) ?? typed))];
}

/**
 * The fragment being typed after an "@", or null when the caret is not in a mention.
 *
 * Used to offer completions; only the trailing token counts, so an "@" earlier in the sentence does
 * not keep a menu open while the user keeps typing.
 */
export function mentionQuery(text: string): string | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text);
  return match ? match[1] : null;
}

/** Replaces the "@fragment" being typed with a completed mention. */
export function completeMention(text: string, name: string): string {
  return text.replace(/(^|\s)@([^\s@]*)$/, (_match, lead: string) => `${lead}@${name} `);
}
