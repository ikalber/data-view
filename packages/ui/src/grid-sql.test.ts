import { describe, expect, it } from "vitest";
import type { ColumnInfo } from "@data-view/core";
import {
  buildInsertSql,
  buildPkWhere,
  buildTablePreviewSql,
  buildUpdateSql,
  cellValueToSql,
  editValueToSql,
  emptyMeansNull,
  isBooleanType,
  isNumericType,
  parseEnumValues,
  rowPkKey,
} from "./grid-sql";

function col(
  name: string,
  dataType: string,
  extra: Partial<ColumnInfo> = {},
): ColumnInfo {
  return {
    name,
    dataType,
    nullable: true,
    isPrimaryKey: false,
    isUnique: false,
    ...extra,
  };
}

function infoMap(...cols: ColumnInfo[]): Map<string, ColumnInfo> {
  return new Map(cols.map((c) => [c.name, c]));
}

describe("isBooleanType", () => {
  it("is dialect-aware", () => {
    expect(isBooleanType("postgres", "boolean")).toBe(true);
    // Postgres bit(1) is a bit string, not a boolean.
    expect(isBooleanType("postgres", "bit(1)")).toBe(false);
    expect(isBooleanType("mysql", "tinyint(1)")).toBe(true);
    expect(isBooleanType("mysql", "bit(1)")).toBe(true);
    expect(isBooleanType("mysql", "tinyint(4)")).toBe(false);
    expect(isBooleanType("mssql", "bit")).toBe(true);
    expect(isBooleanType("mssql", "binary")).toBe(false);
  });
});

describe("isNumericType", () => {
  it("matches numeric types but not interval", () => {
    for (const t of ["integer", "int(11) unsigned", "bigint", "numeric(10,2)", "double precision", "money", "decimal"]) {
      expect(isNumericType(t)).toBe(true);
    }
    expect(isNumericType("interval")).toBe(false);
    expect(isNumericType("text")).toBe(false);
  });
});

describe("editValueToSql", () => {
  const nullableText = col("name", "text");
  const notNullText = col("name", "varchar(20)", { nullable: false });
  const notNullInt = col("qty", "integer", { nullable: false });

  it("maps empty to NULL except on NOT NULL text columns", () => {
    expect(editValueToSql("postgres", nullableText, "")).toBe("NULL");
    expect(editValueToSql("postgres", notNullText, "")).toBe("''");
    expect(editValueToSql("mssql", notNullText, "")).toBe("N''");
    // A NOT NULL integer can't take '' either — NULL gives the clearer error.
    expect(editValueToSql("postgres", notNullInt, "")).toBe("NULL");
    expect(emptyMeansNull(notNullText)).toBe(false);
    expect(emptyMeansNull(undefined)).toBe(true);
  });

  it("uses DEFAULT for an empty NOT NULL column with a default on INSERT", () => {
    const c = col("status", "integer", { nullable: false, default: "0" });
    expect(editValueToSql("postgres", c, "", "insert")).toBe("DEFAULT");
    expect(editValueToSql("postgres", c, "", "update")).toBe("NULL");
  });

  it("escapes strings per dialect", () => {
    expect(editValueToSql("postgres", nullableText, "O'Brien")).toBe("'O''Brien'");
    expect(editValueToSql("postgres", nullableText, "C:\\temp")).toBe("'C:\\temp'");
    expect(editValueToSql("mysql", nullableText, "C:\\temp")).toBe("'C:\\\\temp'");
    expect(editValueToSql("mysql", nullableText, "abc\\")).toBe("'abc\\\\'");
    expect(editValueToSql("mssql", col("n", "nvarchar"), "日本")).toBe("N'日本'");
  });

  it("emits booleans per dialect and lets the server reject junk", () => {
    expect(editValueToSql("postgres", col("b", "boolean"), "true")).toBe("TRUE");
    expect(editValueToSql("postgres", col("b", "boolean"), "f")).toBe("FALSE");
    expect(editValueToSql("mysql", col("b", "tinyint(1)"), "true")).toBe("1");
    expect(editValueToSql("mssql", col("b", "bit"), "false")).toBe("0");
    expect(editValueToSql("mssql", col("b", "bit"), "1")).toBe("1");
    expect(editValueToSql("postgres", col("b", "boolean"), "maybe")).toBe("'maybe'");
    // Postgres bit(1) is a bit string literal.
    expect(editValueToSql("postgres", col("b", "bit(1)"), "1")).toBe("'1'");
  });

  it("only passes clean numbers through unquoted", () => {
    const n = col("n", "numeric(10,2)");
    expect(editValueToSql("postgres", n, " 12.50 ")).toBe("12.50");
    expect(editValueToSql("postgres", n, "-1e3")).toBe("-1e3");
    expect(editValueToSql("postgres", n, "1; DROP TABLE x")).toBe("'1; DROP TABLE x'");
    expect(editValueToSql("postgres", col("i", "interval"), "5")).toBe("'5'");
  });

  it("quotes enum values", () => {
    expect(editValueToSql("mysql", col("e", "enum('a','b')"), "a")).toBe("'a'");
  });
});

describe("cellValueToSql (WHERE by PK)", () => {
  it("keeps the original value's type", () => {
    expect(cellValueToSql("postgres", col("id", "integer"), 42)).toBe("42");
    expect(cellValueToSql("postgres", col("id", "bigint"), "9007199254740993")).toBe(
      "9007199254740993",
    );
    // An empty-string key is a value, not NULL.
    expect(cellValueToSql("postgres", col("code", "text"), "")).toBe("''");
    expect(cellValueToSql("mssql", col("code", "nvarchar"), "x")).toBe("N'x'");
    expect(cellValueToSql("mssql", col("flag", "bit"), true)).toBe("1");
    expect(() =>
      cellValueToSql("postgres", col("k", "bytea"), { __binary: true, bytes: 4 }),
    ).toThrow(/binaria/);
  });

  it("builds a NULL-safe composite WHERE", () => {
    const info = infoMap(col("a", "integer"), col("b", "text"));
    expect(
      buildPkWhere("postgres", ["a", "b"], { a: 1, b: null }, info),
    ).toBe("a = 1 AND b IS NULL");
    expect(() => buildPkWhere("postgres", ["a"], {}, info)).toThrow();
    expect(() => buildPkWhere("postgres", [], {}, info)).toThrow();
  });
});

describe("buildUpdateSql", () => {
  const info = infoMap(
    col("Id", "integer", { isPrimaryKey: true, nullable: false }),
    col("order", "text"),
    col("price", "numeric(10,2)"),
  );

  it("quotes mixed-case / reserved identifiers on Postgres", () => {
    expect(
      buildUpdateSql("postgres", "My Schema", "Users", ["Id"], { Id: 7 }, { order: "x", price: "" }, info),
    ).toBe(
      `UPDATE "My Schema"."Users" SET "order" = 'x', price = NULL WHERE "Id" = 7`,
    );
  });

  it("uses each dialect's quoting", () => {
    expect(
      buildUpdateSql("mysql", "db", "t", ["Id"], { Id: 7 }, { order: "a\\b" }, info),
    ).toBe("UPDATE `db`.`t` SET `order` = 'a\\\\b' WHERE `Id` = 7");
    expect(
      buildUpdateSql("mssql", "dbo", "t]x", ["Id"], { Id: 7 }, { order: "ñ" }, info),
    ).toBe("UPDATE [dbo].[t]]x] SET [order] = N'ñ' WHERE [Id] = 7");
  });

  it("refuses an empty change set", () => {
    expect(() =>
      buildUpdateSql("postgres", "s", "t", ["Id"], { Id: 1 }, {}, info),
    ).toThrow();
  });
});

describe("buildInsertSql", () => {
  const info = infoMap(
    col("id", "integer", { isPrimaryKey: true, nullable: false, default: "nextval('s')" }),
    col("name", "varchar(10)", { nullable: false }),
    col("note", "text"),
  );
  it("only lists touched columns", () => {
    expect(
      buildInsertSql("postgres", "public", "t", { name: "", note: "" }, info),
    ).toBe("INSERT INTO public.t (name, note) VALUES ('', NULL)");
    expect(
      buildInsertSql("postgres", "public", "t", { id: "" }, info),
    ).toBe("INSERT INTO public.t (id) VALUES (DEFAULT)");
  });
  it("handles a row with no values", () => {
    expect(buildInsertSql("mysql", "db", "t", {}, info)).toBe(
      "INSERT INTO `db`.`t` () VALUES ()",
    );
    expect(buildInsertSql("mssql", "dbo", "t", {}, info)).toBe(
      "INSERT INTO [dbo].[t] DEFAULT VALUES",
    );
  });
});

describe("buildTablePreviewSql", () => {
  it("uses TOP on SQL Server and LIMIT elsewhere", () => {
    expect(
      buildTablePreviewSql("mssql", "dbo", "t", " id > 1 ", { column: "id", direction: "desc" }),
    ).toBe("SELECT TOP 100 * FROM [dbo].[t]\nWHERE id > 1\nORDER BY [id] DESC;");
    expect(buildTablePreviewSql("postgres", "public", "Users", "", null)).toBe(
      'SELECT * FROM public."Users"\nLIMIT 100;',
    );
  });
});

describe("row helpers", () => {
  it("parses enum values with escaped quotes", () => {
    expect(parseEnumValues("enum('a','it''s')")).toEqual(["a", "it's"]);
    expect(parseEnumValues("varchar(10)")).toBeNull();
  });
  it("doesn't collide composite keys", () => {
    const idx = new Map([
      ["a", 0],
      ["b", 1],
    ]);
    expect(rowPkKey(["1", "23"], idx, ["a", "b"])).not.toBe(
      rowPkKey(["12", "3"], idx, ["a", "b"]),
    );
    expect(rowPkKey(["1"], idx, [])).toBeNull();
  });
});
