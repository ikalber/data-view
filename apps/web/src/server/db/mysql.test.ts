// Integration tests for the MySQL adapter. Skipped unless DV_TEST_MYSQL_URL is
// set, e.g. DV_TEST_MYSQL_URL=mysql://root:test@127.0.0.1:13306/mysql
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { mysqlDriver as driver } from "./mysql";
import { collectBatches, connFromUrl, UNUSED_URL } from "./test-helpers";

// Run in a non-UTC zone so a driver that shifts dates by the Node process
// timezone fails here regardless of the machine's TZ (forks pool: per file).
process.env.TZ = "America/Argentina/Buenos_Aires";

const URL_ = process.env.DV_TEST_MYSQL_URL;

// Every database we create is prefixed with dvt_web_ (shared test servers).
const S = "dvt_web_my";
const MS = "dvt_web_MySchema"; // mixed case
const CREATED = "dvt_web_my_created";

describe.skipIf(!URL_)("mysql adapter (integration)", () => {
  const conn = connFromUrl(URL_ ?? UNUSED_URL, "mysql");
  let admin: mysql.Connection;
  const exec = (sql: string) => admin.query(sql);
  const scalar = async (sql: string) => {
    const [rows] = (await admin.query({ sql, rowsAsArray: true })) as [unknown[][], unknown];
    return rows[0]?.[0];
  };

  beforeAll(async () => {
    admin = await mysql.createConnection({ uri: URL_, multipleStatements: true });
    // MS references S through a cross-database FK, so drop it first.
    for (const db of [MS, S, CREATED]) await exec(`DROP DATABASE IF EXISTS \`${db}\``);
    await exec(`CREATE DATABASE ${S}; CREATE DATABASE \`${MS}\``);
    await exec(`
      CREATE TABLE ${S}.customers (
        id int unsigned NOT NULL AUTO_INCREMENT,
        email varchar(100) NOT NULL COMMENT 'Login email',
        name text,
        status varchar(20) NOT NULL DEFAULT 'active',
        note varchar(30) DEFAULT 'it''s \\\\ fine',
        score decimal(10,2) NOT NULL DEFAULT '1.50',
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        flags json DEFAULT (json_object('a', 1)),
        PRIMARY KEY (id),
        UNIQUE KEY customers_email_uq (email),
        KEY customers_status_idx (status)
      ) ENGINE=InnoDB;
      INSERT INTO ${S}.customers (email, name)
        WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 25)
        SELECT CONCAT('user', n, '@x.com'), CONCAT('User ', n) FROM seq;
      CREATE TABLE \`${MS}\`.\`Order Items\` (
        \`Order Id\` int NOT NULL,
        \`select\` int NOT NULL,
        qty decimal(10,2) NOT NULL DEFAULT 0,
        \`CustomerId\` int unsigned NULL,
        note varchar(10) NULL,
        PRIMARY KEY (\`Order Id\`, \`select\`),
        KEY \`Idx Qty\` (qty, \`select\`),
        UNIQUE KEY order_items_note_uq (note),
        CONSTRAINT \`fk,with comma\` FOREIGN KEY (\`CustomerId\`) REFERENCES ${S}.customers (id)
          ON UPDATE CASCADE ON DELETE SET NULL
      ) ENGINE=InnoDB;
      INSERT INTO \`${MS}\`.\`Order Items\` VALUES (1, 1, 2.5, 1, 'a'), (1, 2, 3, 2, 'b'), (2, 1, 1, NULL, NULL);
      CREATE VIEW ${S}.active_customers AS SELECT * FROM ${S}.customers WHERE status = 'active';
      CREATE TABLE ${S}.empty_t (id int PRIMARY KEY);
      CREATE TABLE ${S}.nopk (a int NOT NULL, b int, UNIQUE KEY (a));
      ANALYZE TABLE ${S}.customers;
    `);
  });

  afterAll(async () => {
    if (!admin) return;
    for (const db of [MS, S, CREATED]) {
      await exec(`DROP DATABASE IF EXISTS \`${db}\``).catch((e) => console.error("cleanup failed", db, e));
    }
    await admin.end();
  });

  // ── connection ────────────────────────────────────────────────────────
  it("testConnection succeeds with valid credentials", async () => {
    const r = await driver.testConnection(conn);
    expect(r).toMatchObject({ ok: true });
  });

  it("testConnection reports a bad password without throwing", async () => {
    const r = await driver.testConnection({ ...conn, password: "definitely-wrong" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Access denied/);
  });

  it("connects with SSL enabled against a self-signed server", async () => {
    const r = await driver.testConnection({ ...conn, ssl: true });
    expect(r).toMatchObject({ ok: true });
    const cipher = await driver.runQuery({ ...conn, ssl: true }, "SHOW STATUS LIKE 'Ssl_cipher'");
    expect(String(cipher.rows[0]?.[1])).not.toBe("");
  });

  // ── catalog ───────────────────────────────────────────────────────────
  it("listSchemas flags system databases", async () => {
    const byName = new Map((await driver.listSchemas(conn)).map((s) => [s.name, s.isSystem]));
    for (const sys of ["mysql", "information_schema", "performance_schema", "sys"]) {
      expect(byName.get(sys)).toBe(true);
    }
    expect(byName.get(S)).toBe(false);
    expect(byName.get(MS)).toBe(false);
  });

  it("listRelations returns kinds and size stats", async () => {
    const rels = await driver.listRelations(conn, S);
    const by = new Map(rels.map((r) => [r.name, r]));
    expect(by.get("customers")?.kind).toBe("table");
    expect(by.get("active_customers")?.kind).toBe("view");
    const t = by.get("customers")!;
    expect(t.approxRowCount).toBeGreaterThan(0);
    expect(t.dataBytes).toBeGreaterThan(0);
    expect(t.indexBytes).toBeGreaterThan(0);
    expect(t.totalBytes).toBe(t.dataBytes! + t.indexBytes!);
    expect(by.get("active_customers")?.totalBytes).toBeUndefined();
    expect(rels.every((r) => r.schema === S)).toBe(true);
    expect((await driver.listRelations(conn, MS)).map((r) => r.name)).toEqual(["Order Items"]);
  });

  it("getConnectionOverview returns server info", async () => {
    const o = await driver.getConnectionOverview(conn);
    expect(o.driver).toBe("mysql");
    expect(o.serverVersion).toMatch(/\d+\.\d+/);
    expect(o.currentDatabase).toBe(conn.database);
    expect(o.currentUser).toMatch(/^root@/);
    // ISO, in UTC, so the browser's `new Date()` reads it correctly.
    expect(o.serverTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(Math.abs(new Date(o.serverTime!).getTime() - Date.now())).toBeLessThan(5 * 60_000);
    expect(o.uptimeSeconds).toBeGreaterThan(0);
    expect(o.maxConnections).toBeGreaterThan(0);
    expect(o.databases.find((d) => d.name === S)).toMatchObject({ isSystem: false, relationCount: 4 });
    expect(o.databases.find((d) => d.name === "mysql")?.isSystem).toBe(true);
  });

  // ── describeTable ─────────────────────────────────────────────────────
  it("describeTable: columns, PK, unique, defaults as SQL expressions", async () => {
    const d = await driver.describeTable(conn, S, "customers");
    expect(d.kind).toBe("table");
    const col = (n: string) => d.columns.find((c) => c.name === n)!;
    expect(col("id")).toMatchObject({ isPrimaryKey: true, nullable: false, dataType: "int unsigned auto_increment" });
    expect(col("email")).toMatchObject({ isUnique: true, isPrimaryKey: false, nullable: false, dataType: "varchar(100)" });
    expect(col("name")).toMatchObject({ nullable: true, isUnique: false, default: null });
    // Literal defaults come back quoted so `DEFAULT ${default}` is valid SQL.
    expect(col("status").default).toBe("'active'");
    expect(col("note").default).toBe("'it''s \\\\ fine'");
    expect(col("score").default).toBe("1.50");
    expect(col("email").comment).toBe("Login email");
    expect(col("name").comment).toBeNull();
    expect(col("created_at")).toMatchObject({
      default: "CURRENT_TIMESTAMP",
      dataType: "timestamp on update CURRENT_TIMESTAMP",
    });
    expect(col("flags").default).toMatch(/^\(json_object\(.*'a',1\)\)$/);
    expect(d.indexes.map((i) => [i.name, i.columns, i.unique, i.primary])).toEqual([
      ["PRIMARY", ["id"], true, true],
      ["customers_email_uq", ["email"], true, false],
      ["customers_status_idx", ["status"], false, false],
    ]);
  });

  it("describeTable: a NOT NULL UNIQUE column is not reported as primary key", async () => {
    const d = await driver.describeTable(conn, S, "nopk");
    expect(d.columns.find((c) => c.name === "a")).toMatchObject({ isPrimaryKey: false, isUnique: true });
  });

  it("describeTable: composite PK, FKs with actions, quoted identifiers", async () => {
    const d = await driver.describeTable(conn, MS, "Order Items");
    expect(d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(["Order Id", "select"]);
    expect(d.columns.find((c) => c.name === "Order Id")!.isUnique).toBe(false);
    expect(d.columns.find((c) => c.name === "note")!.isUnique).toBe(true);
    expect(d.columns.find((c) => c.name === "qty")!.default).toBe("0.00");
    expect(d.foreignKeys).toEqual([
      {
        name: "fk,with comma",
        columns: ["CustomerId"],
        referencedSchema: S,
        referencedTable: "customers",
        referencedColumns: ["id"],
        onUpdate: "CASCADE",
        onDelete: "SET NULL",
      },
    ]);
    expect(d.indexes.find((i) => i.primary)!.columns).toEqual(["Order Id", "select"]);
    expect(d.indexes.find((i) => i.name === "Idx Qty")!.columns).toEqual(["qty", "select"]);
  });

  it("describeTable reports views", async () => {
    const d = await driver.describeTable(conn, S, "active_customers");
    expect(d.kind).toBe("view");
    expect(d.columns.length).toBe(8);
  });

  // ── runQuery ──────────────────────────────────────────────────────────
  it("runQuery SELECT returns columns + rows", async () => {
    const r = await driver.runQuery(conn, `SELECT id, email FROM ${S}.customers ORDER BY id LIMIT 3`);
    expect(r.columns).toEqual([
      { name: "id", dataType: "int" },
      { name: "email", dataType: "varchar" },
    ]);
    expect(r.rows).toEqual([
      [1, "user1@x.com"],
      [2, "user2@x.com"],
      [3, "user3@x.com"],
    ]);
    expect(r).toMatchObject({ rowCount: 3, affectedRows: null, truncated: false });
  });

  it("runQuery DML reports affectedRows; DDL works", async () => {
    await driver.runQuery(conn, `CREATE TABLE ${S}.dml_t (id int, v text)`);
    expect((await driver.runQuery(conn, `INSERT INTO ${S}.dml_t VALUES (1,'a'),(2,'b'),(3,'c')`)).affectedRows).toBe(3);
    expect((await driver.runQuery(conn, `UPDATE ${S}.dml_t SET v = 'z' WHERE id > 1`)).affectedRows).toBe(2);
    expect((await driver.runQuery(conn, `DELETE FROM ${S}.dml_t`)).affectedRows).toBe(3);
    await driver.runQuery(conn, `DROP TABLE ${S}.dml_t`);
  });

  it("runQuery surfaces syntax errors with the position", async () => {
    await expect(driver.runQuery(conn, "SELEC 1")).rejects.toThrow(/SQL syntax.*near 'SELEC 1' at line 1/);
    await expect(
      driver.runQuery(conn, `INSERT INTO ${S}.customers (email) VALUES ('user1@x.com')`),
    ).rejects.toThrow(/Duplicate entry 'user1@x.com'/);
  });

  it("runQuery honors the schema option (USE) with a mixed-case database", async () => {
    const r = await driver.runQuery(conn, "SELECT COUNT(*) AS n FROM `Order Items`", { schema: MS });
    expect(r.rows).toEqual([[3]]);
  });

  it("runQuery runs multi-statement scripts and returns the last result set", async () => {
    const r = await driver.runQuery(conn, "SELECT 1 AS a; SELECT 2 AS b, 'x' AS c;");
    expect(r.columns.map((c) => c.name)).toEqual(["b", "c"]);
    expect(r.rows).toEqual([[2, "x"]]);
    const dml = await driver.runQuery(
      conn,
      `CREATE TEMPORARY TABLE t_multi (id int); INSERT INTO t_multi VALUES (1),(2); INSERT INTO t_multi VALUES (3)`,
      { schema: S },
    );
    expect(dml).toMatchObject({ columns: [], affectedRows: 3 });
    // Session state set by an earlier statement applies to the later one.
    const mixed = await driver.runQuery(conn, "SET @x := 41; SELECT @x + 1 AS n");
    expect(mixed.rows).toEqual([[42]]);
  });

  it("runQuery supports parameters", async () => {
    const r = await driver.runQuery(conn, "SELECT ? + 1 AS n", { params: [41] });
    expect(r.rows).toEqual([[42]]);
  });

  it("runQuery caps huge results and flags them as truncated", async () => {
    const big = `SET SESSION cte_max_recursion_depth = 10000;
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < %N%) SELECT n FROM seq`;
    const r = await driver.runQuery(conn, big.replace("%N%", "6000"));
    expect(r.rows.length).toBe(5000);
    expect(r.truncated).toBe(true);
    const exact = await driver.runQuery(conn, big.replace("%N%", "5000"));
    expect(exact.rows.length).toBe(5000);
    expect(exact.truncated).toBe(false);
  });

  it("runQuery converts types faithfully", async () => {
    await exec(`CREATE TABLE ${S}.types_t (
      d date, dt datetime(6), ts timestamp(3) NULL, t time, y year,
      dec_v decimal(30,10), big bigint, ubig bigint unsigned, f double,
      j json, u char(36), bin varbinary(10), blb blob, txt text,
      b1 bit(1), b8 bit(8), bool_v boolean, e enum('a','b'), nothing int
    )`);
    await exec(`INSERT INTO ${S}.types_t VALUES (
      '2024-01-15', '2024-01-15 10:30:00.123456', '2024-01-15 10:30:00.123', '23:59:58', 2024,
      '12345678901234567890.1234567890', 9223372036854775807, 18446744073709551615, 1.5,
      '{"a": 1, "b": [1, 2]}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', X'010203', X'0102', 'hello',
      b'1', b'10000001', TRUE, 'b', NULL)`);
    const r = await driver.runQuery(conn, `SELECT * FROM ${S}.types_t`);
    const row = Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0]![i]]));
    expect(row).toEqual({
      d: "2024-01-15",
      dt: "2024-01-15 10:30:00.123456",
      ts: "2024-01-15 10:30:00.123",
      t: "23:59:58",
      y: 2024,
      dec_v: "12345678901234567890.1234567890",
      big: "9223372036854775807",
      ubig: "18446744073709551615",
      f: 1.5,
      j: JSON.stringify({ a: 1, b: [1, 2] }),
      u: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      bin: { __binary: true, bytes: 3 },
      blb: { __binary: true, bytes: 2 },
      txt: "hello",
      b1: 1,
      b8: 129,
      bool_v: 1,
      e: "b",
      nothing: null,
    });
    const types = Object.fromEntries(r.columns.map((c) => [c.name, c.dataType]));
    expect(types).toMatchObject({ d: "date", dt: "datetime", big: "bigint", bin: "varbinary", blb: "blob", txt: "text", b1: "bit", dec_v: "decimal" });
    // Small BIGINTs stay numbers.
    expect((await driver.runQuery(conn, "SELECT COUNT(*) AS n FROM mysql.user")).rows[0]![0]).toBeTypeOf("number");
  });

  // ── fetchTableData / iterateTable ─────────────────────────────────────
  it("fetchTableData paginates, orders, filters and flags more rows", async () => {
    const page = await driver.fetchTableData(conn, S, "customers", {
      limit: 10,
      offset: 5,
      orderBy: [{ column: "id", direction: "asc" }],
    });
    expect(page.rows.map((r) => r[0])).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(page).toMatchObject({ rowCount: 10, truncated: true });
    const last = await driver.fetchTableData(conn, S, "customers", {
      limit: 10,
      offset: 20,
      orderBy: [{ column: "id", direction: "asc" }],
    });
    expect(last).toMatchObject({ rowCount: 5, truncated: false });
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
    // The raw WHERE can't smuggle in a second statement.
    await expect(
      driver.fetchTableData(conn, S, "customers", { where: "1=1; DROP TABLE empty_t" }),
    ).rejects.toThrow(/syntax/);
    const r = await driver.fetchTableData(conn, S, "customers", {
      limit: 1,
      orderBy: [{ column: "id", direction: "desc; DROP TABLE x" as "desc" }],
    });
    expect(r.rows.length).toBe(1);
  });

  it("iterateTable yields batches, honors where and handles empty tables", async () => {
    const batches = await collectBatches(driver, conn, { schema: S, name: "customers", batchSize: 10 });
    expect(batches.map((b) => b.rows.length)).toEqual([10, 10, 5]);
    expect(batches[0]!.columns.map((c) => c.name)).toEqual([
      "id", "email", "name", "status", "note", "score", "created_at", "flags",
    ]);
    const filtered = await collectBatches(driver, conn, { schema: S, name: "customers", where: "id <= 3" });
    expect(filtered.flatMap((b) => b.rows).length).toBe(3);
    const empty = await collectBatches(driver, conn, { schema: S, name: "empty_t" });
    expect(empty).toEqual([{ columns: [{ name: "id", dataType: "int" }], rows: [] }]);
    const mixed = await collectBatches(driver, conn, { schema: MS, name: "Order Items", batchSize: 2 });
    expect(mixed.map((b) => b.rows.length)).toEqual([2, 1]);
    await expect(
      collectBatches(driver, conn, { schema: S, name: "customers", where: "nope = 1" }),
    ).rejects.toThrow(/Unknown column 'nope'/);
  });

  it("iterateTable can be abandoned early without hanging or leaking", async () => {
    await exec(`CREATE TABLE ${S}.big_t (id int PRIMARY KEY, pad varchar(200))`);
    await exec(`SET SESSION cte_max_recursion_depth = 100000`);
    await exec(`INSERT INTO ${S}.big_t WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 50000)
                SELECT n, REPEAT('x', 200) FROM seq`);
    const before = Number(await scalar("SELECT COUNT(*) FROM information_schema.processlist"));
    const started = Date.now();
    for await (const b of driver.iterateTable(conn, { schema: S, name: "big_t", batchSize: 100 })) {
      expect(b.rows.length).toBe(100);
      break;
    }
    expect(Date.now() - started).toBeLessThan(10_000);
    // Give the server a moment to reap the closed socket.
    await new Promise((r) => setTimeout(r, 300));
    const after = Number(await scalar("SELECT COUNT(*) FROM information_schema.processlist"));
    expect(after).toBeLessThanOrEqual(before);
  });

  // ── DDL generation round-trip ─────────────────────────────────────────
  it("generateCreateTableSql round-trips (auto_increment, defaults, composite PK, quoting)", async () => {
    for (const [schema, name] of [
      [S, "customers"],
      [MS, "Order Items"],
    ] as const) {
      const src = await driver.describeTable(conn, schema, name);
      const ddl = driver.generateCreateTableSql(conn, schema, `${name} copy`, src.columns);
      await exec(ddl);
      const copy = await driver.describeTable(conn, schema, `${name} copy`);
      expect(copy.columns.map((c) => [c.name, c.dataType, c.nullable, c.isPrimaryKey, c.default])).toEqual(
        src.columns.map((c) => [c.name, c.dataType, c.nullable, c.isPrimaryKey, c.default]),
      );
    }
    await exec(`INSERT INTO ${S}.\`customers copy\` (email) VALUES ('x@y.z')`);
    expect(await scalar(`SELECT note FROM ${S}.\`customers copy\``)).toBe("it's \\ fine");
  });

  // ── DDL helpers ───────────────────────────────────────────────────────
  it("createSchema with charset/collation, dropSchema", async () => {
    await driver.createSchema(conn, { name: CREATED, charset: "latin1", collation: "latin1_swedish_ci" });
    const [rows] = (await admin.query(
      `SELECT default_character_set_name, default_collation_name FROM information_schema.schemata WHERE schema_name = ?`,
      [CREATED],
    )) as [Array<Record<string, string>>, unknown];
    expect(Object.values(rows[0]!)).toEqual(["latin1", "latin1_swedish_ci"]);
    await driver.dropSchema(conn, CREATED);
    expect((await driver.listSchemas(conn)).some((s) => s.name === CREATED)).toBe(false);
  });

  it("createTable with FKs, indexes, defaults, enum and quoted names; index + drop helpers", async () => {
    await driver.createTable(conn, {
      schema: MS,
      name: "Parent Table",
      columns: [
        { name: "Id", dataType: "int", nullable: false, primaryKey: true },
        { name: "order", dataType: "text", nullable: true, primaryKey: false },
      ],
    });
    await driver.createTable(conn, {
      schema: MS,
      name: "Child Table",
      columns: [
        { name: "id", dataType: "int auto_increment", nullable: false, primaryKey: true },
        { name: "ParentId", dataType: "int", nullable: true, primaryKey: false },
        { name: "status", dataType: "ENUM('a', 'b')", nullable: false, primaryKey: false, default: "'a'" },
        { name: "created", dataType: "datetime", nullable: false, primaryKey: false, default: "CURRENT_TIMESTAMP" },
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
      indexes: [{ columns: ["status"] }, { name: "Uq Status Created", columns: ["status", "created"], unique: true }],
    });
    const d = await driver.describeTable(conn, MS, "Child Table");
    expect(d.foreignKeys[0]).toMatchObject({ name: "fk_child_parent", onDelete: "CASCADE", referencedTable: "Parent Table" });
    expect(d.indexes.map((i) => i.name).sort()).toEqual(
      ["PRIMARY", "Uq Status Created", "fk_child_parent", "idx_Child Table_status"].sort(),
    );
    expect(d.columns.find((c) => c.name === "status")).toMatchObject({ dataType: "enum('a','b')", default: "'a'" });

    await driver.createIndex(conn, { schema: MS, table: "Child Table", name: "Idx Extra", columns: ["created"] });
    expect((await driver.describeTable(conn, MS, "Child Table")).indexes.some((i) => i.name === "Idx Extra")).toBe(true);
    await driver.dropIndex(conn, { schema: MS, table: "Child Table", name: "Idx Extra" });
    expect((await driver.describeTable(conn, MS, "Child Table")).indexes.some((i) => i.name === "Idx Extra")).toBe(false);

    await exec(`INSERT INTO \`${MS}\`.\`Child Table\` (ParentId, status) VALUES (NULL, 'a'), (NULL, 'b')`);
    await driver.truncateTable(conn, MS, "Child Table");
    expect(await scalar(`SELECT COUNT(*) FROM \`${MS}\`.\`Child Table\``)).toBe(0);
    // MySQL can't truncate a table referenced by an FK (no CASCADE support).
    await expect(driver.truncateTable(conn, MS, "Parent Table", { cascade: true })).rejects.toThrow(/foreign key/i);

    await driver.dropTable(conn, MS, "Child Table");
    await driver.dropTable(conn, MS, "Parent Table");
    expect((await driver.listRelations(conn, MS)).map((r) => r.name)).toEqual(["Order Items", "Order Items copy"]);
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
    expect((await driver.listRelations(conn, S)).map((r) => r.name)).not.toContain("atomic_t");
  });
});
