const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Short relative time ("just now", "5 min ago", "3 h ago", "2 days ago", or a date). */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const diff = now - time;
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} h ago`;
  if (diff < 7 * DAY) {
    const days = Math.floor(diff / DAY);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  return new Date(time).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatAbsolute(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Unicode code points (emoji count as one), matching the server's title rule. */
export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
