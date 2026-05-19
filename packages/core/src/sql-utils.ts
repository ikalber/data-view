import type { DatabaseDriver } from "./types";

/** Quote an identifier per the active driver's rules. */
export function quoteIdent(
  driver: DatabaseDriver | null | undefined,
  s: string,
): string {
  switch (driver) {
    case "mysql":
      return "`" + s.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "postgres":
    default:
      return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)
        ? s
        : `"${s.replace(/"/g, '""')}"`;
  }
}

/** Always-quoted variant — used when ambiguity matters (e.g. in dumps). */
export function quoteIdentStrict(
  driver: DatabaseDriver | null | undefined,
  s: string,
): string {
  switch (driver) {
    case "mysql":
      return "`" + s.replace(/`/g, "``") + "`";
    case "mssql":
      return "[" + s.replace(/]/g, "]]") + "]";
    case "postgres":
    default:
      return `"${s.replace(/"/g, '""')}"`;
  }
}

/** Single-quote a string literal with proper escaping. */
export function quoteString(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'";
}
