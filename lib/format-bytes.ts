/**
 * Human-readable sizes for the storage screen.
 *
 * Binary units (1024) rather than decimal, because that is what a device's own storage figures use
 * and seeing two different numbers for the same file is worse than being technically imprecise.
 *
 * Kept pure and separate so the boundaries are pinned by tests: "1023 B" versus "1.0 KB" is exactly
 * the sort of thing that looks fine until it is on a screen next to a different rounding.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  // A negative or absent figure means "unknown" everywhere this is used, and "0 B" is the honest
  // reading of that rather than a negative size.
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  // Bytes are whole things; anything larger gets one decimal, which is as much as a person reads.
  const rounded = unit === 0 ? String(Math.round(value)) : value.toFixed(1);
  return `${rounded} ${UNITS[unit]}`;
}
