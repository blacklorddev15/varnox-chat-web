import { describe, expect, it } from "vitest";

import { decodeEntities, isPrivateAddress } from "../server/linkPreview";

/**
 * The address guard is the security boundary for link previews: it is the only thing standing
 * between a user-supplied URL and the server's own network position. It is pure, so it is tested
 * directly rather than through a fetch that would need a network.
 */
describe("link preview address guard", () => {
  describe("refuses addresses that are not publicly routable", () => {
    it("refuses loopback", () => {
      expect(isPrivateAddress("127.0.0.1")).toBe(true);
      expect(isPrivateAddress("127.1.2.3")).toBe(true);
      expect(isPrivateAddress("::1")).toBe(true);
    });

    it("refuses the private ranges", () => {
      expect(isPrivateAddress("10.0.0.1")).toBe(true);
      expect(isPrivateAddress("10.255.255.254")).toBe(true);
      expect(isPrivateAddress("172.16.0.1")).toBe(true);
      expect(isPrivateAddress("172.31.255.1")).toBe(true);
      expect(isPrivateAddress("192.168.1.1")).toBe(true);
    });

    it("refuses cloud metadata, which is the address this guard mainly exists for", () => {
      // Both the link-local form and the IPv6-mapped form are used by real cloud providers.
      expect(isPrivateAddress("169.254.169.254")).toBe(true);
      expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
    });

    it("refuses unspecified, multicast and reserved space", () => {
      expect(isPrivateAddress("0.0.0.0")).toBe(true);
      expect(isPrivateAddress("224.0.0.1")).toBe(true);
      expect(isPrivateAddress("::")).toBe(true);
    });

    it("refuses IPv6 unique-local and link-local", () => {
      expect(isPrivateAddress("fd00::1")).toBe(true);
      expect(isPrivateAddress("fc00::1")).toBe(true);
      expect(isPrivateAddress("fe80::1")).toBe(true);
    });

    it("refuses carrier-grade NAT", () => {
      expect(isPrivateAddress("100.64.0.1")).toBe(true);
    });

    it("treats anything unparseable as unsafe", () => {
      expect(isPrivateAddress("not-an-address")).toBe(true);
      expect(isPrivateAddress("")).toBe(true);
    });
  });

  describe("allows ordinary public addresses", () => {
    it("allows public IPv4", () => {
      expect(isPrivateAddress("8.8.8.8")).toBe(false);
      expect(isPrivateAddress("1.1.1.1")).toBe(false);
      expect(isPrivateAddress("93.184.216.34")).toBe(false);
    });

    it("allows public IPv6", () => {
      expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
      expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
    });

    it("does not confuse a public address just outside a private range", () => {
      // 172.15 and 172.32 are public; only 172.16-172.31 is private.
      expect(isPrivateAddress("172.15.0.1")).toBe(false);
      expect(isPrivateAddress("172.32.0.1")).toBe(false);
      // 100.63 and 100.128 are outside the carrier-grade NAT block.
      expect(isPrivateAddress("100.63.0.1")).toBe(false);
      expect(isPrivateAddress("100.128.0.1")).toBe(false);
      // 169.253 and 169.255 are public; only 169.254 is link-local.
      expect(isPrivateAddress("169.253.0.1")).toBe(false);
      expect(isPrivateAddress("169.255.0.1")).toBe(false);
    });
  });
});

describe("link preview entity decoding", () => {
  it("decodes the named entities that appear in titles", () => {
    expect(decodeEntities("Rock &amp; Roll")).toBe("Rock & Roll");
    expect(decodeEntities("a &lt;b&gt; c")).toBe("a <b> c");
    expect(decodeEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeEntities("it&#39;s")).toBe("it's");
    expect(decodeEntities("a&nbsp;b")).toBe("a b");
  });

  it("decodes numeric entities in both bases", () => {
    expect(decodeEntities("caf&#233;")).toBe("café");
    expect(decodeEntities("caf&#xE9;")).toBe("café");
  });

  it("leaves an unknown entity and a bare ampersand alone", () => {
    expect(decodeEntities("&notarealentity;")).toBe("&notarealentity;");
    expect(decodeEntities("Tom & Jerry")).toBe("Tom & Jerry");
  });
});
