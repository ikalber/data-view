// Integration tests for the Postgres adapter. Skipped unless DV_TEST_PG_URL is
// set, e.g. DV_TEST_PG_URL=postgres://postgres:test@127.0.0.1:15432/postgres
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { postgresDriver as driver } from "./postgres";
import { collectBatches, connFromUrl, UNUSED_URL } from "./test-helpers";

// Run in a non-UTC zone so a driver that shifts dates by the Node process
// timezone fails here regardless of the machine's TZ (forks pool: per file).
process.env.TZ = "America/Argentina/Buenos_Aires";

const URL_ = process.env.DV_TEST_PG_URL;

// Every object we create is prefixed with dvt_web_ (shared test servers).
const S = "dvt_web_pg";
const MS = "dvt_web_MySchema"; // mixed case → must always be quoted
const ROLE = "dvt_web_owner";

describe.skipIf(!URL_)("postgres adapter (integration)", () => {
  const conn = connFromUrl(URL_ ?? UNUSED_URL, "postgres");
  let admin: Client;
  const exec = (sql: string) => admin.query(sql);

  beforeAll(async () => {
    admin = new Client({ connectionString: URL_ });
    await admin.connect();
    await exec(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await exec(`DROP SCHEMA IF EXISTS "${MS}" CASCADE`);
    await exec(`DROP SCHEMA IF EXISTS dvt_web_pg_created CASCADE`);
    await exec(`DROP SCHEMA IF EXISTS dvt_web_pg_owned CASCADE`);
    await exec(`DROP ROLE IF EXISTS ${ROLE}`);
    await exec(`CREATE ROLE ${ROLE}`);
    await exec(`CREATE SCHEMA ${S}`);
    await exec(`CREATE SCHEMA "${MS}"`);
    await exec(`
      CREATE TABLE ${S}.customers (
        id serial PRIMARY KEY,
        email varchar(100) NOT NULL UNIQUE,
        name text,
        status varchar(20) NOT NULL DEFAULT 'active',
        created_at timestamptz DEFAULT now()
      );
      INSERT INTO ${S}.customers (email, name)
        SELECT 'user' || g || '@x.com', 'User ' || g FROM generate_series(1, 25) g;
      CREATE TABLE "${MS}"."Order Items" (
        "Order Id" integer NOT NULL,
        "select" integer NOT NULL,
        qty numeric(10,2) NOT NULL DEFAULT 0,
        "CustomerId" integer REFERENCES ${S}.customers(id) ON UPDATE CASCADE ON DELETE SET NULL,
        note text,
        PRIMARY KEY ("Order Id", "select")
      );
      CREATE INDEX "Idx Qty" ON "${MS}"."Order Items" (qty, "select");
      CREATE UNIQUE INDEX order_items_note_uq ON "${MS}"."Order Items" (note);
      INSERT INTO "${MS}"."Order Items" VALUES (1, 1, 2.5, 1, 'a'), (1, 2, 3, 2, 'b'), (2, 1, 1, NULL, NULL);
      CREATE VIEW ${S}.active_customers AS SELECT * FROM ${S}.customers WHERE status = 'active';
      CREATE MATERIALIZED VIEW ${S}.customer_count AS SELECT count(*) AS n FROM ${S}.customers;
      CREATE TABLE ${S}.empty_t (id int PRIMARY KEY);
      ANALYZE ${S}.customers;
      COMMENT ON COLUMN ${S}.customers.email IS 'Login email';
    `);
  });

  afterAll(async () => {
    if (!admin) return;
    await exec(`DROP SCHEMA IF EXISTS ${S} CASCADE`).catch(() => undefined);
    await exec(`DROP SCHEMA IF EXISTS "${MS}" CASCADE`).catch(() => undefined);
    await exec(`DROP SCHEMA IF EXISTS dvt_web_pg_created CASCADE`).catch(() => undefined);
    await exec(`DROP SCHEMA IF EXISTS dvt_web_pg_owned CASCADE`).catch(() => undefined);
    await exec(`DROP ROLE IF EXISTS ${ROLE}`).catch(() => undefined);
    await admin.end();
  });

  // ── connection ────────────────────────────────────────────────────────
  it("testConnection succeeds with valid credentials", async () => {
    const r = await driver.testConnection(conn);
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("testConnection reports a bad password without throwing", async () => {
    const r = await driver.testConnection({ ...conn, password: "definitely-wrong" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/password authentication failed/i);
  });

  // ── catalog ───────────────────────────────────────────────────────────
  it("listSchemas flags system schemas", async () => {
    const schemas = await driver.listSchemas(conn);
    const byName = new Map(schemas.map((s) => [s.name, s.isSystem]));
    expect(byName.get("pg_catalog")).toBe(true);
    expect(byName.get("information_schema")).toBe(true);
    expect(byName.get("public")).toBe(false);
    expect(byName.get(S)).toBe(false);
    expect(byName.get(MS)).toBe(false);
  });

  it("listRelations returns kinds and size stats", async () => {
    const rels = await driver.listRelations(conn, S);
    const by = new Map(rels.map((r) => [r.name, r]));
    expect(by.get("customers")?.kind).toBe("table");
    expect(by.get("active_customers")?.kind).toBe("view");
    expect(by.get("customer_count")?.kind).toBe("materialized_view");
    const t = by.get("customers")!;
    expect(t.approxRowCount).toBe(25);
    expect(t.totalBytes).toBeGreaterThan(0);
    expect(t.dataBytes).toBeGreaterThan(0);
    expect(t.indexBytes).toBeGreaterThan(0);
    expect(t.totalBytes!).toBeGreaterThanOrEqual(t.dataBytes! + t.indexBytes!);
    expect(by.get("active_customers")?.totalBytes).toBeUndefined();
    // Only the requested schema.
    expect(rels.every((r) => r.schema === S)).toBe(true);
    const mixed = await driver.listRelations(conn, MS);
    expect(mixed.map((r) => r.name)).toEqual(["Order Items"]);
  });

  it("getConnectionOverview returns server info", async () => {
    const o = await driver.getConnectionOverview(conn);
    expect(o.driver).toBe("postgres");
    expect(o.serverVersion).toMatch(/PostgreSQL/);
    expect(o.currentDatabase).toBe(conn.database);
    expect(o.currentUser).toBe(conn.username);
    expect(o.serverTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(Math.abs(new Date(o.serverTime!).getTime() - Date.now())).toBeLessThan(5 * 60_000);
    expect(o.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(o.maxConnections).toBeGreaterThan(0);
    expect(o.activeConnections).toBeGreaterThan(0);
    expect(o.databases.find((d) => d.name === conn.database)).toBeTruthy();
  });

  // ── describeTable ─────────────────────────────────────────────────────
  it("describeTable: columns, PK, unique, defaults, nullability", async () => {
    const d = await driver.describeTable(conn, S, "customers");
    expect(d.kind).toBe("table");
    const col = (n: string) => d.columns.find((c) => c.name === n)!;
    expect(d.columns.map((c) => c.name)).toEqual(["id", "email", "name", "status", "created_at"]);
    expect(col("id").isPrimaryKey).toBe(true);
    expect(col("id").default).toMatch(/^nextval\(/);
    expect(col("email").isUnique).toBe(true);
    expect(col("email").nullable).toBe(false);
    expect(col("email").dataType).toBe("character varying(100)");
    expect(col("name").nullable).toBe(true);
    expect(col("name").isUnique).toBe(false);
    expect(col("status").default).toMatch(/'active'/);
    expect(col("created_at").default).toBe("now()");
    expect(col("email").comment).toBe("Login email");
    expect(col("name").comment).toBeNull();
  });

  it("describeTable: composite PK, FKs with actions, indexes, quoted identifiers", async () => {
    const d = await driver.describeTable(conn, MS, "Order Items");
    const pk = d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    expect(pk).toEqual(["Order Id", "select"]);
    // A composite PK doesn't make each column unique on its own.
    expect(d.columns.find((c) => c.name === "Order Id")!.isUnique).toBe(false);
    expect(d.columns.find((c) => c.name === "note")!.isUnique).toBe(true);
    expect(d.foreignKeys).toHaveLength(1);
    expect(d.foreignKeys[0]).toMatchObject({
      columns: ["CustomerId"],
      referencedSchema: S,
      referencedTable: "customers",
      referencedColumns: ["id"],
      onUpdate: "CASCADE",
      onDelete: "SET NULL",
    });
    const primary = d.indexes.find((i) => i.primary)!;
    expect(primary.columns).toEqual(["Order Id", "select"]);
    expect(primary.unique).toBe(true);
    const idx = d.indexes.find((i) => i.name === "Idx Qty")!;
    // Raw column names, not SQL-quoted ones.
    expect(idx.columns).toEqual(["qty", "select"]);
    expect(idx.unique).toBe(false);
  });

  it("describeTable reports the relation kind for views", async () => {
    const d = await driver.describeTable(conn, S, "active_customers");
    expect(d.kind).toBe("view");
    expect(d.columns.length).toBe(5);
  });

  // ── runQuery ──────────────────────────────────────────────────────────
  it("runQuery SELECT returns columns + rows and no affectedRows", async () => {
    const r = await driver.runQuery(conn, `SELECT id, email FROM ${S}.customers ORDER BY id LIMIT 3`);
    expect(r.columns).toEqual([
      { name: "id", dataType: "int4" },
      { name: "email", dataType: "varchar" },
    ]);
    expect(r.rows).toEqual([
      [1, "user1@x.com"],
      [2, "user2@x.com"],
      [3, "user3@x.com"],
    ]);
    expect(r.rowCount).toBe(3);
    expect(r.affectedRows).toBeNull();
    expect(r.truncated).toBe(false);
  });

  it("runQuery DML reports affectedRows; DDL works", async () => {
    await driver.runQuery(conn, `CREATE TABLE ${S}.dml_t (id int, v text)`);
    const ins = await driver.runQuery(conn, `INSERT INTO ${S}.dml_t VALUES (1,'a'),(2,'b'),(3,'c')`);
    expect(ins.affectedRows).toBe(3);
    expect(ins.columns).toEqual([]);
    const upd = await driver.runQuery(conn, `UPDATE ${S}.dml_t SET v = 'z' WHERE id > 1`);
    expect(upd.affectedRows).toBe(2);
    const del = await driver.runQuery(conn, `DELETE FROM ${S}.dml_t`);
    expect(del.affectedRows).toBe(3);
    await driver.runQuery(conn, `DROP TABLE ${S}.dml_t`);
  });

  it("runQuery surfaces syntax errors and constraint details", async () => {
    await expect(driver.runQuery(conn, "SELEC 1")).rejects.toThrow(/syntax error at or near "SELEC"/);
    await expect(driver.runQuery(conn, "SELECT 1,\n  2\nFORM x")).rejects.toThrow(/LINE 3: FORM x/);
    // The DETAIL line tells the user *which* key collided.
    await expect(
      driver.runQuery(conn, `INSERT INTO ${S}.customers (email) VALUES ('user1@x.com')`),
    ).rejects.toThrow(/already exists/);
  });

  it("runQuery honors the schema option (search_path) with mixed-case schema", async () => {
    const r = await driver.runQuery(conn, `SELECT count(*)::int AS n FROM "Order Items"`, { schema: MS });
    expect(r.rows).toEqual([[3]]);
  });

  it("runQuery with multiple statements returns the last result set", async () => {
    const r = await driver.runQuery(conn, "SELECT 1 AS a; SELECT 2 AS b, 'x' AS c");
    expect(r.columns.map((c) => c.name)).toEqual(["b", "c"]);
    expect(r.rows).toEqual([[2, "x"]]);
    const dml = await driver.runQuery(
      conn,
      `CREATE TEMP TABLE t_multi (id int); INSERT INTO t_multi VALUES (1),(2); INSERT INTO t_multi VALUES (3)`,
    );
    expect(dml.affectedRows).toBe(3);
  });

  it("runQuery supports parameters", async () => {
    const r = await driver.runQuery(conn, `SELECT $1::int + 1 AS n`, { params: [41] });
    expect(r.rows).toEqual([[42]]);
  });

  it("runQuery caps huge results and flags them as truncated", async () => {
    const r = await driver.runQuery(conn, "SELECT g FROM generate_series(1, 6000) g");
    expect(r.rows.length).toBe(5000);
    expect(r.rowCount).toBe(5000);
    expect(r.truncated).toBe(true);
    const exact = await driver.runQuery(conn, "SELECT g FROM generate_series(1, 5000) g");
    expect(exact.rows.length).toBe(5000);
    expect(exact.truncated).toBe(false);
  });

  it("runQuery converts types faithfully", async () => {
    const r = await driver.runQuery(
      conn,
      `SELECT DATE '2024-01-15' AS d,
              TIMESTAMP '2024-01-15 10:30:00.123456' AS ts,
              TIMESTAMPTZ '2024-01-15 10:30:00+03' AS tstz,
              TIME '23:59:58' AS t,
              INTERVAL '1 day 02:00:00' AS iv,
              123456789012.345678::numeric(20,6) AS dec,
              9223372036854775807::bigint AS big,
              1.5::float8 AS f,
              '{"a": 1, "b": [1, 2]}'::json AS j,
              '{"a": 1}'::jsonb AS jb,
              'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS u,
              '\\x010203'::bytea AS bin,
              true AS yes, false AS no,
              NULL::text AS nothing,
              ARRAY['x','y'] AS arr`,
    );
    const row = Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0]![i]]));
    // Dates and timestamps without tz must not be shifted by the Node TZ.
    expect(row.d).toBe("2024-01-15");
    expect(row.ts).toBe("2024-01-15 10:30:00.123456");
    expect(typeof row.tstz).toBe("string");
    const tstz = String(row.tstz).replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
    expect(new Date(tstz).toISOString()).toBe("2024-01-15T07:30:00.000Z");
    expect(row.t).toBe("23:59:58");
    expect(row.iv).toBe("1 day 02:00:00");
    expect(row.dec).toBe("123456789012.345678");
    expect(row.big).toBe("9223372036854775807");
    expect(row.f).toBe(1.5);
    expect(JSON.parse(String(row.j))).toEqual({ a: 1, b: [1, 2] });
    expect(JSON.parse(String(row.jb))).toEqual({ a: 1 });
    expect(row.u).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");
    expect(row.bin).toEqual({ __binary: true, bytes: 3 });
    expect(row.yes).toBe(true);
    expect(row.no).toBe(false);
    expect(row.nothing).toBeNull();
    expect(JSON.parse(String(row.arr))).toEqual(["x", "y"]);
    const types = Object.fromEntries(r.columns.map((c) => [c.name, c.dataType]));
    expect(types).toMatchObject({ d: "date", ts: "timestamp", tstz: "timestamptz", big: "int8", bin: "bytea", u: "uuid" });
  });

  // ── fetchTableData / iterateTable ─────────────────────────────────────
  it("fetchTableData paginates, orders, filters and flags more rows", async () => {
    const page = await driver.fetchTableData(conn, S, "customers", {
      limit: 10,
      offset: 5,
      orderBy: [{ column: "id", direction: "asc" }],
    });
    expect(page.rows.map((r) => r[0])).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(page.rowCount).toBe(10);
    expect(page.truncated).toBe(true);
    const last = await driver.fetchTableData(conn, S, "customers", {
      limit: 10,
      offset: 20,
      orderBy: [{ column: "id", direction: "asc" }],
    });
    expect(last.rows.length).toBe(5);
    expect(last.truncated).toBe(false);
    const desc = await driver.fetchTableData(conn, S, "customers", {
      limit: 2,
      orderBy: [{ column: "id", direction: "desc" }],
    });
    expect(desc.rows.map((r) => r[0])).toEqual([25, 24]);
    const filtered = await driver.fetchTableData(conn, S, "customers", { where: "id IN (3, 4)" });
    expect(filtered.rows.length).toBe(2);
    const quoted = await driver.fetchTableData(conn, MS, "Order Items", {
      orderBy: [{ column: "select", direction: "desc" }, { column: "Order Id", direction: "asc" }],
    });
    expect(quoted.rows.map((r) => [r[0], r[1]])).toEqual([
      [1, 2],
      [1, 1],
      [2, 1],
    ]);
  });

  it("fetchTableData rejects an injected sort direction", async () => {
    const r = await driver.fetchTableData(conn, S, "customers", {
      limit: 1,
      orderBy: [{ column: "id", direction: "desc; DROP TABLE x" as "desc" }],
    });
    expect(r.rows.length).toBe(1);
  });

  it("iterateTable yields batches, honors where and handles empty tables", async () => {
    const batches = await collectBatches(driver, conn, { schema: S, name: "customers", batchSize: 10 });
    expect(batches.map((b) => b.rows.length)).toEqual([10, 10, 5]);
    expect(batches[0]!.columns.map((c) => c.name)).toEqual(["id", "email", "name", "status", "created_at"]);
    const filtered = await collectBatches(driver, conn, { schema: S, name: "customers", where: "id <= 3" });
    expect(filtered.flatMap((b) => b.rows).length).toBe(3);
    // Empty table: one batch with the columns (exporters need them for headers).
    const empty = await collectBatches(driver, conn, { schema: S, name: "empty_t" });
    expect(empty).toEqual([{ columns: [{ name: "id", dataType: "int4" }], rows: [] }]);
    await expect(
      collectBatches(driver, conn, { schema: S, name: "customers", where: "nope = 1" }),
    ).rejects.toThrow(/column "nope" does not exist/);
    const mixed = await collectBatches(driver, conn, { schema: MS, name: "Order Items", batchSize: 2 });
    expect(mixed.map((b) => b.rows.length)).toEqual([2, 1]);
  });

  it("iterateTable can be abandoned early without leaking the connection", async () => {
    for await (const b of driver.iterateTable(conn, { schema: S, name: "customers", batchSize: 5 })) {
      expect(b.rows.length).toBe(5);
      break;
    }
    const r = await admin.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'data-view' AND state = 'idle in transaction'`,
    );
    expect(r.rows[0].n).toBe(0);
  });

  // ── DDL generation round-trip ─────────────────────────────────────────
  it("generateCreateTableSql round-trips (serial, defaults, composite PK, quoting)", async () => {
    await exec(`CREATE TABLE ${S}."Serial Src" (
      id serial PRIMARY KEY, big bigserial, small smallserial,
      label varchar(30) NOT NULL DEFAULT 'it''s', ts timestamp DEFAULT now(), amount numeric(12,3))`);
    const src = await driver.describeTable(conn, S, "Serial Src");
    const ddl = driver.generateCreateTableSql(conn, S, "Serial Src", src.columns);
    // Same flow as an export with "DROP TABLE IF EXISTS": the owned sequences
    // disappear with the table, so the DDL must not reference them.
    await exec(`DROP TABLE ${S}."Serial Src"`);
    await exec(ddl);
    const copy = await driver.describeTable(conn, S, "Serial Src");
    expect(copy.columns.map((c) => [c.name, c.dataType, c.nullable, c.isPrimaryKey])).toEqual(
      src.columns.map((c) => [c.name, c.dataType, c.nullable, c.isPrimaryKey]),
    );
    expect(copy.columns.find((c) => c.name === "label")!.default).toBe(
      src.columns.find((c) => c.name === "label")!.default,
    );
    await exec(`INSERT INTO ${S}."Serial Src" DEFAULT VALUES`);

    const src2 = await driver.describeTable(conn, MS, "Order Items");
    const ddl2 = driver.generateCreateTableSql(conn, MS, "Order Items Copy", src2.columns);
    await exec(ddl2);
    const copy2 = await driver.describeTable(conn, MS, "Order Items Copy");
    expect(copy2.columns.map((c) => [c.name, c.dataType, c.nullable, c.isPrimaryKey, c.default])).toEqual(
      src2.columns.map((c) => [c.name, c.dataType, c.nullable, c.isPrimaryKey, c.default]),
    );
  });

  // ── DDL helpers ───────────────────────────────────────────────────────
  it("createSchema / dropSchema (with owner and cascade)", async () => {
    await driver.createSchema(conn, { name: "dvt_web_pg_created" });
    await driver.createSchema(conn, { name: "dvt_web_pg_owned", owner: ROLE });
    const owner = await admin.query(
      `SELECT pg_get_userbyid(nspowner) AS o FROM pg_namespace WHERE nspname = 'dvt_web_pg_owned'`,
    );
    expect(owner.rows[0].o).toBe(ROLE);
    await exec(`CREATE TABLE dvt_web_pg_created.t (id int)`);
    await expect(driver.dropSchema(conn, "dvt_web_pg_created")).rejects.toThrow(/depend/);
    await driver.dropSchema(conn, "dvt_web_pg_created", { cascade: true });
    await driver.dropSchema(conn, "dvt_web_pg_owned");
    const left = await driver.listSchemas(conn);
    expect(left.some((s) => s.name.startsWith("dvt_web_pg_"))).toBe(false);
  });

  it("createTable with FKs, indexes, defaults, enum CHECK and quoted names", async () => {
    await driver.createTable(conn, {
      schema: MS,
      name: "Parent Table",
      columns: [
        { name: "Id", dataType: "integer", nullable: false, primaryKey: true },
        { name: "order", dataType: "text", nullable: true, primaryKey: false },
      ],
    });
    await driver.createTable(conn, {
      schema: MS,
      name: "Child Table",
      columns: [
        { name: "id", dataType: "serial", nullable: false, primaryKey: true },
        { name: "ParentId", dataType: "integer", nullable: true, primaryKey: false },
        { name: "status", dataType: `text CHECK ("status" IN ('a', 'b'))`, nullable: false, primaryKey: false, default: "'a'" },
        { name: "created", dataType: "timestamptz", nullable: false, primaryKey: false, default: "now()" },
      ],
      foreignKeys: [
        {
          name: "fk_child_parent",
          columns: ["ParentId"],
          referencedSchema: MS,
          referencedTable: "Parent Table",
          referencedColumns: ["Id"],
          onDelete: "CASCADE",
          onUpdate: "NO ACTION",
        },
      ],
      indexes: [{ columns: ["ParentId"] }, { name: "Uq Status Created", columns: ["status", "created"], unique: true }],
    });
    const d = await driver.describeTable(conn, MS, "Child Table");
    expect(d.foreignKeys[0]).toMatchObject({ name: "fk_child_parent", onDelete: "CASCADE", referencedTable: "Parent Table" });
    expect(d.indexes.map((i) => i.name).sort()).toEqual(["Child Table_pkey", "Uq Status Created", "idx_Child Table_ParentId"]);
    expect(d.columns.find((c) => c.name === "status")!.default).toMatch(/'a'/);
    await exec(`INSERT INTO "${MS}"."Parent Table" VALUES (1, 'x')`);
    await exec(`INSERT INTO "${MS}"."Child Table" ("ParentId") VALUES (1)`);
    await expect(exec(`INSERT INTO "${MS}"."Child Table" ("ParentId", status) VALUES (1, 'zzz')`)).rejects.toThrow(/check constraint/);

    // createIndex / dropIndex
    await driver.createIndex(conn, { schema: MS, table: "Child Table", name: "Idx Extra", columns: ["created"] });
    expect((await driver.describeTable(conn, MS, "Child Table")).indexes.some((i) => i.name === "Idx Extra")).toBe(true);
    await driver.dropIndex(conn, { schema: MS, table: "Child Table", name: "Idx Extra" });
    expect((await driver.describeTable(conn, MS, "Child Table")).indexes.some((i) => i.name === "Idx Extra")).toBe(false);

    // truncate with cascade wipes the referencing table too.
    await expect(driver.truncateTable(conn, MS, "Parent Table")).rejects.toThrow(/foreign key/);
    await driver.truncateTable(conn, MS, "Parent Table", { cascade: true });
    const n = await admin.query(`SELECT count(*)::int AS n FROM "${MS}"."Child Table"`);
    expect(n.rows[0].n).toBe(0);

    // dropTable with cascade removes the FK on the child.
    await expect(driver.dropTable(conn, MS, "Parent Table")).rejects.toThrow(/depend/);
    await driver.dropTable(conn, MS, "Parent Table", { cascade: true });
    expect((await driver.describeTable(conn, MS, "Child Table")).foreignKeys).toEqual([]);
    await driver.dropTable(conn, MS, "Child Table");
    const rels = await driver.listRelations(conn, MS);
    expect(rels.map((r) => r.name)).not.toContain("Child Table");
  });

  it("createTable is atomic: a failing index doesn't leave a half-created table", async () => {
    await expect(
      driver.createTable(conn, {
        schema: S,
        name: "atomic_t",
        columns: [{ name: "id", dataType: "int", nullable: false, primaryKey: true }],
        indexes: [{ columns: ["does_not_exist"] }],
      }),
    ).rejects.toThrow(/does_not_exist/);
    const rels = await driver.listRelations(conn, S);
    expect(rels.map((r) => r.name)).not.toContain("atomic_t");
  });
});
