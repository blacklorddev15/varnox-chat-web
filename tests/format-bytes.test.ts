import { describe, expect, it } from "vitest";

import { formatBytes } from "../lib/format-bytes";

describe("formatBytes", () => {
  it("reads zero and nonsense as no size rather than a negative or NaN one", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });

  it("keeps bytes whole", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("switches to the next unit exactly at the boundary", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(1024 * 1024 * 1024 * 1024)).toBe("1.0 TB");
  });

  it("uses binary units, so 1500 bytes is 1.5 KB rather than 1.5 decimal-ish", () => {
    expect(formatBytes(1500)).toBe("1.5 KB");
  });

  it("does not run past the largest unit", () => {
    // Five terabytes and beyond stays in TB rather than inventing a unit.
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
  });
});
