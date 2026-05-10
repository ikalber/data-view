import type { DatabaseDriver } from "@data-view/core";
import { postgresDriver } from "./postgres";
import { mysqlDriver } from "./mysql";
import { mssqlDriver } from "./mssql";
import type { DriverAdapter } from "./types";

export function getAdapter(driver: DatabaseDriver): DriverAdapter {
  switch (driver) {
    case "postgres":
      return postgresDriver;
    case "mysql":
      return mysqlDriver;
    case "mssql":
      return mssqlDriver;
  }
}
