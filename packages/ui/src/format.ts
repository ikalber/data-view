/** Compact byte formatter used across overview panes (1.2 GB / 384 MB / 12 KB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, i);
  const rounded = value >= 100 ? Math.round(value) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded} ${units[i]}`;
}

/** "3d 4h", "5h 12m", "47m", "12s" — best-effort, no leading zeros. */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  const mins = Math.floor((s % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  if (mins > 0) return `${mins}m`;
  return `${s}s`;
}

/** Strip the long " on x86_64-…" suffix Postgres/MySQL append to version(). */
export function shortServerVersion(v: string | null | undefined): string {
  if (!v) return "—";
  const trimmed = v.split(" on ")[0]?.trim() ?? v;
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}…` : trimmed;
}
