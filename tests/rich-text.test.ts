import { describe, expect, it } from "vitest";

import { firstLink, flattenRichText, hasRichFormatting, parseRichText, type RichNode } from "../lib/rich-text";

/** Shorthand for the leaf node, so the expectations below read like the input text. */
const text = (value: string): RichNode => ({ kind: "text", text: value });

describe("rich text parsing", () => {
  describe("plain text", () => {
    it("returns a single text node when there is nothing to style", () => {
      expect(parseRichText("Just a message")).toEqual([text("Just a message")]);
    });

    it("returns nothing for an empty body", () => {
      expect(parseRichText("")).toEqual([]);
    });

    it("keeps an unterminated marker literal", () => {
      expect(parseRichText("*bold")).toEqual([text("*bold")]);
      expect(parseRichText("done_")).toEqual([text("done_")]);
    });
  });

  describe("styles", () => {
    it("parses each marker", () => {
      expect(parseRichText("*bold*")).toEqual([{ kind: "bold", children: [text("bold")] }]);
      expect(parseRichText("_italic_")).toEqual([{ kind: "italic", children: [text("italic")] }]);
      expect(parseRichText("~struck~")).toEqual([{ kind: "strike", children: [text("struck")] }]);
      expect(parseRichText("```mono```")).toEqual([{ kind: "mono", children: [text("mono")] }]);
    });

    it("leaves the surrounding text alone", () => {
      expect(parseRichText("this is *important* today")).toEqual([
        text("this is "),
        { kind: "bold", children: [text("important")] },
        text(" today"),
      ]);
    });

    it("styles a multi-word body", () => {
      expect(parseRichText("*two words*")).toEqual([{ kind: "bold", children: [text("two words")] }]);
    });

    it("does not span a newline", () => {
      expect(parseRichText("*bold\ntext*")).toEqual([text("*bold\ntext*")]);
    });

    it("does not style a marker that sits against whitespace", () => {
      // WhatsApp's rule: the marker must hug the text on both sides.
      expect(parseRichText("* bold*")).toEqual([text("* bold*")]);
      expect(parseRichText("*bold *")).toEqual([text("*bold *")]);
      expect(parseRichText("_ spaced _")).toEqual([text("_ spaced _")]);
    });

    it("nests a different style inside another", () => {
      expect(parseRichText("*bold _and italic_*")).toEqual([
        {
          kind: "bold",
          children: [text("bold "), { kind: "italic", children: [text("and italic")] }],
        },
      ]);
    });

    it("cannot nest a style inside itself", () => {
      // The marker character is excluded from a style's own body, so the recursive parse can never
      // re-enter the same style. `**a**` is a stray marker plus a bold "a" - not nested bold.
      expect(parseRichText("**a**")).toEqual([text("*"), { kind: "bold", children: [text("a")] }, text("*")]);
    });

    it("styles the first pair it finds and leaves the rest literal", () => {
      expect(parseRichText("*a*b*c*")).toEqual([{ kind: "bold", children: [text("a")] }, text("b*c*")]);
    });
  });

  describe("false positives the boundary rules exist to stop", () => {
    it("leaves arithmetic alone", () => {
      expect(parseRichText("2 * 3 * 4")).toEqual([text("2 * 3 * 4")]);
      expect(parseRichText("2*3*4")).toEqual([text("2*3*4")]);
    });

    it("leaves snake_case identifiers alone", () => {
      expect(parseRichText("snake_case_name")).toEqual([text("snake_case_name")]);
      expect(parseRichText("use get_user_id here")).toEqual([text("use get_user_id here")]);
    });

    it("leaves a style glued to a word alone", () => {
      expect(parseRichText("a*bold*b")).toEqual([text("a*bold*b")]);
    });
  });

  describe("links", () => {
    it("parses a bare url", () => {
      expect(parseRichText("https://a.com/x")).toEqual([
        { kind: "link", text: "https://a.com/x", href: "https://a.com/x" },
      ]);
    });

    it("gives a www host a scheme to open with", () => {
      expect(parseRichText("www.example.com")).toEqual([
        { kind: "link", text: "www.example.com", href: "https://www.example.com" },
      ]);
    });

    it("leaves trailing sentence punctuation out of the link", () => {
      expect(parseRichText("see https://a.com/x.")).toEqual([
        text("see "),
        { kind: "link", text: "https://a.com/x", href: "https://a.com/x" },
        text("."),
      ]);
    });

    it("keeps a balanced bracket but drops an unmatched one", () => {
      expect(parseRichText("https://en.wikipedia.org/wiki/Foo_(bar)").at(-1)).toEqual({
        kind: "link",
        text: "https://en.wikipedia.org/wiki/Foo_(bar)",
        href: "https://en.wikipedia.org/wiki/Foo_(bar)",
      });
      expect(parseRichText("(see https://a.com/x)")).toEqual([
        text("(see "),
        { kind: "link", text: "https://a.com/x", href: "https://a.com/x" },
        text(")"),
      ]);
    });

    it("keeps an asterisk that belongs to the address inside the link", () => {
      // The link alternative wins at the same position, so this is one link, not emphasis.
      expect(parseRichText("https://a.com/a*b")).toEqual([
        { kind: "link", text: "https://a.com/a*b", href: "https://a.com/a*b" },
      ]);
    });

    it("parses a link nested inside a style", () => {
      expect(parseRichText("*see https://a.com*")).toEqual([
        {
          kind: "bold",
          children: [text("see "), { kind: "link", text: "https://a.com", href: "https://a.com" }],
        },
      ]);
    });
  });

  describe("helpers", () => {
    it("flattens a tree back to the text a reader sees", () => {
      expect(flattenRichText(parseRichText("this is *bold* and _italic_"))).toBe("this is bold and italic");
      expect(flattenRichText(parseRichText("see https://a.com/x."))).toBe("see https://a.com/x.");
    });

    it("finds the first link, including one inside a style", () => {
      expect(firstLink("no links here")).toBeNull();
      expect(firstLink("go to www.a.com now")).toBe("https://www.a.com");
      expect(firstLink("*see https://a.com*")).toBe("https://a.com");
    });

    it("detects when a body is worth parsing", () => {
      expect(hasRichFormatting("plain prose")).toBe(false);
      expect(hasRichFormatting("")).toBe(false);
      expect(hasRichFormatting("has *a* marker")).toBe(true);
      expect(hasRichFormatting("has a link https://a.com")).toBe(true);
    });
  });
});
