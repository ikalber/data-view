import { describe, expect, it } from "vitest";
import {
  generateDeleteSql,
  generateFullTableDDL,
  generateInsertSql,
  generateSelectSql,
  generateUpdateSql,
  quoteIdent,
  quoteIdentStrict,
  quoteString,
  renderForeignKeyClause,
} from "./sql-utils";
import type { TableDetails } from "./types";

describe("quoteIdent", () => {
  it("leaves plain lowercase Postgres identifiers unquoted", () => {
    expect(quoteIdent("postgres", "users")).toBe("users");
    expect(quoteIdent("postgres", "_tmp_1")).toBe("_tmp_1");
  });

  it("quotes mixed-case Postgres identifiers (unquoted ones fold to lowercase)", () => {
    expect(quoteIdent("postgres", "Users")).toBe('"Users"');
    expect(quoteIdent("postgres", "createdAt")).toBe('"createdAt"');
  });

  it("quotes Postgres reserved words", () => {
    for (const w of ["user", "order", "select", "group", "table", "limit", "end"]) {
      expect(quoteIdent("postgres", w)).toBe(`"${w}"`);
    }
  });

  it("quotes identifiers with spaces and escapes embedded quotes", () => {
    expect(quoteIdent("postgres", "Order Items")).toBe('"Order Items"');
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteIdent("postgres", "1abc")).toBe('"1abc"');
  });

  it("uses backticks on MySQL and brackets on SQL Server", () => {
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("mssql", "a]b")).toBe("[a]]b]");
  });

  it("strict variant always quotes", () => {
    expect(quoteIdentStrict("postgres", "users")).toBe('"users"');
  });
});

describe("quoteString", () => {
  it("doubles single quotes", () => {
    expect(quoteString("it's")).toBe("'it''s'");
  });

  it("escapes backslashes on MySQL (they are escape chars there)", () => {
    expect(quoteString("C:\\temp", "mysql")).toBe("'C:\\\\temp'");
    expect(quoteString("abc\\", "mysql")).toBe("'abc\\\\'");
    expect(quoteString("o'\\x", "mysql")).toBe("'o''\\\\x'");
  });

  it("keeps backslashes verbatim on Postgres", () => {
    expect(quoteString("C:\\temp", "postgres")).toBe("'C:\\temp'");
  });

  it("uses N'' literals on SQL Server so unicode survives", () => {
    expect(quoteString("ñandú 日本", "mssql")).toBe("N'ñandú 日本'");
  });
});

describe("generate*Sql helpers", () => {
  const cols = [
    { name: "id", dataType: "integer", isPrimaryKey: true, nullable: false },
    { name: "Name", dataType: "varchar(50)", nullable: true },
    { name: "active", dataType: "bit", nullable: false },
  ];

  it("SELECT uses TOP on SQL Server and LIMIT elsewhere", () => {
    expect(generateSelectSql("mssql", "dbo", "t", cols)).toContain("SELECT TOP 100");
    expect(generateSelectSql("postgres", "public", "t", cols)).toContain("LIMIT 100");
  });

  it("INSERT with only auto-increment columns works on MySQL", () => {
    const auto = [{ name: "id", dataType: "int auto_increment", isPrimaryKey: true }];
    expect(generateInsertSql("mysql", "db", "t", auto)).toBe(
      "INSERT INTO `db`.`t` () VALUES ();",
    );
    expect(generateInsertSql("postgres", "public", "t", [
      { name: "id", dataType: "serial", isPrimaryKey: true },
    ])).toBe('INSERT INTO "public"."t" DEFAULT VALUES;');
  });

  it("bit placeholders are valid T-SQL (no bare `false`)", () => {
    const sql = generateUpdateSql("mssql", "dbo", "t", cols);
    expect(sql).toContain("[active] = 0");
    expect(sql).not.toMatch(/\bfalse\b/);
    expect(sql).toContain("WHERE [id] = 0");
  });

  it("DELETE without PK keeps a guard comment", () => {
    expect(generateDeleteSql("postgres", "public", "t", [{ name: "x" }])).toContain(
      "WHERE 1 = 1",
    );
  });
});

describe("renderForeignKeyClause", () => {
  it("renders a multi-column FK with actions", () => {
    expect(
      renderForeignKeyClause("postgres", {
        name: "fk_x",
        columns: ["a", "B"],
        referencedSchema: "public",
        referencedTable: "Parent",
        referencedColumns: ["a", "b"],
        onDelete: "CASCADE",
      }),
    ).toBe(
      'CONSTRAINT fk_x FOREIGN KEY (a, "B") REFERENCES public."Parent" (a, b) ON DELETE CASCADE',
    );
  });

  it("rejects mismatched column counts", () => {
    expect(() =>
      renderForeignKeyClause("mysql", {
        columns: ["a"],
        referencedSchema: "s",
        referencedTable: "t",
        referencedColumns: ["a", "b"],
      }),
    ).toThrow();
  });
});

describe("generateFullTableDDL", () => {
  const details: TableDetails = {
    schema: "public",
    name: "Order",
    kind: "table",
    columns: [
      { name: "id", dataType: "integer", nullable: false, isPrimaryKey: true, isUnique: true },
      { name: "user", dataType: "text", nullable: true, isPrimaryKey: false, isUnique: false, default: "'x'" },
    ],
    indexes: [
      { name: "Order_pkey", columns: ["id"], unique: true, primary: true },
      { name: "idx_user", columns: ["user"], unique: false, primary: false },
    ],
    foreignKeys: [],
  };

  it("quotes reserved / mixed-case names and skips the PK index", () => {
    const ddl = generateFullTableDDL("postgres", details);
    expect(ddl).toContain('CREATE TABLE public."Order" (');
    expect(ddl).toContain(`"user" text DEFAULT 'x'`);
    expect(ddl).toContain("PRIMARY KEY (id)");
    expect(ddl).toContain('CREATE INDEX idx_user ON public."Order" ("user");');
    expect(ddl).not.toContain("Order_pkey");
  });

  it("is explicit about NULL on SQL Server", () => {
    const ddl = generateFullTableDDL("mssql", { ...details, schema: "dbo" });
    expect(ddl).toContain("[id] integer NOT NULL");
    expect(ddl).toContain("[user] text NULL DEFAULT 'x'");
  });
});
