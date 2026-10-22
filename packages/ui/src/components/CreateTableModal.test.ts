import { describe, expect, it } from "vitest";
import { resolveDataType, type DraftColumn } from "./CreateTableModal";

function draft(patch: Partial<DraftColumn>): DraftColumn {
  return {
    uid: "x",
    name: "status",
    typeChoice: "varchar",
    typeParams: [],
    customType: "",
    enumValues: [],
    nullable: true,
    primaryKey: false,
    default: null,
    ...patch,
  };
}

describe("resolveDataType", () => {
  it("fills params and suffixes from the catalog", () => {
    expect(resolveDataType(draft({ typeChoice: "varchar", typeParams: ["40"] }), "postgres")).toBe(
      "varchar(40)",
    );
    // Blank params fall back to the catalog default.
    expect(resolveDataType(draft({ typeChoice: "decimal", typeParams: ["", ""] }), "mysql")).toBe(
      "DECIMAL(10,2)",
    );
    expect(resolveDataType(draft({ typeChoice: "int_ai" }), "mysql")).toBe("INT AUTO_INCREMENT");
    expect(resolveDataType(draft({ typeChoice: "int_id" }), "mssql")).toBe("int IDENTITY(1,1)");
    expect(resolveDataType(draft({ typeChoice: "nvarchar", typeParams: ["max"] }), "mssql")).toBe(
      "nvarchar(max)",
    );
  });

  it("emits MySQL ENUM with escaped literals", () => {
    expect(
      resolveDataType(draft({ typeChoice: "__enum__", enumValues: ["a", "it's", "C:\\x"] }), "mysql"),
    ).toBe("ENUM('a', 'it''s', 'C:\\\\x')");
  });

  it("emits a CHECK constraint elsewhere", () => {
    expect(
      resolveDataType(draft({ name: " Status ", typeChoice: "__enum__", enumValues: ["a", "b"] }), "postgres"),
    ).toBe(`text CHECK ("Status" IN ('a', 'b'))`);
    expect(
      resolveDataType(draft({ typeChoice: "__enum__", enumValues: ["sí", "日本"] }), "mssql"),
    ).toBe("nvarchar(255) CHECK ([status] IN (N'sí', N'日本'))");
  });

  it("returns empty for an unusable choice", () => {
    expect(resolveDataType(draft({ typeChoice: "__enum__", enumValues: [] }), "mysql")).toBe("");
    expect(resolveDataType(draft({ typeChoice: "__custom__", customType: "  " }), "mysql")).toBe("");
  });
});
