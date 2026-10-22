// Integration tests for the SQL Server adapter. Skipped unless
// DV_TEST_MSSQL_URL is set, e.g.
// DV_TEST_MSSQL_URL=mssql://sa:Test_Passw0rd!@127.0.0.1:11433/master
// The suite creates its own database (dvt_web_ms) and drops it afterwards.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import sql from "mssql";
import { mssqlDriver as driver } from "./mssql";
import { collectBatches, connFromUrl, UNUSED_URL } from "./test-helpers";

// Run in a non-UTC zone so a driver that shifts dates by the Node process
// timezone fails here regardless of the machine's TZ (forks pool: per file).
process.env.TZ = "America/Argentina/Buenos_Aires";

const URL_ = process.env.DV_TEST_MSSQL_URL;

const DB = "dvt_web_ms";
const S = "dvt_web_s";
const MS = "dvt_web_MySchema"; // mixed case
const CREATED = "dvt_web_s_created";

describe.skipIf(!URL_)("mssql adapter (integration)", () => {
  const base = connFromUrl(URL_ ?? UNUSED_URL, "mssql");
  const conn = { ...base, database: DB };
  let admin: sql.ConnectionPool;
  const exec = async (text: string) => (await admin.request().query(text)).recordset;
  const scalar = async (text: string) => {
    const req = admin.request();
    req.arrayRowMode = true;
    const r = await req.query(text);
    return (r.recordset as unknown as unknown[][])[0]?.[0];
  };

  beforeAll(async () => {
    const poolCfg = (database: string): sql.config => ({
      server: base.host,
      port: base.port,
      user: base.username,
      password: base.password,
      database,
      options: { encrypt: false, trustServerCertificate: true },
    });
    const master = await new sql.ConnectionPool(poolCfg("master")).connect();
    await master.request().query(`
      IF DB_ID('${DB}') IS NOT NULL BEGIN
        ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE [${DB}];
      END;
      CREATE DATABASE [${DB}];`);
    await master.close();
    admin = await new sql.ConnectionPool(poolCfg(DB)).connect();
    await exec(`CREATE SCHEMA [${S}]`);
    await exec(`CREATE SCHEMA [${MS}]`);
    await exec(`
      CREATE TABLE [${S}].customers (
        id int IDENTITY(1,1) NOT NULL CONSTRAINT pk_shared PRIMARY KEY,
        email nvarchar(100) NOT NULL CONSTRAINT customers_email_uq UNIQUE,
        name nvarchar(max) NULL,
        status varchar(20) NOT NULL DEFAULT 'active',
        score decimal(10,2) NOT NULL DEFAULT 1.5,
        created datetime2(3) NULL DEFAULT SYSUTCDATETIME()
      );
      CREATE INDEX customers_status_idx ON [${S}].customers (status);
      WITH seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 25)
      INSERT INTO [${S}].customers (email, name)
        SELECT CONCAT('user', n, '@x.com'), CONCAT('User ', n) FROM seq;
      CREATE TABLE [${MS}].[Order Items] (
        [Order Id] int NOT NULL,
        [select] int NOT NULL,
        qty decimal(10,2) NOT NULL DEFAULT 0,
        [CustomerId] int NULL,
        note varchar(10) NULL,
        CONSTRAINT pk_shared PRIMARY KEY ([Order Id], [select]),
        CONSTRAINT [fk,with comma] FOREIGN KEY ([CustomerId]) REFERENCES [${S}].customers (id)
          ON UPDATE CASCADE ON DELETE SET NULL
      );
      CREATE INDEX [Idx Qty] ON [${MS}].[Order Items] (qty, [select]);
      CREATE UNIQUE INDEX order_items_note_uq ON [${MS}].[Order Items] (note) WHERE note IS NOT NULL;
      INSERT INTO [${MS}].[Order Items] VALUES (1, 1, 2.5, 1, 'a'), (1, 2, 3, 2, 'b'), (2, 1, 1, NULL, NULL);
      CREATE TABLE [${S}].empty_t (id int PRIMARY KEY);
      -- Composite PK whose first column has lots of ties.
      CREATE TABLE [${S}].ties (a int NOT NULL, b int NOT NULL, PRIMARY KEY (a, b));
      WITH seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 30)
      INSERT INTO [${S}].ties SELECT n % 2, n FROM seq;
    `);
    await exec(`CREATE VIEW [${S}].active_customers AS SELECT * FROM [${S}].customers WHERE status = 'active'`);
    await exec(`EXEC sp_addextendedproperty 'MS_Description', N'Login email',
      'SCHEMA', '${S}', 'TABLE', 'customers', 'COLUMN', 'email'`);
  });

  afterAll(async () => {
    if (admin) await admin.close();
    const master = await new sql.ConnectionPool({
      server: base.host,
      port: base.port,
      user: base.username,
      password: base.password,
      database: "master",
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    await master
      .request()
      .query(`IF DB_ID('${DB}') IS NOT NULL BEGIN
        ALTER DATABASE [${DB}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
        DROP DATABASE [${DB}];
      END`)
      .catch(() => undefined);
    await master.close();
  });

  // ── connection ────────────────────────────────────────────────────────
  it("testConnection succeeds (plain local connection)", async () => {
    expect(await driver.testConnection(conn)).toMatchObject({ ok: true });
  });

  it("testConnection reports a bad password without throwing", async () => {
    const r = await driver.testConnection({ ...conn, password: "definitely-wrong" });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Login failed/);
  });

  it("connects with SSL enabled against the self-signed certificate", async () => {
    expect(await driver.testConnection({ ...conn, ssl: true })).toMatchObject({ ok: true });
    // …unless the operator explicitly asks for certificate verification.
    const strict = await driver.testConnection({
      ...conn,
      ssl: true,
      options: { trustServerCertificate: "false" },
    });
    expect(strict.ok).toBe(false);
  });

  // ── catalog ───────────────────────────────────────────────────────────
  it("listSchemas flags system schemas", async () => {
    const byName = new Map((await driver.listSchemas(conn)).map((s) => [s.name, s.isSystem]));
    expect(byName.get("sys")).toBe(true);
    expect(byName.get("INFORMATION_SCHEMA")).toBe(true);
    expect(byName.get("db_owner")).toBe(true);
    expect(byName.get("dbo")).toBe(false);
    expect(byName.get(S)).toBe(false);
    expect(byName.get(MS)).toBe(false);
  });

  it("listRelations returns kinds and size stats", async () => {
    const rels = await driver.listRelations(conn, S);
    const by = new Map(rels.map((r) => [r.name, r]));
    expect(by.get("customers")?.kind).toBe("table");
    expect(by.get("active_customers")?.kind).toBe("view");
    const t = by.get("customers")!;
    expect(t.approxRowCount).toBe(25);
    expect(t.dataBytes).toBeGreaterThan(0);
    expect(t.indexBytes).toBeGreaterThan(0);
    expect(t.totalBytes).toBe(t.dataBytes! + t.indexBytes!);
    expect(by.get("active_customers")?.totalBytes).toBeUndefined();
    expect(rels.every((r) => r.schema === S)).toBe(true);
    expect((await driver.listRelations(conn, MS)).map((r) => r.name)).toEqual(["Order Items"]);
    // Without a schema filter every schema is listed.
    const all = await driver.listRelations(conn);
    expect(all.some((r) => r.schema === MS) && all.some((r) => r.schema === S)).toBe(true);
  });

  it("getConnectionOverview returns server info", async () => {
    const o = await driver.getConnectionOverview(conn);
    expect(o.driver).toBe("mssql");
    expect(o.serverVersion).toMatch(/Microsoft SQL Server/);
    expect(o.currentDatabase).toBe(DB);
    expect(o.currentUser).toBe(conn.username);
    expect(Math.abs(new Date(o.serverTime!).getTime() - Date.now())).toBeLessThan(5 * 60_000);
    expect(o.uptimeSeconds).toBeGreaterThan(0);
    expect(o.maxConnections).toBeGreaterThan(0);
    expect(o.activeConnections).toBeGreaterThan(0);
    expect(o.databases.find((d) => d.name === DB)).toMatchObject({ isSystem: false });
    expect(o.databases.find((d) => d.name === "master")?.isSystem).toBe(true);
  });

  // ── describeTable ─────────────────────────────────────────────────────
  it("describeTable: full types, PK, unique, defaults, nullability", async () => {
    const d = await driver.describeTable(conn, S, "customers");
    expect(d.kind).toBe("table");
    const col = (n: string) => d.columns.find((c) => c.name === n)!;
    expect(d.columns.map((c) => c.name)).toEqual(["id", "email", "name", "status", "score", "created"]);
    expect(col("id")).toMatchObject({ isPrimaryKey: true, nullable: false, dataType: "int" });
    expect(col("email")).toMatchObject({ isUnique: true, nullable: false, dataType: "nvarchar(100)" });
    expect(col("name")).toMatchObject({ nullable: true, isUnique: false, dataType: "nvarchar(max)" });
    expect(col("status")).toMatchObject({ dataType: "varchar(20)", default: "('active')" });
    expect(col("score")).toMatchObject({ dataType: "decimal(10,2)", default: "((1.5))" });
    expect(col("created")).toMatchObject({ dataType: "datetime2(3)", default: "(sysutcdatetime())" });
    expect(col("email").comment).toBe("Login email");
    expect(col("name").comment).toBeNull();
    expect(d.indexes.map((i) => [i.name, i.columns, i.unique, i.primary])).toEqual([
      ["pk_shared", ["id"], true, true],
      ["customers_email_uq", ["email"], true, false],
      ["customers_status_idx", ["status"], false, false],
    ]);
  });

  it("describeTable: composite PK, FKs with actions, quoted identifiers, shared constraint names", async () => {
    const d = await driver.describeTable(conn, MS, "Order Items");
    // pk_shared also exists in the other schema: no duplicated columns.
    expect(d.columns.map((c) => c.name)).toEqual(["Order Id", "select", "qty", "CustomerId", "note"]);
    expect(d.columns.filter((c) => c.isPrimaryKey).map((c) => c.name)).toEqual(["Order Id", "select"]);
    expect(d.columns.find((c) => c.name === "Order Id")!.isUnique).toBe(false);
    // A filtered unique index doesn't make the column unique.
    expect(d.columns.find((c) => c.name === "note")!.isUnique).toBe(false);
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
    expect(d.columns.length).toBe(6);
  });

  // ── runQuery ──────────────────────────────────────────────────────────
  it("runQuery SELECT returns columns + rows and no affectedRows", async () => {
    const r = await driver.runQuery(conn, `SELECT TOP 3 id, email FROM [${S}].customers ORDER BY id`);
    expect(r.columns.map((c) => c.name)).toEqual(["id", "email"]);
    expect(r.rows).toEqual([
      [1, "user1@x.com"],
      [2, "user2@x.com"],
      [3, "user3@x.com"],
    ]);
    expect(r).toMatchObject({ rowCount: 3, affectedRows: null, truncated: false });
    // Unnamed and duplicate column names keep their positions.
    const odd = await driver.runQuery(conn, "SELECT 1, 2 AS a, 3 AS a");
    expect(odd.columns.map((c) => c.name)).toEqual(["", "a", "a"]);
    expect(odd.rows).toEqual([[1, 2, 3]]);
  });

  it("runQuery DML reports affectedRows; DDL works", async () => {
    await driver.runQuery(conn, `CREATE TABLE [${S}].dml_t (id int, v nvarchar(10))`);
    expect((await driver.runQuery(conn, `INSERT INTO [${S}].dml_t VALUES (1,'a'),(2,'b'),(3,'c')`)).affectedRows).toBe(3);
    expect((await driver.runQuery(conn, `UPDATE [${S}].dml_t SET v = 'z' WHERE id > 1`)).affectedRows).toBe(2);
    expect((await driver.runQuery(conn, `DELETE FROM [${S}].dml_t`)).affectedRows).toBe(3);
    await driver.runQuery(conn, `DROP TABLE [${S}].dml_t`);
  });

  it("runQuery surfaces useful error messages", async () => {
    await expect(driver.runQuery(conn, "SELECT * FORM x")).rejects.toThrow(/Incorrect syntax near/);
    await expect(driver.runQuery(conn, "SELECT 1;\nSELECT * FROM\nnope_table")).rejects.toThrow(
      /Invalid object name 'nope_table'.\nLine 2/,
    );
    // The real cause comes in an earlier message than "See previous errors."
    await expect(
      driver.runQuery(conn, `CREATE TABLE [${S}].bad_fk (id int CONSTRAINT fkx REFERENCES [${S}].nope_tbl (id))`),
    ).rejects.toThrow(/references invalid table/);
  });

  it("runQuery ignores the schema option instead of issuing USE <schema>", async () => {
    const r = await driver.runQuery(conn, `SELECT COUNT(*) FROM [${MS}].[Order Items]`, { schema: MS });
    expect(r.rows).toEqual([[3]]);
  });

  it("runQuery: multiple statements return the last result set; GO batches; EXPLAIN", async () => {
    const r = await driver.runQuery(conn, "SELECT 1 AS a; SELECT 2 AS b, 'x' AS c");
    expect(r.columns.map((c) => c.name)).toEqual(["b", "c"]);
    expect(r.rows).toEqual([[2, "x"]]);
    const dml = await driver.runQuery(
      conn,
      `CREATE TABLE #t (id int); INSERT INTO #t VALUES (1),(2); INSERT INTO #t VALUES (3)`,
    );
    expect(dml).toMatchObject({ columns: [], affectedRows: 3 });
    // GO separates batches that must run alone (CREATE VIEW / PROCEDURE).
    const script = await driver.runQuery(
      conn,
      `CREATE VIEW [${S}].go_view AS SELECT 1 AS one\nGO\nSELECT * FROM [${S}].go_view\nGO\nDROP VIEW [${S}].go_view`,
    );
    expect(script.rows).toEqual([[1]]);
    // Session state (temp tables) carries over between GO batches.
    const temp = await driver.runQuery(conn, "CREATE TABLE #g (id int)\ngo\nINSERT INTO #g VALUES (7)\nGO\nSELECT * FROM #g");
    expect(temp.rows).toEqual([[7]]);
    // What the editor's EXPLAIN sends on SQL Server.
    const plan = await driver.runQuery(conn, `SET SHOWPLAN_TEXT ON;\nSELECT * FROM [${S}].customers WHERE id = 1`);
    expect(plan.columns.map((c) => c.name)).toEqual(["StmtText"]);
    expect(String(plan.rows[0]![0])).toMatch(/Clustered Index Seek|Index Seek/);
    // The editor now sends SHOWPLAN_ALL; the plan rows come back, nothing runs.
    const planAll = await driver.runQuery(
      conn,
      `SET SHOWPLAN_ALL ON;\nDELETE FROM [${S}].customers WHERE id = 1`,
    );
    expect(planAll.columns.map((c) => c.name)).toEqual(expect.arrayContaining(["StmtText", "PhysicalOp", "EstimateRows"]));
    expect(planAll.rows.length).toBeGreaterThan(1);
    expect(await scalar(`SELECT COUNT(*) FROM [${S}].customers WHERE id = 1`)).toBe(1);
  });

  it("runQuery caps huge results and flags them as truncated", async () => {
    const q = (n: number) =>
      `WITH seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < ${n}) SELECT n FROM seq OPTION (MAXRECURSION 0)`;
    const r = await driver.runQuery(conn, q(6000));
    expect(r.rows.length).toBe(5000);
    expect(r.truncated).toBe(true);
    const exact = await driver.runQuery(conn, q(5000));
    expect(exact.rows.length).toBe(5000);
    expect(exact.truncated).toBe(false);
  });

  it("runQuery converts types faithfully", async () => {
    const r = await driver.runQuery(
      conn,
      `SELECT CAST('2024-01-15' AS date) d,
              CAST('2024-01-15 10:30:00.123' AS datetime2(3)) dt2,
              CAST('2024-01-15 10:30:00' AS datetime) dt,
              CAST('2024-01-15 10:30:00 +03:00' AS datetimeoffset) dto,
              CAST('23:59:58' AS time) t,
              CAST(12345.6789 AS decimal(10,4)) dec,
              CAST(9223372036854775807 AS bigint) big,
              CAST(1 AS bit) b1, CAST(0 AS bit) b0,
              CAST('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AS uniqueidentifier) u,
              CAST(0x010203 AS varbinary(10)) bin,
              CAST(1.5 AS money) m,
              N'héllo' s,
              CAST(NULL AS int) n`,
    );
    const row = Object.fromEntries(r.columns.map((c, i) => [c.name, r.rows[0]![i]]));
    expect(row).toEqual({
      d: "2024-01-15",
      dt2: "2024-01-15 10:30:00.123",
      dt: "2024-01-15 10:30:00",
      dto: "2024-01-15T07:30:00.000Z",
      t: "23:59:58",
      dec: 12345.6789,
      big: "9223372036854775807",
      b1: true,
      b0: false,
      u: "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
      bin: { __binary: true, bytes: 3 },
      m: 1.5,
      s: "héllo",
      n: null,
    });
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
    const injected = await driver.fetchTableData(conn, S, "customers", {
      limit: "1; DROP TABLE x" as unknown as number,
      orderBy: [{ column: "id", direction: "desc; DROP TABLE x" as "desc" }],
    });
    expect(injected.rows.length).toBe(100 > 25 ? 25 : 100);
  });

  it("iterateTable yields every row once, honors where and handles empty tables", async () => {
    const batches = await collectBatches(driver, conn, { schema: S, name: "customers", batchSize: 10 });
    expect(batches.map((b) => b.rows.length)).toEqual([10, 10, 5]);
    expect(batches[0]!.columns.map((c) => c.name)).toEqual(["id", "email", "name", "status", "score", "created"]);
    const ties = (await collectBatches(driver, conn, { schema: S, name: "ties", batchSize: 7 })).flatMap((b) => b.rows);
    expect(new Set(ties.map((r) => `${r[0]}-${r[1]}`)).size).toBe(30);
    expect(ties.length).toBe(30);
    const filtered = await collectBatches(driver, conn, { schema: S, name: "customers", where: "id <= 3" });
    expect(filtered.flatMap((b) => b.rows).length).toBe(3);
    const empty = await collectBatches(driver, conn, { schema: S, name: "empty_t" });
    expect(empty).toEqual([{ columns: [{ name: "id", dataType: "Int" }], rows: [] }]);
    const mixed = await collectBatches(driver, conn, { schema: MS, name: "Order Items", batchSize: 2 });
    expect(mixed.map((b) => b.rows.length)).toEqual([2, 1]);
    await expect(
      collectBatches(driver, conn, { schema: S, name: "customers", where: "nope = 1" }),
    ).rejects.toThrow(/Invalid column name 'nope'/);
  });

  it("iterateTable can be abandoned early", async () => {
    const started = Date.now();
    for await (const b of driver.iterateTable(conn, { schema: S, name: "customers", batchSize: 5 })) {
      expect(b.rows.length).toBe(5);
      break;
    }
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  // ── DDL generation round-trip ─────────────────────────────────────────
  it("generateCreateTableSql round-trips (lengths, precision, defaults, composite PK, quoting)", async () => {
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
    // A 100-char email still fits (information_schema's bare "nvarchar"
    // used to recreate it as nvarchar(1)).
    await exec(`INSERT INTO [${S}].[customers copy] (id, email) VALUES (1, REPLICATE(N'x', 100))`);
  });

  // ── DDL helpers ───────────────────────────────────────────────────────
  it("createSchema / dropSchema", async () => {
    await driver.createSchema(conn, { name: CREATED });
    expect((await driver.listSchemas(conn)).some((s) => s.name === CREATED)).toBe(true);
    await driver.dropSchema(conn, CREATED);
    expect((await driver.listSchemas(conn)).some((s) => s.name === CREATED)).toBe(false);
  });

  it("createTable with FKs, indexes, defaults, enum CHECK and quoted names; index + drop helpers", async () => {
    await driver.createTable(conn, {
      schema: MS,
      name: "Parent Table",
      columns: [
        { name: "Id", dataType: "int", nullable: false, primaryKey: true },
        { name: "order", dataType: "nvarchar(50)", nullable: true, primaryKey: false },
      ],
    });
    await driver.createTable(conn, {
      schema: MS,
      name: "Child Table",
      columns: [
        { name: "id", dataType: "int identity(1,1)", nullable: false, primaryKey: true },
        { name: "ParentId", dataType: "int", nullable: true, primaryKey: false },
        // What the create-table modal emits for an enum column.
        { name: "status", dataType: "nvarchar(255) CHECK ([status] IN ('a', 'b'))", nullable: false, primaryKey: false, default: "'a'" },
        { name: "created", dataType: "datetime2", nullable: false, primaryKey: false, default: "SYSUTCDATETIME()" },
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
    expect(d.foreignKeys[0]).toMatchObject({ name: "fk_child_parent", onDelete: "CASCADE", onUpdate: "NO ACTION", referencedTable: "Parent Table" });
    expect(d.indexes.map((i) => i.name)).toEqual(expect.arrayContaining(["Uq Status Created", "idx_Child Table_ParentId"]));
    expect(d.columns.find((c) => c.name === "status")).toMatchObject({ dataType: "nvarchar(255)", default: "('a')" });
    await exec(`INSERT INTO [${MS}].[Parent Table] VALUES (1, 'x')`);
    await exec(`INSERT INTO [${MS}].[Child Table] (ParentId) VALUES (1)`);
    await expect(exec(`INSERT INTO [${MS}].[Child Table] (ParentId, status) VALUES (1, 'zzz')`)).rejects.toThrow(/CHECK constraint/);

    await driver.createIndex(conn, { schema: MS, table: "Child Table", name: "Idx Extra", columns: ["created"] });
    expect((await driver.describeTable(conn, MS, "Child Table")).indexes.some((i) => i.name === "Idx Extra")).toBe(true);
    await driver.dropIndex(conn, { schema: MS, table: "Child Table", name: "Idx Extra" });
    expect((await driver.describeTable(conn, MS, "Child Table")).indexes.some((i) => i.name === "Idx Extra")).toBe(false);

    await driver.truncateTable(conn, MS, "Child Table");
    expect(await scalar(`SELECT COUNT(*) FROM [${MS}].[Child Table]`)).toBe(0);
    // SQL Server can't truncate a table referenced by an FK, nor drop it.
    await expect(driver.truncateTable(conn, MS, "Parent Table", { cascade: true })).rejects.toThrow(/FOREIGN KEY/);
    await expect(driver.dropTable(conn, MS, "Parent Table")).rejects.toThrow(/FOREIGN KEY/);
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
