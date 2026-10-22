// Runs the SQL built by grid-sql / structure-sql against real servers through
// the web adapters. Each suite is skipped unless its URL is set, e.g.
//   DV_TEST_PG_URL=postgres://postgres:test@127.0.0.1:15432/postgres
//   DV_TEST_MYSQL_URL=mysql://root:test@127.0.0.1:13306/mysql
//   DV_TEST_MSSQL_URL=mssql://sa:Test_Passw0rd!@127.0.0.1:11433/master?trustServerCertificate=true
// Every object created is prefixed with dvt_ui_ (shared test servers).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CellValue,
  ColumnInfo,
  DatabaseDriver,
  QueryResult,
  RunQueryOptions,
  TableDetails,
} from "@data-view/core";
import {
  buildInsertSql,
  buildTablePreviewSql,
  buildUpdateSql,
} from "./grid-sql";
import {
  buildAlterStatements,
  columnExtrasQuery,
  draftFromColumn,
  emptyDraft,
  parseColumnExtras,
  type ColumnDraft,
} from "./structure-sql";

interface Adapter {
  runQuery(conn: unknown, sql: string, options?: RunQueryOptions): Promise<QueryResult>;
  describeTable(conn: unknown, schema: string, name: string): Promise<TableDetails>;
}

// Loaded by computed path so the UI package's typecheck doesn't pull the web
// app (and its pg/mysql2/mssql deps) into its program.
const DB_DIR = new URL("../../../apps/web/src/server/db/", import.meta.url).pathname;

async function load(driver: DatabaseDriver, url: string) {
  const helpers = await import(/* @vite-ignore */ `${DB_DIR}test-helpers.ts`);
  const mod = await import(/* @vite-ignore */ `${DB_DIR}${driver}.ts`);
  const adapter = mod[`${driver}Driver`] as Adapter;
  const conn = helpers.connFromUrl(url, driver) as unknown;
  return { adapter, conn };
}

function info(details: TableDetails): Map<string, ColumnInfo> {
  return new Map(details.columns.map((c) => [c.name, c]));
}

function rowsAsObjects(r: QueryResult): Record<string, CellValue>[] {
  return r.rows.map((row) =>
    Object.fromEntries(r.columns.map((c, i) => [c.name, row[i] ?? null])),
  );
}

async function drafts(
  driver: DatabaseDriver,
  adapter: Adapter,
  conn: unknown,
  schema: string,
  table: string,
): Promise<ColumnDraft[]> {
  const details = await adapter.describeTable(conn, schema, table);
  const sql = columnExtrasQuery(driver, schema, table)!;
  const extras = parseColumnExtras(driver, await adapter.runQuery(conn, sql));
  return details.columns.map((c) => draftFromColumn(driver, c, extras.get(c.name)));
}

function patch(list: ColumnDraft[], name: string, p: Partial<ColumnDraft>): ColumnDraft[] {
  return list.map((d) => (d.id === name ? { ...d, ...p } : d));
}

async function runAll(adapter: Adapter, conn: unknown, stmts: string[]) {
  for (const s of stmts) await adapter.runQuery(conn, s);
}

// ── Postgres ─────────────────────────────────────────────────────────────
const PG_URL = process.env.DV_TEST_PG_URL;
describe.skipIf(!PG_URL)("grid/structure SQL on Postgres", () => {
  const S = "dvt_ui_It"; // mixed case → must be quoted
  const T = "Order";
  let a: Adapter;
  let c: unknown;
  const q = (sql: string) => a.runQuery(c, sql);

  beforeAll(async () => {
    ({ adapter: a, conn: c } = await load("postgres", PG_URL!));
    await q(`DROP SCHEMA IF EXISTS "${S}" CASCADE`);
    await q(`CREATE SCHEMA "${S}"`);
    await q(`CREATE TABLE "${S}"."${T}" (
      "Id" integer PRIMARY KEY,
      "order" text,
      note varchar(20) NOT NULL DEFAULT 'x',
      flag boolean,
      amount numeric(10,2),
      code text DEFAULT '9',
      dur interval
    )`);
    await q(`INSERT INTO "${S}"."${T}" ("Id", "order", code) VALUES (1, 'a', '5')`);
  });
  afterAll(async () => {
    if (a) await q(`DROP SCHEMA IF EXISTS "${S}" CASCADE`);
  });

  it("updates and inserts through the grid builders", async () => {
    const det = await a.describeTable(c, S, T);
    const upd = buildUpdateSql(
      "postgres", S, T, ["Id"], { Id: 1 },
      { order: "O'Brien C:\\x", note: "", flag: "true", amount: "12.50", dur: "5" },
      info(det),
    );
    // "5" for an interval column is quoted, so Postgres reads 5 seconds.
    const r = await q(upd);
    expect(r.affectedRows).toBe(1);
    await q(buildInsertSql("postgres", S, T, { Id: "2", note: "" }, info(det)));
    await q(buildInsertSql("postgres", S, T, { Id: "3" }, info(det)));
    const rows = rowsAsObjects(await q(`SELECT * FROM "${S}"."${T}" ORDER BY "Id"`));
    expect(rows[0]).toMatchObject({ order: "O'Brien C:\\x", note: "", flag: true, amount: "12.50", dur: "00:00:05" });
    expect(rows[1]).toMatchObject({ note: "", order: null });
    expect(rows[2]).toMatchObject({ note: "x", code: "9" });
    const preview = await q(
      buildTablePreviewSql("postgres", S, T, `"Id" > 1`, { column: "Id", direction: "desc" }),
    );
    expect(preview.rows.map((x) => x[0])).toEqual([3, 2]);
    // A WHERE that misses reports 0 rows (TablePane turns that into an error).
    const miss = await q(
      buildUpdateSql("postgres", S, T, ["Id"], { Id: 99 }, { order: "z" }, info(det)),
    );
    expect(miss.affectedRows).toBe(0);
  });

  it("applies ALTER statements", async () => {
    let list = await drafts("postgres", a, c, S, T);
    list = patch(list, "code", { name: "Code2", dataType: "integer", defaultExpr: "0", comment: "it's" });
    list = patch(list, "flag", { isDropped: true });
    list = patch(list, "note", { nullable: true, defaultExpr: "" });
    list = [...list, { ...emptyDraft(1), name: "Extra", dataType: "varchar(5)", defaultExpr: "'e'", comment: "nuevo" }];
    await runAll(a, c, buildAlterStatements("postgres", S, T, list));
    const after = await drafts("postgres", a, c, S, T);
    const byName = new Map(after.map((d) => [d.name, d]));
    expect(byName.has("flag")).toBe(false);
    expect(byName.get("Code2")).toMatchObject({ dataType: "integer", defaultExpr: "0", comment: "it's" });
    expect(byName.get("note")).toMatchObject({ nullable: true, defaultExpr: "" });
    expect(byName.get("Extra")).toMatchObject({ dataType: "character varying(5)", comment: "nuevo" });
    // Re-reading yields no further statements.
    expect(buildAlterStatements("postgres", S, T, after)).toEqual([]);
  });
});

// ── MySQL ────────────────────────────────────────────────────────────────
const MY_URL = process.env.DV_TEST_MYSQL_URL;
describe.skipIf(!MY_URL)("grid/structure SQL on MySQL", () => {
  const S = "dvt_ui_it";
  const T = "t";
  let a: Adapter;
  let c: unknown;
  const q = (sql: string) => a.runQuery(c, sql);

  beforeAll(async () => {
    ({ adapter: a, conn: c } = await load("mysql", MY_URL!));
    await q(`DROP DATABASE IF EXISTS ${S}`);
    await q(`CREATE DATABASE ${S}`);
    await q(`CREATE TABLE ${S}.${T} (
      id int NOT NULL AUTO_INCREMENT PRIMARY KEY COMMENT 'pk',
      status varchar(20) NOT NULL DEFAULT 'active',
      ts timestamp NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      path varchar(50) COMMENT 'ruta',
      flag tinyint(1),
      kind enum('a','b') NOT NULL DEFAULT 'a'
    )`);
    await q(`INSERT INTO ${S}.${T} (path) VALUES ('x')`);
  });
  afterAll(async () => {
    if (a) await q(`DROP DATABASE IF EXISTS ${S}`);
  });

  it("round-trips backslashes and booleans", async () => {
    const det = await a.describeTable(c, S, T);
    await q(buildUpdateSql("mysql", S, T, ["id"], { id: 1 }, { path: "C:\\temp\\", flag: "true", kind: "b" }, info(det)));
    await q(buildInsertSql("mysql", S, T, { path: "it's", status: "" }, info(det)));
    const rows = rowsAsObjects(await q(`SELECT id, path, flag, kind, status FROM ${S}.${T} ORDER BY id`));
    expect(rows[0]).toMatchObject({ path: "C:\\temp\\", flag: 1, kind: "b" });
    // NOT NULL text column + "" → empty string, not NULL / not the default.
    expect(rows[1]).toMatchObject({ path: "it's", status: "" });
    const preview = await q(buildTablePreviewSql("mysql", S, T, "", { column: "id", direction: "asc" }));
    expect(preview.rows).toHaveLength(2);
  });

  it("keeps defaults, AUTO_INCREMENT, ON UPDATE and comments", async () => {
    let list = await drafts("mysql", a, c, S, T);
    list = patch(list, "status", { nullable: true });
    list = patch(list, "id", { dataType: "bigint" });
    list = patch(list, "ts", { nullable: false });
    list = patch(list, "path", { name: "path2" });
    await runAll(a, c, buildAlterStatements("mysql", S, T, list));
    const meta = rowsAsObjects(
      await q(`SELECT column_name AS name, column_type AS type, column_default AS def, extra AS extra, column_comment AS comment, is_nullable AS n
               FROM information_schema.columns WHERE table_schema = '${S}' AND table_name = '${T}'`),
    );
    const by = new Map(meta.map((m) => [String(m.name), m]));
    expect(by.get("status")).toMatchObject({ def: "active", n: "YES" });
    expect(by.get("id")).toMatchObject({ type: "bigint", comment: "pk" });
    expect(String(by.get("id")!.extra)).toMatch(/auto_increment/i);
    expect(String(by.get("ts")!.extra)).toMatch(/on update/i);
    expect(by.get("path2")).toMatchObject({ comment: "ruta" });
    expect(buildAlterStatements("mysql", S, T, await drafts("mysql", a, c, S, T))).toEqual([]);
  });
});

// ── SQL Server ───────────────────────────────────────────────────────────
const MS_URL = process.env.DV_TEST_MSSQL_URL;
describe.skipIf(!MS_URL)("grid/structure SQL on SQL Server", () => {
  const DB = "dvt_ui_it";
  const S = "dbo";
  const T = "t";
  let admin: { adapter: Adapter; conn: unknown };
  let a: Adapter;
  let c: unknown;
  const q = (sql: string) => a.runQuery(c, sql);

  beforeAll(async () => {
    admin = await load("mssql", MS_URL!);
    await admin.adapter.runQuery(admin.conn, `IF DB_ID('${DB}') IS NOT NULL DROP DATABASE [${DB}]`);
    await admin.adapter.runQuery(admin.conn, `CREATE DATABASE [${DB}]`);
    const u = new URL(MS_URL!);
    u.pathname = `/${DB}`;
    ({ adapter: a, conn: c } = await load("mssql", u.toString()));
    await q(`CREATE TABLE dbo.${T} (
      id int IDENTITY(1,1) PRIMARY KEY,
      name nvarchar(50) NULL DEFAULT N'x',
      qty int NOT NULL DEFAULT 0,
      flag bit NULL,
      price decimal(10,2) NULL,
      gone int NULL DEFAULT 1
    )`);
    await q(`INSERT INTO dbo.${T} (name) VALUES (N'hello world')`);
  });
  afterAll(async () => {
    if (admin) {
      await admin.adapter.runQuery(
        admin.conn,
        `IF DB_ID('${DB}') IS NOT NULL BEGIN ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${DB}]; END`,
      );
    }
  });

  it("writes unicode, bits and DEFAULT", async () => {
    const det = await a.describeTable(c, S, T);
    const r = await q(buildUpdateSql("mssql", S, T, ["id"], { id: 1 }, { name: "日本 ñ", flag: "false", price: "3.5" }, info(det)));
    expect(r.affectedRows).toBe(1);
    await q(buildInsertSql("mssql", S, T, { name: "b", qty: "" }, info(det)));
    const rows = rowsAsObjects(await q(`SELECT id, name, flag, qty, price FROM dbo.${T} ORDER BY id`));
    expect(rows[0]).toMatchObject({ name: "日本 ñ", flag: false, price: 3.5 });
    expect(rows[1]).toMatchObject({ name: "b", qty: 0 });
    const preview = await q(buildTablePreviewSql("mssql", S, T, "id > 0", { column: "id", direction: "desc" }));
    expect(preview.rows).toHaveLength(2);
  });

  it("alters columns with bound defaults without truncating", async () => {
    let list = await drafts("mssql", a, c, S, T);
    expect(list.find((d) => d.id === "name")!.dataType).toBe("nvarchar(50)");
    list = patch(list, "name", { nullable: false, comment: "nombre" });
    list = patch(list, "qty", { name: "qty2", dataType: "bigint", defaultExpr: "5" });
    list = patch(list, "gone", { isDropped: true });
    list = [...list, { ...emptyDraft(1), name: "extra", dataType: "nvarchar(10)", defaultExpr: "N'e'" }];
    await runAll(a, c, buildAlterStatements("mssql", S, T, list));
    const after = await drafts("mssql", a, c, S, T);
    const by = new Map(after.map((d) => [d.name, d]));
    expect(by.has("gone")).toBe(false);
    expect(by.get("name")).toMatchObject({ dataType: "nvarchar(50)", nullable: false, comment: "nombre" });
    expect(by.get("qty2")).toMatchObject({ dataType: "bigint", defaultExpr: "((5))" });
    expect(by.get("extra")).toMatchObject({ dataType: "nvarchar(10)" });
    const rows = rowsAsObjects(await q(`SELECT name FROM dbo.${T} ORDER BY id`));
    expect(rows[0]).toMatchObject({ name: "日本 ñ" }); // not truncated
    expect(buildAlterStatements("mssql", S, T, after)).toEqual([]);
  });
});
