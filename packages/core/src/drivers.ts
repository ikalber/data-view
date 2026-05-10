import type { DatabaseDriver } from "./types";

export function defaultPort(driver: DatabaseDriver): number {
  switch (driver) {
    case "postgres":
      return 5432;
    case "mysql":
      return 3306;
    case "mssql":
      return 1433;
  }
}

export function driverLabel(driver: DatabaseDriver): string {
  switch (driver) {
    case "postgres":
      return "PostgreSQL";
    case "mysql":
      return "MySQL / MariaDB";
    case "mssql":
      return "SQL Server";
  }
}
