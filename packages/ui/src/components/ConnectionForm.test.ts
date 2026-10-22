import { describe, expect, it } from "vitest";
import type { ConnectionInput } from "@data-view/core";
import { portAfterDriverChange, validateConnectionInput } from "./ConnectionForm";

describe("portAfterDriverChange", () => {
  it("follows the new driver's default when the port was the old default", () => {
    expect(portAfterDriverChange("postgres", "mysql", 5432)).toBe(3306);
    expect(portAfterDriverChange("mysql", "mssql", 3306)).toBe(1433);
  });

  it("keeps a custom port", () => {
    expect(portAfterDriverChange("postgres", "mysql", 15432)).toBe(15432);
  });

  it("replaces empty/invalid ports with the default", () => {
    expect(portAfterDriverChange("postgres", "mysql", 0)).toBe(3306);
    expect(portAfterDriverChange("postgres", "mysql", Number.NaN)).toBe(3306);
  });
});

describe("validateConnectionInput", () => {
  const base: ConnectionInput = {
    name: "local",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    database: "",
    username: "postgres",
  };

  it("accepts a valid input", () => {
    expect(validateConnectionInput(base)).toBeNull();
  });

  it("rejects blank name/host and out-of-range ports", () => {
    expect(validateConnectionInput({ ...base, name: "  " })).toMatch(/nombre/);
    expect(validateConnectionInput({ ...base, host: "" })).toMatch(/host/);
    expect(validateConnectionInput({ ...base, port: 0 })).toMatch(/puerto/);
    expect(validateConnectionInput({ ...base, port: 70000 })).toMatch(/puerto/);
    expect(validateConnectionInput({ ...base, port: 54.5 })).toMatch(/puerto/);
  });
});
