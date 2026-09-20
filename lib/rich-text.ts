/**
 * Inline text formatting for message bodies.
 *
 * Pure and separate from the UI, for the same reason `mentions.ts` is: the boundary rules are the
 * whole difficulty, and getting them wrong is visible to users. `*bold*` typed as arithmetic
 * (`2 * 3 * 4`) must not turn into emphasis, and a style must not swallow the link that follows it.
 *
 * The marker set follows the apps this imitates:
 *
 *   *bold*  _italic_  ~strikethrough~  ```monospace```
 *
 * Rules that matter, and why:
 *
 * - A marker only opens when the next character is not whitespace, and only closes when the
 *   character before it is not whitespace. Without both, "2 * 3 * 4" and "snake_case_name" would
 *   style themselves.
 * - A marker never spans a newline. A stray `*` on one line cannot reach across the message.
 * - Links win over styles at the same position, so `https://a.com/a*b` stays one link instead of
 *   becoming emphasis. Styles that *contain* a link still work, because the inner text is parsed
 *   again with that style removed.
 * - Parsing is a tree, so styles can nest. The same style does not nest inside itself, which is
 *   what stops `**a**` recursing forever.
 *
 * Trailing punctuation is not part of a link: "see https://a.com/x." ends with a full stop, not a
 * path segment, and the full stop is rendered as ordinary text.
 */

export type RichStyle = "bold" | "italic" | "strike" | "mono";

export type RichNode =
  | { kind: "text"; text: string }
  | { kind: RichStyle; children: RichNode[] }
  | { kind: "link"; text: string; href: string };

/** The wrapper each style is typed with. `mono` is the only multi-character marker. */
const STYLE_MARKERS: Record<RichStyle, string> = {
  bold: "*",
  italic: "_",
  strike: "~",
  mono: "```",
};

const ALL_STYLES: RichStyle[] = ["bold", "italic", "strike", "mono"];

/**
 * A URL, stopping before anything that is more likely to be sentence punctuation than the address
 * itself. Brackets and quotes are excluded so a link inside "(see https://a.com/x)" ends cleanly.
 */
const LINK_PATTERN = String.raw`(?:https?:\/\/|www\.)[^\s<>\[\]{}"']+`;

/**
 * A style may not open straight after a letter or digit.
 *
 * Without this, ordinary text styles itself: `snake_case_name` would italicise "case", and
 * `2*3*4` would embolden the 3. Both are far more common in real messages than the deliberate
 * `word*bold*`. Backticks are exempt - triple backticks do not occur in prose by accident.
 *
 * The guard is deliberately on the opening marker only. Guarding the closing marker too would stop
 * `*bold*text` styling at all, and the cases that need protecting (`2*3*4`, `snake_case_name`) are
 * already blocked by the opening side.
 */
const NOT_AFTER_WORD = String.raw`(?<![A-Za-z0-9])`;

/**
 * One pattern per style. The lookarounds carry the "not next to whitespace" rule; `[^*\n]+?` keeps
 * the body non-empty and on one line. Backticks are written as `\x60` because the marker is a bare
 * backtick and staying out of template-literal syntax keeps the pattern readable.
 */
const STYLE_PATTERNS: Record<RichStyle, string> = {
  bold: String.raw`${NOT_AFTER_WORD}\*(?!\s)([^*\n]+?)(?<!\s)\*`,
  italic: String.raw`${NOT_AFTER_WORD}_(?!\s)([^_\n]+?)(?<!\s)_`,
  strike: String.raw`${NOT_AFTER_WORD}~(?!\s)([^~\n]+?)(?<!\s)~`,
  mono: String.raw`\x60{3}(?!\s)([^\x60\n]+?)(?<!\s)\x60{3}`,
};

/** Rebuilt per parse because the set of styles shrinks as the parser recurses. */
function buildMatcher(styles: RichStyle[]): RegExp {
  const alternatives = [`(?<link>${LINK_PATTERN})`, ...styles.map((style) => `(?<${style}>${STYLE_PATTERNS[style]})`)];
  return new RegExp(alternatives.join("|"), "g");
}

/**
 * Splits a matched URL from the punctuation that followed it.
 *
 * `visible` is what the reader sees; the characters left over are returned implicitly by the
 * caller, which resumes scanning from `visible.length` rather than from the end of the match.
 */
function splitLink(raw: string): { visible: string; href: string } | null {
  let end = raw.length;

  // Sentence punctuation the URL pattern could not know about.
  while (end > 0 && /[.,;:!?]/.test(raw[end - 1])) end -= 1;

  // A closing bracket only belongs to the address if it has an opening one to match.
  while (end > 0 && raw[end - 1] === ")") {
    const head = raw.slice(0, end);
    const opens = (head.match(/\(/g) ?? []).length;
    const closes = (head.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    end -= 1;
  }

  const visible = raw.slice(0, end);
  if (!visible) return null;

  // A bare "www." host is still a link, but it needs a scheme to be openable.
  const href = visible.startsWith("www.") ? `https://${visible}` : visible;
  return { visible, href };
}

function parse(text: string, styles: RichStyle[]): RichNode[] {
  if (!text) return [];

  const matcher = buildMatcher(styles);
  const nodes: RichNode[] = [];
  let consumed = 0;
  let match: RegExpExecArray | null;

  while ((match = matcher.exec(text)) !== null) {
    // A zero-length match would spin forever; the patterns cannot produce one, but the guard keeps
    // that a property of this loop rather than of the regexes.
    if (match[0].length === 0) {
      matcher.lastIndex += 1;
      continue;
    }

    if (match.index > consumed) nodes.push({ kind: "text", text: text.slice(consumed, match.index) });

    const groups = match.groups ?? {};
    const style = styles.find((candidate) => groups[candidate] !== undefined);

    if (style) {
      const marker = STYLE_MARKERS[style];
      const inner = match[0].slice(marker.length, match[0].length - marker.length);
      nodes.push({
        kind: style,
        // The same style is withheld from the inner parse: `**a**` would otherwise recurse for ever.
        children: parse(inner, styles.filter((candidate) => candidate !== style)),
      });
      consumed = match.index + match[0].length;
      continue;
    }

    const link = splitLink(match[0]);
    if (!link) {
      // Nothing usable (for example a match that was only punctuation), so treat it as plain text.
      nodes.push({ kind: "text", text: match[0] });
      consumed = match.index + match[0].length;
      continue;
    }

    nodes.push({ kind: "link", text: link.visible, href: link.href });
    // Stop short of the trimmed punctuation so it falls through as ordinary text.
    consumed = match.index + link.visible.length;
    matcher.lastIndex = consumed;
  }

  if (consumed < text.length) nodes.push({ kind: "text", text: text.slice(consumed) });
  return nodes;
}

/**
 * Parses a message body into a render tree.
 *
 * Returns a single text node when there is nothing to style, so callers can render the common case
 * without walking a tree.
 */
export function parseRichText(text: string): RichNode[] {
  if (!text) return [];
  return parse(text, ALL_STYLES);
}

/**
 * True when a body contains any marker or link worth parsing.
 *
 * A cheap pre-check for the render path: most messages are prose with neither, and re-parsing them
 * on every render is wasted work.
 */
export function hasRichFormatting(text: string): boolean {
  if (!text) return false;
  if (/https?:\/\/|www\./.test(text)) return true;
  return /[*_~`]/.test(text);
}

/** The plain text of a render tree, with all markers and links resolved to what the reader sees. */
export function flattenRichText(nodes: RichNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return node.text;
      if (node.kind === "link") return node.text;
      return flattenRichText(node.children);
    })
    .join("");
}

/** The first link in a body, used to decide whether a message gets a preview card. */
export function firstLink(text: string): string | null {
  const find = (nodes: RichNode[]): string | null => {
    for (const node of nodes) {
      if (node.kind === "link") return node.href;
      if (node.kind !== "text") {
        const found = find(node.children);
        if (found) return found;
      }
    }
    return null;
  };

  return find(parseRichText(text));
}
