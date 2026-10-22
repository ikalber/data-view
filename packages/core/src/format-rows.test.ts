import { describe, expect, it } from "vitest";
import {
  cellAsSqlLiteral,
  formatBatchBody,
  formatBatchPostlude,
  formatBatchPrelude,
  formatBatchSeparator,
  formatRows,
} from "./format-rows";
import type { FormatRowsOptions } from "./format-rows";
import type { QueryResult } from "./types";

const result: QueryResult = {
  columns: [
    { name: "id", dataType: "int" },
    { name: "name", dataType: "varchar" },
    { name: "flag", dataType: "boolean" },
    { name: "blob", dataType: "bytea" },
  ],
  rows: [
    [1, "plain", true, null],
    [2, 'with "quotes", commas\nand newline', false, { __binary: true, bytes: 4 }],
  ],
  rowCount: 2,
  affectedRows: null,
  durationMs: 1,
  truncated: false,
};

describe("cellAsSqlLiteral", () => {
  const text = { name: "c", dataType: "text" };
  const bool = { name: "c", dataType: "boolean" };
  const bit = { name: "c", dataType: "bit" };

  it("renders NULL and binary as NULL", () => {
    expect(cellAsSqlLiteral(null, text, "postgres")).toBe("NULL");
    expect(cellAsSqlLiteral({ __binary: true, bytes: 3 }, text, "postgres")).toBe("NULL");
  });

  it("renders booleans per dialect", () => {
    expect(cellAsSqlLiteral(true, bool, "postgres")).toBe("TRUE");
    expect(cellAsSqlLiteral(false, bool, "mysql")).toBe("0");
    // SQL Server has no TRUE/FALSE literals.
    expect(cellAsSqlLiteral(true, bit, "mssql")).toBe("1");
    expect(cellAsSqlLiteral(false, bit, "mssql")).toBe("0");
    expect(cellAsSqlLiteral("true", bit, "mssql")).toBe("1");
  });

  it("understands Postgres-style t/f boolean strings", () => {
    expect(cellAsSqlLiteral("t", bool, "postgres")).toBe("TRUE");
    expect(cellAsSqlLiteral("f", bool, "postgres")).toBe("FALSE");
  });

  it("keeps numeric strings unquoted for numeric columns", () => {
    expect(cellAsSqlLiteral("12345678901234567890", { name: "n", dataType: "bigint" }, "postgres")).toBe(
      "12345678901234567890",
    );
    expect(cellAsSqlLiteral("1.5", { name: "n", dataType: "numeric(10,2)" }, "mysql")).toBe("1.5");
    expect(cellAsSqlLiteral(Number.NaN, { name: "n", dataType: "float" }, "mysql")).toBe("NULL");
  });

  it("escapes strings per dialect", () => {
    expect(cellAsSqlLiteral("it's", text, "postgres")).toBe("'it''s'");
    expect(cellAsSqlLiteral("C:\\temp", text, "mysql")).toBe("'C:\\\\temp'");
    expect(cellAsSqlLiteral("ñ", text, "mssql")).toBe("N'ñ'");
  });
});

describe("formatRows", () => {
  it("CSV quotes fields with delimiters, quotes and newlines", () => {
    const csv = formatRows(result, { format: "csv" });
    expect(csv.split("\r\n")[0]).toBe("id,name,flag,blob");
    expect(csv).toContain('2,"with ""quotes"", commas\nand newline",false,<binary 4B>');
    expect(csv).toContain("1,plain,true,");
  });

  it("TSV can omit the header", () => {
    const tsv = formatRows(result, { format: "tsv", includeHeader: false });
    expect(tsv.startsWith("1\tplain")).toBe(true);
  });

  it("JSON produces a parseable array of objects", () => {
    const parsed = JSON.parse(formatRows(result, { format: "json" }));
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({ id: 1, name: "plain", flag: true, blob: null });
  });

  it("NDJSON emits one object per line", () => {
    const lines = formatRows(result, { format: "ndjson" }).split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).id).toBe(2);
  });

  it("SQL batches INSERTs and quotes identifiers per dialect", () => {
    const sql = formatRows(result, {
      format: "sql",
      driver: "postgres",
      schema: "public",
      table: "My Table",
      batchSize: 1,
    });
    expect(sql.match(/INSERT INTO/g)).toHaveLength(2);
    expect(sql).toContain('INSERT INTO public."My Table" (id, name, flag, blob) VALUES');
    expect(sql).toContain("(1, 'plain', TRUE, NULL)");
  });

  it("Markdown escapes pipes and flattens newlines", () => {
    const md = formatRows(
      { ...result, rows: [[1, "a|b\nc", null, null]] },
      { format: "markdown" },
    );
    expect(md).toContain("| 1 | a\\|b c |  |  |");
  });
});

describe("streaming batch helpers", () => {
  // Simulates what the export endpoints do: prelude, batches joined by the
  // separator, postlude. The result must equal the one-shot formatter.
  function stream(opts: FormatRowsOptions, batches: QueryResult["rows"][]): string {
    let out = formatBatchPrelude(result.columns, opts);
    batches.forEach((b, i) => {
      if (i > 0) out += formatBatchSeparator(opts);
      out += formatBatchBody(b, result.columns, opts);
    });
    return out + formatBatchPostlude(opts);
  }

  const batches = [[result.rows[0]!], [result.rows[1]!]];

  it("streamed JSON is valid and matches the rows", () => {
    const parsed = JSON.parse(stream({ format: "json" }, batches));
    expect(parsed).toHaveLength(2);
    expect(parsed[1].name).toContain("quotes");
  });

  it("streamed JSON of an empty table is an empty array", () => {
    expect(JSON.parse(stream({ format: "json" }, []))).toEqual([]);
  });

  it("streamed CSV uses CRLF consistently", () => {
    const row = result.rows[0]!;
    expect(stream({ format: "csv" }, [[row, row], [row]])).toBe(
      "id,name,flag,blob\r\n1,plain,true,\r\n1,plain,true,\r\n1,plain,true,\r\n",
    );
  });

  it("streamed NDJSON has one object per line", () => {
    const lines = stream({ format: "ndjson" }, batches).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([1, 2]);
  });

  it("streamed Markdown uses LF between rows and escapes the header", () => {
    const md = stream({ format: "markdown" }, batches);
    expect(md).not.toContain("\r");
    const header = formatBatchPrelude([{ name: "a|b", dataType: "text" }], {
      format: "markdown",
    });
    expect(header.startsWith("| a\\|b |")).toBe(true);
  });

  it("streamed SQL emits one INSERT per batch", () => {
    const sql = stream({ format: "sql", driver: "mysql", table: "t" }, batches);
    expect(sql.match(/INSERT INTO `t`/g)).toHaveLength(2);
  });
});
