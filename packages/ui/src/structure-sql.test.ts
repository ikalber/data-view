import { describe, expect, it } from "vitest";
import type { ColumnInfo, QueryResult } from "@data-view/core";
import {
  buildAlterStatements,
  columnExtrasQuery,
  draftFromColumn,
  emptyDraft,
  isExistingDirty,
  mssqlFullType,
  mysqlDefaultToExpr,
  normalizeDataType,
  parseColumnExtras,
  validateDrafts,
  type ColumnDraft,
} from "./structure-sql";

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
    default: null,
    ...extra,
  };
}

function edit(d: ColumnDraft, patch: Partial<ColumnDraft>): ColumnDraft {
  return { ...d, ...patch };
}

function result(rows: unknown[][]): QueryResult {
  return {
    columns: [],
    rows: rows as QueryResult["rows"],
    rowCount: rows.length,
    affectedRows: null,
    durationMs: 0,
    truncated: false,
  };
}

describe("mysqlDefaultToExpr", () => {
  it("turns information_schema defaults back into SQL", () => {
    expect(mysqlDefaultToExpr(null)).toBe("");
    expect(mysqlDefaultToExpr("active", "")).toBe("'active'");
    expect(mysqlDefaultToExpr("it's", "")).toBe("'it''s'");
    expect(mysqlDefaultToExpr("C:\\x", "")).toBe("'C:\\\\x'");
    expect(mysqlDefaultToExpr("5", "")).toBe("5");
    expect(mysqlDefaultToExpr("-1.5", "")).toBe("-1.5");
    expect(mysqlDefaultToExpr("CURRENT_TIMESTAMP", "DEFAULT_GENERATED")).toBe(
      "CURRENT_TIMESTAMP",
    );
    expect(mysqlDefaultToExpr("current_timestamp()", "")).toBe("current_timestamp()");
    expect(mysqlDefaultToExpr("uuid()", "DEFAULT_GENERATED")).toBe("(uuid())");
    expect(mysqlDefaultToExpr("b'0'", "")).toBe("b'0'");
    expect(mysqlDefaultToExpr("'x'", "")).toBe("'x'"); // MariaDB style
    expect(mysqlDefaultToExpr("", "")).toBe("''");
  });
});

describe("normalizeDataType", () => {
  it("ignores casing of known bases and spaces after commas", () => {
    expect(normalizeDataType("mysql", "varchar(255)")).toBe("VARCHAR(255)");
    expect(normalizeDataType("mssql", "decimal(10, 2)")).toBe(
      normalizeDataType("mssql", "DECIMAL(10,2)"),
    );
  });
});

describe("buildAlterStatements — Postgres", () => {
  const base = draftFromColumn(
    "postgres",
    col("Code", "text", { default: "'x'::text" }),
  );

  it("renames, retypes with USING, and swaps the default safely", () => {
    const d = edit(base, { name: "code2", dataType: "integer", defaultExpr: "0" });
    expect(buildAlterStatements("postgres", "s", "T", [d])).toEqual([
      'ALTER TABLE "s"."T" RENAME COLUMN "Code" TO "code2"',
      'ALTER TABLE "s"."T" ALTER COLUMN "code2" DROP DEFAULT',
      'ALTER TABLE "s"."T" ALTER COLUMN "code2" TYPE integer USING "code2"::integer',
      'ALTER TABLE "s"."T" ALTER COLUMN "code2" SET DEFAULT 0',
    ]);
  });

  it("handles null, default removal and comments", () => {
    const d = edit(base, { nullable: false, defaultExpr: "", comment: "it's" });
    expect(buildAlterStatements("postgres", "s", "t", [d])).toEqual([
      'ALTER TABLE "s"."t" ALTER COLUMN "Code" SET NOT NULL',
      'ALTER TABLE "s"."t" ALTER COLUMN "Code" DROP DEFAULT',
      `COMMENT ON COLUMN "s"."t"."Code" IS 'it''s'`,
    ]);
  });

  it("adds and drops columns", () => {
    const added = { ...emptyDraft(1), name: "n", dataType: "integer", nullable: false, defaultExpr: "1" };
    const dropped = edit(base, { isDropped: true });
    expect(buildAlterStatements("postgres", "s", "t", [dropped, added])).toEqual([
      'ALTER TABLE "s"."t" DROP COLUMN "Code"',
      'ALTER TABLE "s"."t" ADD COLUMN "n" integer NOT NULL DEFAULT 1',
    ]);
  });

  it("emits nothing for an untouched column", () => {
    expect(buildAlterStatements("postgres", "s", "t", [base])).toEqual([]);
    expect(isExistingDirty("postgres", base)).toBe(false);
  });
});

describe("buildAlterStatements — MySQL", () => {
  const extras = { extra: "", comment: null };

  it("re-quotes literal defaults in CHANGE COLUMN", () => {
    const d = draftFromColumn(
      "mysql",
      col("status", "varchar(20)", { nullable: false, default: "active" }),
      extras,
    );
    expect(d.defaultExpr).toBe("'active'");
    expect(isExistingDirty("mysql", d)).toBe(false);
    const changed = edit(d, { nullable: true });
    expect(buildAlterStatements("mysql", "db", "t", [changed])).toEqual([
      "ALTER TABLE `db`.`t` CHANGE COLUMN `status` `status` varchar(20) NULL DEFAULT 'active'",
    ]);
  });

  it("keeps AUTO_INCREMENT / ON UPDATE / comment on redefinition", () => {
    const id = draftFromColumn(
      "mysql",
      col("id", "int", { nullable: false, isPrimaryKey: true }),
      { extra: "auto_increment", comment: "pk" },
    );
    expect(id.comment).toBe("pk");
    expect(
      buildAlterStatements("mysql", "db", "t", [edit(id, { dataType: "bigint" })]),
    ).toEqual([
      "ALTER TABLE `db`.`t` CHANGE COLUMN `id` `id` bigint NOT NULL AUTO_INCREMENT COMMENT 'pk'",
    ]);
    const ts = draftFromColumn(
      "mysql",
      col("ts", "timestamp", { default: "CURRENT_TIMESTAMP" }),
      { extra: "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", comment: null },
    );
    expect(
      buildAlterStatements("mysql", "db", "t", [edit(ts, { nullable: false })]),
    ).toEqual([
      "ALTER TABLE `db`.`t` CHANGE COLUMN `ts` `ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP",
    ]);
  });

  it("uses RENAME COLUMN for a pure rename", () => {
    const d = draftFromColumn("mysql", col("a", "int"), extras);
    expect(buildAlterStatements("mysql", "db", "t", [edit(d, { name: "b" })])).toEqual([
      "ALTER TABLE `db`.`t` RENAME COLUMN `a` TO `b`",
    ]);
  });

  it("escapes backslashes in comments", () => {
    const added = { ...emptyDraft(1), name: "p", dataType: "TEXT", comment: "C:\\dir" };
    expect(buildAlterStatements("mysql", "db", "t", [added])).toEqual([
      "ALTER TABLE `db`.`t` ADD COLUMN `p` TEXT NULL COMMENT 'C:\\\\dir'",
    ]);
  });
});

describe("buildAlterStatements — SQL Server", () => {
  const qty = draftFromColumn(
    "mssql",
    col("qty", "int", { nullable: false, default: "((0))" }),
  );

  it("uses ADD without COLUMN", () => {
    const added = { ...emptyDraft(1), name: "extra", dataType: "int" };
    expect(buildAlterStatements("mssql", "dbo", "t", [added])).toEqual([
      "ALTER TABLE [dbo].[t] ADD [extra] int NULL",
    ]);
  });

  it("drops the default constraint before DROP COLUMN", () => {
    const stmts = buildAlterStatements("mssql", "dbo", "t", [edit(qty, { isDropped: true })]);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("sys.default_constraints");
    expect(stmts[0]).toContain("DROP CONSTRAINT");
    expect(stmts[1]).toBe("ALTER TABLE [dbo].[t] DROP COLUMN [qty]");
  });

  it("re-creates the default around a type change", () => {
    const stmts = buildAlterStatements("mssql", "dbo", "t", [
      edit(qty, { dataType: "bigint" }),
    ]);
    expect(stmts[0]).toContain("DROP CONSTRAINT");
    expect(stmts.slice(1)).toEqual([
      "ALTER TABLE [dbo].[t] ALTER COLUMN [qty] bigint NOT NULL",
      "ALTER TABLE [dbo].[t] ADD DEFAULT ((0)) FOR [qty]",
    ]);
  });

  it("changes only the default without touching the column", () => {
    const stmts = buildAlterStatements("mssql", "dbo", "t", [
      edit(qty, { defaultExpr: "5" }),
    ]);
    expect(stmts).toHaveLength(2);
    expect(stmts[1]).toBe("ALTER TABLE [dbo].[t] ADD DEFAULT 5 FOR [qty]");
  });

  it("renames with sp_rename and writes comments as MS_Description", () => {
    const d = draftFromColumn("mssql", col("a b", "int"));
    const stmts = buildAlterStatements("mssql", "dbo", "t", [
      edit(d, { name: "c", comment: "ñandú" }),
    ]);
    expect(stmts[0]).toBe("EXEC sp_rename N'[dbo].[t].[a b]', N'c', 'COLUMN'");
    expect(stmts[1]).toContain("sp_addextendedproperty");
    expect(stmts[1]).toContain("N'ñandú'");
  });

  it("blocks length-less types that would truncate data", () => {
    const name = draftFromColumn("mssql", col("name", "nvarchar"));
    expect(validateDrafts("mssql", [edit(name, { nullable: false })])).toHaveLength(1);
    // With the full type known (see columnExtrasQuery) it's fine.
    const full = draftFromColumn("mssql", col("name", "nvarchar"), { fullType: "nvarchar(50)" });
    expect(full.dataType).toBe("nvarchar(50)");
    expect(validateDrafts("mssql", [edit(full, { nullable: false })])).toEqual([]);
    expect(
      buildAlterStatements("mssql", "dbo", "t", [edit(full, { nullable: false })]),
    ).toEqual(["ALTER TABLE [dbo].[t] ALTER COLUMN [name] nvarchar(50) NOT NULL"]);
    // Untouched columns never trip the check.
    expect(validateDrafts("mssql", [name])).toEqual([]);
  });
});

describe("column extras", () => {
  it("rebuilds SQL Server types", () => {
    expect(mssqlFullType("nvarchar", 100, 0, 0)).toBe("nvarchar(50)");
    expect(mssqlFullType("varchar", -1, 0, 0)).toBe("varchar(max)");
    expect(mssqlFullType("decimal", 9, 10, 2)).toBe("decimal(10,2)");
    expect(mssqlFullType("datetime2", 8, 27, 7)).toBe("datetime2(7)");
    expect(mssqlFullType("int", 4, 10, 0)).toBe("int");
  });

  it("parses each driver's metadata rows", () => {
    expect(parseColumnExtras("mysql", result([["id", "auto_increment", ""]])).get("id")).toEqual({
      extra: "auto_increment",
      comment: null,
    });
    expect(
      parseColumnExtras("mssql", result([["n", "nvarchar", 20, 0, 0, "hola"]])).get("n"),
    ).toEqual({ fullType: "nvarchar(10)", comment: "hola" });
    expect(parseColumnExtras("postgres", result([["a", null]])).get("a")).toEqual({
      comment: null,
    });
  });

  it("inlines escaped literals in the metadata query", () => {
    expect(columnExtrasQuery("mysql", "d\\b", "t'x")).toContain("'d\\\\b'");
    expect(columnExtrasQuery("mysql", "d\\b", "t'x")).toContain("'t''x'");
    expect(columnExtrasQuery("mssql", "dbo", "a]b")).toContain("N'[dbo].[a]]b]'");
  });
});
