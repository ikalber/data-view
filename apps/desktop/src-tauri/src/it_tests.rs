//! Integration tests against real servers. Each test is skipped (passes with
//! a note on stderr) unless its env var is set:
//!
//!   DV_TEST_PG_URL=postgres://postgres:test@127.0.0.1:15432/postgres
//!   DV_TEST_MYSQL_URL=mysql://root:test@127.0.0.1:13306/mysql
//!   DV_TEST_MSSQL_URL=mssql://sa:Test_Passw0rd!@127.0.0.1:11433/master
//!
//! Every object created is prefixed with `dvt_rs_` and dropped afterwards.

use crate::db;
use crate::export::{self, ExportDatabaseOptions, ExportFormat, ExportTableOptions};
use crate::model::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `scheme://user:pass@host:port/db` → ResolvedConnection.
fn conn_from_env(var: &str, driver: DriverKind) -> Option<ResolvedConnection> {
    let url = std::env::var(var).ok().filter(|s| !s.is_empty())?;
    let rest = url.split_once("://")?.1;
    let (auth, hostpart) = rest.rsplit_once('@')?;
    let (user, pass) = auth.split_once(':').unwrap_or((auth, ""));
    let (hp, db) = hostpart.split_once('/').unwrap_or((hostpart, ""));
    let (host, port) = hp.rsplit_once(':')?;
    Some(ResolvedConnection {
        id: "it".into(),
        driver,
        host: host.into(),
        port: port.parse().ok()?,
        database: percent_decode(db.split('?').next().unwrap_or("")),
        username: percent_decode(user),
        password: percent_decode(pass),
        ssl: false,
        options: HashMap::new(),
    })
}

macro_rules! require_conn {
    ($var:expr, $driver:expr) => {
        match conn_from_env($var, $driver) {
            Some(c) => c,
            None => {
                eprintln!("skipping: {} not set", $var);
                return;
            }
        }
    };
}

fn col(name: &str, ty: &str, nullable: bool, pk: bool, default: Option<&str>) -> CreateTableColumn {
    CreateTableColumn {
        name: name.into(),
        data_type: ty.into(),
        nullable,
        primary_key: pk,
        default: default.map(String::from),
    }
}

fn tmp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("dvt_rs_{}_{}", uuid::Uuid::new_v4(), name))
}

async fn q(c: &ResolvedConnection, sql: &str) -> QueryResult {
    match db::run_query(c, sql, None).await {
        Ok(r) => r,
        Err(e) => panic!("query failed: {e}\n--- SQL ---\n{sql}"),
    }
}

async fn qs(c: &ResolvedConnection, sql: &str, schema: &str) -> QueryResult {
    match db::run_query(c, sql, Some(schema)).await {
        Ok(r) => r,
        Err(e) => panic!("query failed: {e}\n--- SQL ---\n{sql}"),
    }
}

fn names(r: &QueryResult) -> Vec<&str> {
    r.columns.iter().map(|c| c.name.as_str()).collect()
}

fn page(limit: u32, offset: u32, order: Option<(&str, &str)>, where_: Option<&str>) -> PageOptions {
    PageOptions {
        schema: None,
        limit: Some(limit),
        offset: Some(offset),
        order_by: order.map(|(c, d)| {
            vec![OrderBy {
                column: c.into(),
                direction: d.into(),
            }]
        }),
        where_clause: where_.map(String::from),
    }
}

fn col_info<'a>(d: &'a TableDetails, name: &str) -> &'a ColumnInfo {
    d.columns
        .iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("column {name} not in {:?}", d.columns))
}

/// `YYYY-MM-DDTHH:MM:SS[.mmm]Z` — parseable by every webview's `Date`.
fn assert_iso_utc(v: Option<&str>) {
    let v = v.expect("serverTime");
    assert!(
        v.len() >= 20 && v.ends_with('Z') && &v[10..11] == "T",
        "{v}"
    );
    assert!(chrono::DateTime::parse_from_rfc3339(v).is_ok(), "{v}");
}

// ───────────────────────────── PostgreSQL ─────────────────────────────

#[tokio::test]
async fn pg_ddl_describe_and_queries() {
    let c = require_conn!("DV_TEST_PG_URL", DriverKind::Postgres);
    let s = "dvt_rs_pg Mixed\"Q";
    let cascade = DropOptions { cascade: true };
    db::drop_schema(&c, s, &cascade).await.unwrap();
    db::create_schema(
        &c,
        &CreateSchemaOptions {
            name: s.into(),
            charset: None,
            collation: None,
            owner: None,
        },
    )
    .await
    .unwrap();
    let schemas = db::list_schemas(&c).await.unwrap();
    assert!(schemas.iter().any(|x| x.name == s && !x.is_system));
    assert!(schemas
        .iter()
        .any(|x| x.name == "pg_catalog" && x.is_system));

    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: "Parent".into(),
            columns: vec![
                col("Id", "serial", false, true, None),
                col("order", "text", true, false, Some("'x'")),
            ],
            foreign_keys: vec![],
            indexes: vec![CreateTableIndex {
                name: None,
                columns: vec!["order".into()],
                unique: true,
            }],
        },
    )
    .await
    .unwrap();
    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: "child".into(),
            columns: vec![
                col("id", "int", false, true, None),
                col("parent_id", "int", false, false, None),
            ],
            foreign_keys: vec![CreateTableForeignKey {
                name: Some("child_parent_fk".into()),
                columns: vec!["parent_id".into()],
                referenced_schema: s.into(),
                referenced_table: "Parent".into(),
                referenced_columns: vec!["Id".into()],
                on_update: None,
                on_delete: Some("CASCADE".into()),
            }],
            indexes: vec![CreateTableIndex {
                name: Some("child_parent_idx".into()),
                columns: vec!["parent_id".into()],
                unique: false,
            }],
        },
    )
    .await
    .unwrap();

    let parent = db::describe_table(&c, s, "Parent").await.unwrap();
    assert_eq!(parent.kind, RelationKind::Table);
    let id = col_info(&parent, "Id");
    assert!(id.is_primary_key && !id.nullable);
    assert!(id.default.as_deref().unwrap_or("").starts_with("nextval("));
    let order = col_info(&parent, "order");
    assert!(order.is_unique && !order.is_primary_key && order.nullable);
    assert_eq!(order.default.as_deref(), Some("'x'::text"));
    let pk = parent.indexes.iter().find(|i| i.primary).unwrap();
    // Mixed-case column names come back unquoted.
    assert_eq!(pk.columns, vec!["Id"]);
    assert!(parent
        .indexes
        .iter()
        .any(|i| i.name == "idx_Parent_order" && i.unique && i.columns == vec!["order"]));

    let child = db::describe_table(&c, s, "child").await.unwrap();
    assert_eq!(child.foreign_keys.len(), 1);
    let fk = &child.foreign_keys[0];
    assert_eq!(fk.name, "child_parent_fk");
    assert_eq!(fk.columns, vec!["parent_id"]);
    assert_eq!(fk.referenced_schema, s);
    assert_eq!(fk.referenced_table, "Parent");
    assert_eq!(fk.referenced_columns, vec!["Id"]);
    assert_eq!(fk.on_delete.as_deref(), Some("CASCADE"));
    assert_eq!(fk.on_update.as_deref(), Some("NO ACTION"));
    assert!(child.indexes.iter().any(|i| i.name == "child_parent_idx"));

    // DML reports affected rows.
    let qs_ident = "\"dvt_rs_pg Mixed\"\"Q\"";
    let r = q(
        &c,
        &format!("INSERT INTO {qs_ident}.\"Parent\"(\"order\") VALUES ('a'), ('b'), ('c')"),
    )
    .await;
    assert!(r.columns.is_empty());
    assert_eq!(r.affected_rows, Some(3));
    let r = q(
        &c,
        &format!("UPDATE {qs_ident}.\"Parent\" SET \"order\" = \"order\" || '!' WHERE \"Id\" > 1"),
    )
    .await;
    assert_eq!(r.affected_rows, Some(2));

    // `schema` option sets the search_path.
    let r = qs(&c, "SELECT count(*) AS n FROM \"Parent\"", s).await;
    assert_eq!(names(&r), vec!["n"]);
    assert_eq!(r.rows, vec![vec![json!(3)]]);
    assert_eq!(r.affected_rows, None);

    // Multi-statement scripts run; the last result set is returned.
    let r = qs(
        &c,
        "INSERT INTO child VALUES (1, 1); INSERT INTO child VALUES (2, 1); SELECT id FROM child ORDER BY id",
        s,
    )
    .await;
    assert_eq!(names(&r), vec!["id"]);
    assert_eq!(r.rows.len(), 2);

    // Errors carry the server message (not just "db error").
    let err = db::run_query(&c, "SELECT * FROM dvt_rs_missing_table", None)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("does not exist"), "{err}");
    let err = db::run_query(&c, "SELECT 1; SELECT 1/0", None)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("division by zero"), "{err}");

    // Paging / ordering / filtering.
    let r = db::fetch_table_data(
        &c,
        s,
        "Parent",
        &page(2, 1, Some(("Id", "desc")), Some("\"order\" <> 'zzz'")),
    )
    .await
    .unwrap();
    assert_eq!(names(&r), vec!["Id", "order"]);
    assert_eq!(
        r.rows,
        vec![vec![json!(2), json!("b!")], vec![json!(1), json!("a")]]
    );
    assert!(!r.truncated);
    let r = db::fetch_table_data(&c, s, "Parent", &page(10, 0, None, Some("false")))
        .await
        .unwrap();
    assert_eq!(names(&r), vec!["Id", "order"]);
    assert!(r.rows.is_empty());

    // Server-side truncation at QUERY_LIMIT.
    let r = q(&c, "SELECT generate_series(1, 5001) AS n").await;
    assert_eq!(r.rows.len(), QUERY_LIMIT);
    assert!(r.truncated);
    let r = q(&c, "SELECT generate_series(1, 5000) AS n").await;
    assert!(!r.truncated);

    // Relations with kinds and stats.
    q(
        &c,
        &format!("CREATE VIEW {qs_ident}.v_parent AS SELECT * FROM {qs_ident}.\"Parent\""),
    )
    .await;
    q(
        &c,
        &format!(
            "CREATE MATERIALIZED VIEW {qs_ident}.mv_parent AS SELECT * FROM {qs_ident}.\"Parent\""
        ),
    )
    .await;
    q(&c, &format!("ANALYZE {qs_ident}.\"Parent\"")).await;
    let rels = db::list_relations(&c, Some(s)).await.unwrap();
    let kind_of = |n: &str| rels.iter().find(|r| r.name == n).map(|r| r.kind);
    assert_eq!(kind_of("Parent"), Some(RelationKind::Table));
    assert_eq!(kind_of("v_parent"), Some(RelationKind::View));
    assert_eq!(kind_of("mv_parent"), Some(RelationKind::MaterializedView));
    let p = rels.iter().find(|r| r.name == "Parent").unwrap();
    assert_eq!(p.approx_row_count, Some(3));
    assert!(p.total_bytes.unwrap() >= p.data_bytes.unwrap() + p.index_bytes.unwrap());
    assert!(rels
        .iter()
        .find(|r| r.name == "v_parent")
        .unwrap()
        .total_bytes
        .is_none());
    assert_eq!(
        db::describe_table(&c, s, "v_parent").await.unwrap().kind,
        RelationKind::View
    );
    assert_eq!(
        db::describe_table(&c, s, "mv_parent").await.unwrap().kind,
        RelationKind::MaterializedView
    );
    let rel_json = serde_json::to_value(&rels).unwrap();
    assert!(rel_json
        .as_array()
        .unwrap()
        .iter()
        .any(|r| r["kind"] == "materialized_view" && r["name"] == "mv_parent"));

    // Secondary indexes.
    db::create_index(
        &c,
        &CreateIndexOptions {
            schema: s.into(),
            table: "Parent".into(),
            name: None,
            columns: vec!["Id".into(), "order".into()],
            unique: false,
        },
    )
    .await
    .unwrap();
    let d = db::describe_table(&c, s, "Parent").await.unwrap();
    assert!(d.indexes.iter().any(|i| i.name == "idx_Parent_Id_order"));
    db::drop_index(
        &c,
        &DropIndexOptions {
            schema: s.into(),
            table: Some("Parent".into()),
            name: "idx_Parent_Id_order".into(),
        },
    )
    .await
    .unwrap();
    let d = db::describe_table(&c, s, "Parent").await.unwrap();
    assert!(!d.indexes.iter().any(|i| i.name == "idx_Parent_Id_order"));

    // TRUNCATE … CASCADE empties the referencing table too.
    db::truncate_table(&c, s, "Parent", &cascade).await.unwrap();
    let r = qs(&c, "SELECT count(*) FROM child", s).await;
    assert_eq!(r.rows, vec![vec![json!(0)]]);

    // DROP TABLE … CASCADE drops the dependent view.
    db::drop_table(&c, s, "Parent", &cascade).await.unwrap();
    let rels = db::list_relations(&c, Some(s)).await.unwrap();
    assert!(!rels
        .iter()
        .any(|r| r.name == "Parent" || r.name == "v_parent"));

    let overview = db::get_connection_overview(&c).await.unwrap();
    assert_eq!(overview.driver, "postgres");
    assert_iso_utc(overview.server_time.as_deref());
    assert!(overview.databases.iter().any(|d| d.name == "postgres"));

    db::drop_schema(&c, s, &cascade).await.unwrap();
    assert!(!db::list_schemas(&c)
        .await
        .unwrap()
        .iter()
        .any(|x| x.name == s));
}

#[tokio::test]
async fn pg_value_conversions() {
    let c = require_conn!("DV_TEST_PG_URL", DriverKind::Postgres);
    let s = "dvt_rs_pg_types";
    let cascade = DropOptions { cascade: true };
    db::drop_schema(&c, s, &cascade).await.unwrap();
    q(
        &c,
        "CREATE SCHEMA dvt_rs_pg_types;
         CREATE TYPE dvt_rs_pg_types.mood AS ENUM ('happy', 'sad');
         CREATE TABLE dvt_rs_pg_types.t (
           i2 smallint, i4 int, i8 bigint, big bigint, n numeric(30,10), f4 real, f8 double precision,
           b boolean, t text, d date, ts timestamp, tstz timestamptz, tm time,
           j json, jb jsonb, u uuid, by bytea, arr int[], iv interval, e dvt_rs_pg_types.mood, ip inet
         );
         INSERT INTO dvt_rs_pg_types.t VALUES (
           1, 2, 42, 9007199254740993, 12345678901234567890.0123456789, 1.5, 0.1,
           true, 'x''y\\z', '2024-01-02', '2024-01-02 03:04:05.123456', '2024-01-02 03:04:05+00', '12:34:56',
           '{\"a\": 1}', '{\"b\": 2}', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '\\x0102ff', '{1,2}', '1 day',
           'happy', '10.0.0.1'
         );
         INSERT INTO dvt_rs_pg_types.t DEFAULT VALUES;",
    )
    .await;
    let r = db::fetch_table_data(&c, s, "t", &page(10, 0, Some(("i2", "asc")), None))
        .await
        .unwrap();
    let types: Vec<&str> = r.columns.iter().map(|c| c.data_type.as_str()).collect();
    assert_eq!(&types[..4], &["int2", "int4", "int8", "int8"]);
    let row = &r.rows[0];
    assert_eq!(row[0], json!(1));
    assert_eq!(row[2], json!(42));
    assert_eq!(
        row[3],
        json!("9007199254740993"),
        "unsafe int8 must stay exact"
    );
    assert_eq!(row[4], json!("12345678901234567890.0123456789"));
    assert_eq!(row[5], json!(1.5));
    assert_eq!(row[6], json!(0.1));
    assert_eq!(row[7], json!(true));
    assert_eq!(row[8], json!("x'y\\z"));
    assert_eq!(row[9], json!("2024-01-02"));
    assert_eq!(row[10], json!("2024-01-02 03:04:05.123456"));
    assert!(row[11].as_str().unwrap().starts_with("2024-01-02 03:04:05"));
    assert_eq!(row[12], json!("12:34:56"));
    assert_eq!(row[13], json!("{\"a\": 1}"));
    assert_eq!(row[14], json!("{\"b\": 2}"));
    assert_eq!(row[15], json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"));
    assert_eq!(row[16], json!({"__binary": true, "bytes": 3}));
    assert_eq!(row[17], json!("{1,2}"));
    assert_eq!(row[18], json!("1 day"));
    assert_eq!(row[19], json!("happy"));
    assert_eq!(row[20], json!("10.0.0.1"));
    assert!(r.rows[1].iter().all(Value::is_null), "{:?}", r.rows[1]);
    db::drop_schema(&c, s, &cascade).await.unwrap();
}

#[tokio::test]
async fn pg_exports_round_trip() {
    let c = require_conn!("DV_TEST_PG_URL", DriverKind::Postgres);
    let s = "dvt_rs_pg_export";
    let cascade = DropOptions { cascade: true };
    db::drop_schema(&c, s, &cascade).await.unwrap();
    q(
        &c,
        "CREATE SCHEMA dvt_rs_pg_export;
         CREATE TABLE dvt_rs_pg_export.\"Items\" (
           id serial PRIMARY KEY, \"Name\" text NOT NULL, price numeric(10,2), active boolean,
           tags text[], meta jsonb, created timestamptz, raw bytea
         );
         CREATE TABLE dvt_rs_pg_export.notes (
           id int PRIMARY KEY, item_id int REFERENCES dvt_rs_pg_export.\"Items\"(id), body text
         );
         INSERT INTO dvt_rs_pg_export.\"Items\" (\"Name\", price, active, tags, meta, created, raw) VALUES
           ('plain', 10.50, true, '{a,b}', '{\"k\": \"v\"}', '2024-01-02 03:04:05+00', '\\x00'),
           ('quote '' and \\ back, comma', NULL, false, NULL, NULL, NULL, NULL),
           ('multi\nline \"dq\"', 0, NULL, '{}', '[]', NULL, NULL);
         INSERT INTO dvt_rs_pg_export.notes VALUES (1, 1, 'n1'), (2, 3, NULL);",
    )
    .await;

    // CSV table export.
    let path = tmp_path("items.csv");
    let res = export::export_table_to_path(
        &c,
        s,
        "Items",
        ExportTableOptions {
            format: ExportFormat::Csv,
            where_clause: None,
            include_header: true,
            batch_size: Some(100),
        },
        path.clone(),
    )
    .await
    .unwrap();
    assert_eq!(res.row_count, 3);
    let csv = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    assert_eq!(res.bytes as usize, csv.len());
    assert_eq!(
        csv,
        "id,Name,price,active,tags,meta,created,raw\r\n\
         1,plain,10.50,true,\"{a,b}\",\"{\"\"k\"\": \"\"v\"\"}\",2024-01-02 03:04:05+00,<binary 1B>\r\n\
         2,\"quote ' and \\ back, comma\",,false,,,,\r\n\
         3,\"multi\nline \"\"dq\"\"\",0.00,,{},[],,\r\n"
    );

    // WHERE filter + JSON.
    let path = tmp_path("items.json");
    let res = export::export_table_to_path(
        &c,
        s,
        "Items",
        ExportTableOptions {
            format: ExportFormat::Json,
            where_clause: Some("id = 1".into()),
            include_header: true,
            batch_size: None,
        },
        path.clone(),
    )
    .await
    .unwrap();
    assert_eq!(res.row_count, 1);
    let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    std::fs::remove_file(&path).ok();
    assert_eq!(parsed[0]["Name"], json!("plain"));
    assert_eq!(parsed[0]["raw"], json!("<binary 1B>"));

    // SQL table export re-imports cleanly.
    let path = tmp_path("items.sql");
    export::export_table_to_path(
        &c,
        s,
        "Items",
        ExportTableOptions {
            format: ExportFormat::Sql,
            where_clause: None,
            include_header: true,
            batch_size: Some(2),
        },
        path.clone(),
    )
    .await
    .unwrap();
    let sql = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    assert_eq!(
        sql.matches("INSERT INTO dvt_rs_pg_export.\"Items\"")
            .count(),
        2
    );
    let before = db::fetch_table_data(&c, s, "Items", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    q(&c, "TRUNCATE dvt_rs_pg_export.\"Items\" CASCADE").await;
    q(&c, &sql).await;
    let after = db::fetch_table_data(&c, s, "Items", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    // bytea is exported as NULL (like the web exporter); everything else matches.
    let strip = |rows: &Vec<Vec<Value>>| -> Vec<Vec<Value>> {
        rows.iter().map(|r| r[..7].to_vec()).collect()
    };
    assert_eq!(strip(&before.rows), strip(&after.rows));
    q(
        &c,
        "INSERT INTO dvt_rs_pg_export.notes VALUES (1, 1, 'n1'), (2, 3, NULL)",
    )
    .await;

    // Whole-database dump → drop → restore.
    let path = tmp_path("dump.sql");
    let res = export::export_database_to_path(
        &c,
        ExportDatabaseOptions {
            schemas: Some(vec![s.into()]),
            include_schema: true,
            include_data: true,
            batch_size: Some(2),
            drop_if_exists: false,
        },
        path.clone(),
    )
    .await
    .unwrap();
    assert_eq!(res.table_count, 2);
    assert_eq!(res.row_count, 5);
    let dump = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    assert!(dump.contains("id serial NOT NULL"), "{dump}");
    db::drop_schema(&c, s, &cascade).await.unwrap();
    q(&c, &dump).await;
    let items = db::fetch_table_data(&c, s, "Items", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    assert_eq!(strip(&items.rows), strip(&after.rows));
    let notes = db::fetch_table_data(&c, s, "notes", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    assert_eq!(
        notes.rows,
        vec![
            vec![json!(1), json!(1), json!("n1")],
            vec![json!(2), json!(3), Value::Null]
        ]
    );
    db::drop_schema(&c, s, &cascade).await.unwrap();
}

// ─────────────────────────────── MySQL ───────────────────────────────

#[tokio::test]
async fn mysql_ddl_describe_and_queries() {
    let c = require_conn!("DV_TEST_MYSQL_URL", DriverKind::Mysql);
    let s = "dvt_rs_my_ddl";
    let none = DropOptions::default();
    db::drop_schema(&c, s, &none).await.unwrap();
    db::create_schema(
        &c,
        &CreateSchemaOptions {
            name: s.into(),
            charset: Some("utf8mb4".into()),
            collation: Some("utf8mb4_unicode_ci".into()),
            owner: None,
        },
    )
    .await
    .unwrap();
    assert!(db::list_schemas(&c)
        .await
        .unwrap()
        .iter()
        .any(|x| x.name == s && !x.is_system));

    let parent = "Mixed `Parent`";
    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: parent.into(),
            columns: vec![
                col("id", "int auto_increment", false, true, None),
                col("select", "varchar(20)", true, false, Some("'x'")),
                col("path", "varchar(50)", true, false, Some("'C:\\\\tmp'")),
                col("qty", "int", false, false, Some("0")),
            ],
            foreign_keys: vec![],
            indexes: vec![CreateTableIndex {
                name: None,
                columns: vec!["select".into()],
                unique: true,
            }],
        },
    )
    .await
    .unwrap();
    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: "child".into(),
            columns: vec![
                col("id", "int", false, true, None),
                col("parent,id", "int", false, false, None),
            ],
            foreign_keys: vec![CreateTableForeignKey {
                name: Some("child_parent_fk".into()),
                columns: vec!["parent,id".into()],
                referenced_schema: s.into(),
                referenced_table: parent.into(),
                referenced_columns: vec!["id".into()],
                on_update: Some("CASCADE".into()),
                on_delete: Some("SET NULL".into()),
            }],
            indexes: vec![],
        },
    )
    .await
    .err()
    .map(|e| {
        // SET NULL on a NOT NULL column is rejected by MySQL — retry valid.
        assert!(
            e.to_string().contains("SET NULL") || e.to_string().contains("1830"),
            "{e}"
        );
    });
    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: "child".into(),
            columns: vec![
                col("id", "int", false, true, None),
                col("parent,id", "int", true, false, None),
            ],
            foreign_keys: vec![CreateTableForeignKey {
                name: Some("child_parent_fk".into()),
                columns: vec!["parent,id".into()],
                referenced_schema: s.into(),
                referenced_table: parent.into(),
                referenced_columns: vec!["id".into()],
                on_update: Some("CASCADE".into()),
                on_delete: Some("SET NULL".into()),
            }],
            indexes: vec![],
        },
    )
    .await
    .unwrap();

    let d = db::describe_table(&c, s, parent).await.unwrap();
    assert_eq!(d.kind, RelationKind::Table);
    assert!(col_info(&d, "id").is_primary_key);
    let sel = col_info(&d, "select");
    assert!(sel.is_unique);
    // Literal defaults come back as SQL (quoted), ready to paste after DEFAULT.
    assert_eq!(sel.default.as_deref(), Some("'x'"));
    assert_eq!(col_info(&d, "path").default.as_deref(), Some("'C:\\\\tmp'"));
    assert_eq!(col_info(&d, "qty").default.as_deref(), Some("0"));
    assert!(d.indexes.iter().any(|i| i.primary && i.name == "PRIMARY"));
    assert!(d
        .indexes
        .iter()
        .any(|i| i.unique && i.columns == vec!["select"]));
    let child = db::describe_table(&c, s, "child").await.unwrap();
    let fk = &child.foreign_keys[0];
    assert_eq!(
        fk.columns,
        vec!["parent,id"],
        "column names with commas survive"
    );
    assert_eq!(fk.referenced_table, parent);
    assert_eq!(fk.referenced_schema, s);
    assert_eq!(fk.on_update.as_deref(), Some("CASCADE"));
    assert_eq!(fk.on_delete.as_deref(), Some("SET NULL"));

    // DML affected rows (single statement and scripts), USE via `schema`.
    let r = qs(
        &c,
        "INSERT INTO `Mixed ``Parent``` (`select`, qty) VALUES ('a', 1), ('b', 2), ('c', 3)",
        s,
    )
    .await;
    assert!(r.columns.is_empty());
    assert_eq!(r.affected_rows, Some(3));
    let r = qs(&c, "UPDATE `Mixed ``Parent``` SET qty = qty + 1 WHERE qty > 1; DELETE FROM `Mixed ``Parent``` WHERE qty = 99", s).await;
    assert_eq!(r.affected_rows, Some(2));
    let r = qs(
        &c,
        "SELECT 1 AS a; SELECT `select`, qty FROM `Mixed ``Parent``` ORDER BY id",
        s,
    )
    .await;
    assert_eq!(names(&r), vec!["select", "qty"]);
    assert_eq!(r.rows[0], vec![json!("a"), json!(1)]);
    let err = db::run_query(&c, "SELECT 1; SELECT * FROM dvt_rs_missing", Some(s))
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("doesn't exist"), "{err}");

    let r = db::fetch_table_data(
        &c,
        s,
        parent,
        &page(2, 1, Some(("id", "desc")), Some("qty < 100")),
    )
    .await
    .unwrap();
    assert_eq!(r.rows.len(), 2);
    assert_eq!(r.rows[0][0], json!(2));
    let r = db::fetch_table_data(&c, s, parent, &page(5, 0, None, Some("1 = 0")))
        .await
        .unwrap();
    assert_eq!(names(&r), vec!["id", "select", "path", "qty"]);

    let r = q(&c, "SET SESSION cte_max_recursion_depth = 10000; WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5001) SELECT i FROM n").await;
    assert_eq!(r.rows.len(), QUERY_LIMIT);
    assert!(r.truncated);

    q(&c, "CREATE VIEW dvt_rs_my_ddl.v AS SELECT 1 AS x").await;
    let rels = db::list_relations(&c, Some(s)).await.unwrap();
    assert_eq!(
        rels.iter().find(|r| r.name == "v").unwrap().kind,
        RelationKind::View
    );
    let p = rels.iter().find(|r| r.name == parent).unwrap();
    assert!(p.data_bytes.is_some() && p.total_bytes.is_some());
    assert_eq!(
        db::describe_table(&c, s, "v").await.unwrap().kind,
        RelationKind::View
    );

    db::create_index(
        &c,
        &CreateIndexOptions {
            schema: s.into(),
            table: parent.into(),
            name: Some("by_qty".into()),
            columns: vec!["qty".into()],
            unique: false,
        },
    )
    .await
    .unwrap();
    assert!(db::describe_table(&c, s, parent)
        .await
        .unwrap()
        .indexes
        .iter()
        .any(|i| i.name == "by_qty"));
    db::drop_index(
        &c,
        &DropIndexOptions {
            schema: s.into(),
            table: Some(parent.into()),
            name: "by_qty".into(),
        },
    )
    .await
    .unwrap();

    db::truncate_table(&c, s, "child", &DropOptions { cascade: true })
        .await
        .unwrap();
    db::drop_table(&c, s, "child", &DropOptions { cascade: true })
        .await
        .unwrap();
    let overview = db::get_connection_overview(&c).await.unwrap();
    assert!(overview.databases.iter().any(|d| d.name == s));
    assert_iso_utc(overview.server_time.as_deref());
    db::drop_schema(&c, s, &none).await.unwrap();
}

#[tokio::test]
async fn mysql_value_conversions_and_exports() {
    let c = require_conn!("DV_TEST_MYSQL_URL", DriverKind::Mysql);
    let s = "dvt_rs_my_types";
    let none = DropOptions::default();
    db::drop_schema(&c, s, &none).await.unwrap();
    q(
        &c,
        "CREATE DATABASE dvt_rs_my_types;
         CREATE TABLE dvt_rs_my_types.t (
           id int PRIMARY KEY, ti tinyint, b1 tinyint(1), ubi bigint unsigned, bi bigint,
           de decimal(30,10), f float, d double, bt bit(3), c char(3), vc varchar(20), tx text,
           bl blob, dt date, dtt datetime(3), tm time, yr year, js json, en enum('a','b'), st set('x','y')
         );
         INSERT INTO dvt_rs_my_types.t VALUES
           (1, -5, 1, 18446744073709551615, 42, 12345678901234567890.0123456789, 1.5, 0.1, b'101',
            'abc', 'C:\\\\temp ''q''', 'ñandú', x'0001ff', '2024-01-02', '2024-01-02 03:04:05.123', '-12:00:01',
            2024, '{\"a\": [1, 2]}', 'b', 'x,y'),
           (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL);",
    )
    .await;
    let r = db::fetch_table_data(&c, s, "t", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    let row = &r.rows[0];
    assert_eq!(row[1], json!(-5));
    assert_eq!(row[2], json!(1));
    assert_eq!(row[3], json!("18446744073709551615"));
    assert_eq!(row[4], json!(42));
    assert_eq!(row[5], json!("12345678901234567890.0123456789"));
    assert_eq!(row[6], json!(1.5));
    assert_eq!(row[7], json!(0.1));
    assert_eq!(row[8], json!(5));
    assert_eq!(row[9], json!("abc"));
    assert_eq!(row[10], json!("C:\\temp 'q'"));
    assert_eq!(row[11], json!("ñandú"));
    assert_eq!(row[12], json!({"__binary": true, "bytes": 3}));
    assert_eq!(row[13], json!("2024-01-02"));
    assert_eq!(row[14], json!("2024-01-02 03:04:05.123"));
    assert_eq!(row[15], json!("-12:00:01"));
    assert_eq!(row[16], json!(2024));
    assert_eq!(row[17], json!("{\"a\": [1, 2]}"));
    assert_eq!(row[18], json!("b"));
    assert_eq!(row[19], json!("x,y"));
    assert!(r.rows[1][1..].iter().all(Value::is_null));
    let types: Vec<&str> = r.columns.iter().map(|c| c.data_type.as_str()).collect();
    assert_eq!(
        &types[..6],
        &["int", "tinyint", "tinyint", "bigint", "bigint", "decimal"]
    );
    assert_eq!(types[12], "blob");
    assert_eq!(types[11], "text");

    // SQL export round trip (backslashes and quotes must survive MySQL's
    // escape rules).
    let path = tmp_path("t.sql");
    export::export_table_to_path(
        &c,
        s,
        "t",
        ExportTableOptions {
            format: ExportFormat::Sql,
            where_clause: None,
            include_header: true,
            batch_size: Some(1),
        },
        path.clone(),
    )
    .await
    .unwrap();
    let sql = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    // C:\temp → 'C:\\temp' (MySQL treats backslash as an escape).
    assert!(sql.contains(r"'C:\\temp ''q'''"), "{sql}");
    q(&c, "TRUNCATE TABLE dvt_rs_my_types.t").await;
    q(&c, &sql).await;
    let after = db::fetch_table_data(&c, s, "t", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    let without_blob = |rows: &Vec<Vec<Value>>| -> Vec<Vec<Value>> {
        rows.iter()
            .map(|r| {
                r.iter()
                    .enumerate()
                    .filter(|(i, _)| *i != 12)
                    .map(|(_, v)| v.clone())
                    .collect()
            })
            .collect()
    };
    assert_eq!(without_blob(&r.rows), without_blob(&after.rows));

    // Database dump (SHOW CREATE TABLE based) → drop → restore.
    q(
        &c,
        "CREATE TABLE dvt_rs_my_types.a_child (id int PRIMARY KEY AUTO_INCREMENT, t_id int,
           FOREIGN KEY (t_id) REFERENCES dvt_rs_my_types.t(id));
         INSERT INTO dvt_rs_my_types.a_child (t_id) VALUES (1), (2);",
    )
    .await;
    let path = tmp_path("dump.sql");
    let res = export::export_database_to_path(
        &c,
        ExportDatabaseOptions {
            schemas: Some(vec![s.into()]),
            include_schema: true,
            include_data: true,
            batch_size: Some(100),
            drop_if_exists: true,
        },
        path.clone(),
    )
    .await
    .unwrap();
    assert_eq!(res.table_count, 2);
    assert_eq!(res.row_count, 4);
    let dump = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    assert!(dump.contains("AUTO_INCREMENT"), "{dump}");
    db::drop_schema(&c, s, &none).await.unwrap();
    q(&c, &dump).await;
    let restored = db::fetch_table_data(&c, s, "t", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    assert_eq!(without_blob(&r.rows), without_blob(&restored.rows));
    let r = q(&c, "SELECT COUNT(*) FROM dvt_rs_my_types.a_child").await;
    assert_eq!(r.rows, vec![vec![json!(2)]]);
    db::drop_schema(&c, s, &none).await.unwrap();
}

// ───────────────────────────── SQL Server ─────────────────────────────

/// Create a scratch database and return a connection pointing at it.
async fn mssql_scratch_db(base: &ResolvedConnection, name: &str) -> ResolvedConnection {
    mssql_drop_db(base, name).await;
    q(base, &format!("CREATE DATABASE [{name}]")).await;
    ResolvedConnection {
        database: name.into(),
        ..base.clone()
    }
}

async fn mssql_drop_db(base: &ResolvedConnection, name: &str) {
    q(
        base,
        &format!(
            "IF DB_ID(N'{name}') IS NOT NULL BEGIN
               ALTER DATABASE [{name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
               DROP DATABASE [{name}];
             END"
        ),
    )
    .await;
}

#[tokio::test]
async fn mssql_ddl_describe_and_queries() {
    let base = require_conn!("DV_TEST_MSSQL_URL", DriverKind::Mssql);
    let c = mssql_scratch_db(&base, "dvt_rs_ms_ddl").await;
    let s = "dvt_rs Sch]ema";
    db::create_schema(
        &c,
        &CreateSchemaOptions {
            name: s.into(),
            charset: None,
            collation: None,
            owner: None,
        },
    )
    .await
    .unwrap();
    let schemas = db::list_schemas(&c).await.unwrap();
    assert!(schemas.iter().any(|x| x.name == s && !x.is_system));
    assert!(schemas.iter().any(|x| x.name == "sys" && x.is_system));

    let parent = "Parent [x]";
    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: parent.into(),
            columns: vec![
                col("id", "int identity(1,1)", false, true, None),
                col("name", "nvarchar(50)", false, false, Some("N'x'")),
                col("price", "decimal(10,2)", true, false, None),
                col("code", "varchar(max)", true, false, None),
                col("at", "datetime2(3)", true, false, None),
            ],
            foreign_keys: vec![],
            indexes: vec![CreateTableIndex {
                name: Some("ux_name".into()),
                columns: vec!["name".into()],
                unique: true,
            }],
        },
    )
    .await
    .unwrap();
    db::create_table(
        &c,
        &CreateTableOptions {
            schema: s.into(),
            name: "child".into(),
            columns: vec![
                col("id", "int", false, true, None),
                col("parent_id", "int", true, false, None),
            ],
            foreign_keys: vec![CreateTableForeignKey {
                name: Some("fk_child_parent".into()),
                columns: vec!["parent_id".into()],
                referenced_schema: s.into(),
                referenced_table: parent.into(),
                referenced_columns: vec!["id".into()],
                on_update: None,
                on_delete: Some("SET NULL".into()),
            }],
            indexes: vec![CreateTableIndex {
                name: None,
                columns: vec!["parent_id".into()],
                unique: false,
            }],
        },
    )
    .await
    .unwrap();

    let d = db::describe_table(&c, s, parent).await.unwrap();
    assert_eq!(d.kind, RelationKind::Table);
    assert!(col_info(&d, "id").is_primary_key);
    // Lengths/precision are kept (a bare `varchar` would mean varchar(1)).
    assert_eq!(col_info(&d, "name").data_type, "nvarchar(50)");
    assert_eq!(col_info(&d, "price").data_type, "decimal(10,2)");
    assert_eq!(col_info(&d, "code").data_type, "varchar(max)");
    assert_eq!(col_info(&d, "at").data_type, "datetime2(3)");
    assert_eq!(col_info(&d, "name").default.as_deref(), Some("(N'x')"));
    assert!(col_info(&d, "name").is_unique);
    assert!(!col_info(&d, "name").nullable);
    assert!(d
        .indexes
        .iter()
        .any(|i| i.primary && i.columns == vec!["id"]));
    let child = db::describe_table(&c, s, "child").await.unwrap();
    let fk = &child.foreign_keys[0];
    assert_eq!(fk.columns, vec!["parent_id"]);
    assert_eq!(fk.referenced_table, parent);
    assert_eq!(fk.on_delete.as_deref(), Some("SET NULL"));
    assert_eq!(fk.on_update.as_deref(), Some("NO ACTION"));
    assert!(child
        .indexes
        .iter()
        .any(|i| i.name == "idx_child_parent_id"));

    let fq = "[dvt_rs Sch]]ema].[Parent [x]]]";
    let r = q(
        &c,
        &format!("INSERT INTO {fq} (name, price) VALUES (N'a', 1.5), (N'b', -2.25), (N'c', NULL)"),
    )
    .await;
    assert!(r.columns.is_empty());
    assert_eq!(r.affected_rows, Some(3));
    let r = q(
        &c,
        &format!("UPDATE {fq} SET price = 0 WHERE price IS NULL"),
    )
    .await;
    assert_eq!(r.affected_rows, Some(1));
    let r = q(
        &c,
        &format!("SELECT 1 AS a; SELECT name, price FROM {fq} ORDER BY id"),
    )
    .await;
    assert_eq!(names(&r), vec!["name", "price"]);
    assert_eq!(r.rows[1], vec![json!("b"), json!("-2.25")]);
    // GO-separated scripts and CREATE VIEW (must start a batch).
    q(
        &c,
        &format!("CREATE VIEW [dvt_rs Sch]]ema].v AS SELECT id FROM {fq}\nGO\nSELECT 1"),
    )
    .await;
    // `schema` is ignored on SQL Server (schemas aren't databases).
    let r = db::run_query(&c, "SELECT DB_NAME() AS db", Some(s))
        .await
        .unwrap();
    assert_eq!(r.rows, vec![vec![json!("dvt_rs_ms_ddl")]]);
    let err = db::run_query(&c, "SELECT * FROM dvt_rs_missing", None)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("Invalid object name"), "{err}");
    let err = db::run_query(&c, "SELECT CAST(1 AS sql_variant) AS v", None)
        .await
        .unwrap_err()
        .to_string();
    assert!(err.contains("sql_variant"), "{err}");

    let r = db::fetch_table_data(
        &c,
        s,
        parent,
        &page(2, 1, Some(("id", "desc")), Some("id < 100")),
    )
    .await
    .unwrap();
    assert_eq!(
        r.rows.iter().map(|r| r[0].clone()).collect::<Vec<_>>(),
        vec![json!(2), json!(1)]
    );
    let r = db::fetch_table_data(&c, s, parent, &page(5, 0, None, Some("1 = 0")))
        .await
        .unwrap();
    assert_eq!(names(&r), vec!["id", "name", "price", "code", "at"]);

    let rels = db::list_relations(&c, Some(s)).await.unwrap();
    let p = rels.iter().find(|r| r.name == parent).unwrap();
    assert_eq!(p.kind, RelationKind::Table);
    assert_eq!(p.approx_row_count, Some(3));
    assert!(p.total_bytes.unwrap() > 0);
    assert!(p.index_bytes.is_some());
    let v = rels.iter().find(|r| r.name == "v").unwrap();
    assert_eq!(v.kind, RelationKind::View);
    assert_eq!(v.approx_row_count, None);
    assert!(db::list_relations(&c, None).await.unwrap().len() >= 3);

    db::create_index(
        &c,
        &CreateIndexOptions {
            schema: s.into(),
            table: parent.into(),
            name: Some("ix_price".into()),
            columns: vec!["price".into()],
            unique: false,
        },
    )
    .await
    .unwrap();
    db::drop_index(
        &c,
        &DropIndexOptions {
            schema: s.into(),
            table: Some(parent.into()),
            name: "ix_price".into(),
        },
    )
    .await
    .unwrap();

    db::truncate_table(&c, s, "child", &DropOptions { cascade: true })
        .await
        .unwrap();
    db::drop_table(&c, s, "child", &DropOptions::default())
        .await
        .unwrap();
    let overview = db::get_connection_overview(&c).await.unwrap();
    assert_eq!(overview.current_database.as_deref(), Some("dvt_rs_ms_ddl"));
    assert_iso_utc(overview.server_time.as_deref());
    mssql_drop_db(&base, "dvt_rs_ms_ddl").await;
}

#[tokio::test]
async fn mssql_value_conversions_and_exports() {
    let base = require_conn!("DV_TEST_MSSQL_URL", DriverKind::Mssql);
    let c = mssql_scratch_db(&base, "dvt_rs_ms_types").await;
    q(
        &c,
        "CREATE TABLE dbo.t (
           id int PRIMARY KEY, ti tinyint, si smallint, bi bigint, de decimal(30,10), f float, r real,
           m money, b bit, c char(3), vc varchar(20), nvc nvarchar(20), vb varbinary(10), d date,
           dt datetime, sdt smalldatetime, dt2 datetime2(7), dto datetimeoffset(7), tm time(7),
           g uniqueidentifier, x xml
         );
         INSERT INTO dbo.t VALUES
           (1, 5, -3, 9007199254740993, -12345678901234567890.0123456789, 0.1, 1.25, 1.5, 1,
            'abc', 'it''s', N'ñandú', 0x0001FF, '2024-01-02', '2024-01-02T03:04:05.997',
            '2024-01-02T03:04:00', '2024-01-02T03:04:05.1234567', '2024-01-02T03:04:05.1234567+02:00',
            '12:34:56.5', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11', '<a x=\"1\"/>'),
           (2, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL);",
    )
    .await;
    let r = db::fetch_table_data(&c, "dbo", "t", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    let row = &r.rows[0];
    assert_eq!(row[1], json!(5));
    assert_eq!(row[2], json!(-3));
    assert_eq!(row[3], json!("9007199254740993"));
    assert_eq!(row[4], json!("-12345678901234567890.0123456789"));
    assert_eq!(row[5], json!(0.1));
    assert_eq!(row[6], json!(1.25));
    assert_eq!(row[7], json!(1.5));
    assert_eq!(row[8], json!(true));
    assert_eq!(row[9], json!("abc"));
    assert_eq!(row[10], json!("it's"));
    assert_eq!(row[11], json!("ñandú"));
    assert_eq!(row[12], json!({"__binary": true, "bytes": 3}));
    assert_eq!(row[13], json!("2024-01-02"));
    assert_eq!(row[14], json!("2024-01-02T03:04:05.997"));
    assert_eq!(row[15], json!("2024-01-02T03:04:00"));
    assert_eq!(row[16], json!("2024-01-02T03:04:05.1234567"));
    assert_eq!(row[17], json!("2024-01-02T03:04:05.1234567+02:00"));
    assert_eq!(row[18], json!("12:34:56.5"));
    assert_eq!(row[19], json!("A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11"));
    assert_eq!(row[20], json!("<a x=\"1\"/>"));
    assert!(r.rows[1][1..].iter().all(Value::is_null));
    let types: Vec<&str> = r.columns.iter().map(|c| c.data_type.as_str()).collect();
    assert_eq!(types[8], "bit");
    assert_eq!(types[16], "datetime2");

    // Values read back are usable as literals: the UI's row editor builds
    // WHERE clauses from them.
    let r2 = q(
        &c,
        "SELECT COUNT(*) FROM dbo.t WHERE dt = '2024-01-02T03:04:05.997'
           AND dt2 = '2024-01-02T03:04:05.1234567' AND dto = '2024-01-02T03:04:05.1234567+02:00'
           AND de = -12345678901234567890.0123456789",
    )
    .await;
    assert_eq!(r2.rows, vec![vec![json!(1)]]);

    // SQL export → truncate → re-import.
    let path = tmp_path("t.sql");
    export::export_table_to_path(
        &c,
        "dbo",
        "t",
        ExportTableOptions {
            format: ExportFormat::Sql,
            where_clause: None,
            include_header: true,
            batch_size: Some(100),
        },
        path.clone(),
    )
    .await
    .unwrap();
    let sql = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    assert!(
        sql.contains("N'ñandú'") && sql.contains(", 1, N'abc'"),
        "{sql}"
    );
    q(&c, "TRUNCATE TABLE dbo.t").await;
    q(&c, &sql).await;
    let after = db::fetch_table_data(&c, "dbo", "t", &page(10, 0, Some(("id", "asc")), None))
        .await
        .unwrap();
    let without_bin = |rows: &Vec<Vec<Value>>| -> Vec<Vec<Value>> {
        rows.iter()
            .map(|r| {
                r.iter()
                    .enumerate()
                    .filter(|(i, _)| *i != 12)
                    .map(|(_, v)| v.clone())
                    .collect()
            })
            .collect()
    };
    assert_eq!(without_bin(&r.rows), without_bin(&after.rows));

    // Database dump into a schema that doesn't exist yet.
    q(&c, "CREATE SCHEMA dvt_rs_s").await;
    q(&c, "CREATE TABLE dvt_rs_s.items (id int PRIMARY KEY, label nvarchar(30) NOT NULL DEFAULT N'?', at datetime2(3)); INSERT INTO dvt_rs_s.items VALUES (1, N'uno', '2024-05-06T07:08:09.123')").await;
    let path = tmp_path("dump.sql");
    let res = export::export_database_to_path(
        &c,
        ExportDatabaseOptions {
            schemas: Some(vec!["dvt_rs_s".into()]),
            include_schema: true,
            include_data: true,
            batch_size: None,
            drop_if_exists: false,
        },
        path.clone(),
    )
    .await
    .unwrap();
    assert_eq!((res.table_count, res.row_count), (1, 1));
    let dump = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(&path).ok();
    q(&c, "DROP TABLE dvt_rs_s.items; DROP SCHEMA dvt_rs_s").await;
    q(&c, &dump).await;
    let d = db::describe_table(&c, "dvt_rs_s", "items").await.unwrap();
    assert_eq!(col_info(&d, "label").data_type, "nvarchar(30)");
    let r = q(&c, "SELECT id, label, at FROM dvt_rs_s.items").await;
    assert_eq!(
        r.rows,
        vec![vec![
            json!(1),
            json!("uno"),
            json!("2024-05-06T07:08:09.123")
        ]]
    );
    mssql_drop_db(&base, "dvt_rs_ms_types").await;
}

/// Optional: `DV_TEST_PG_SSL_URL` pointing at a server whose pg_hba only
/// accepts `hostssl` connections (self-signed cert is fine).
#[tokio::test]
async fn pg_ssl_connection() {
    let mut c = require_conn!("DV_TEST_PG_SSL_URL", DriverKind::Postgres);
    c.ssl = false;
    let plain = db::test(&c).await.unwrap();
    assert!(!plain.ok, "server should reject non-TLS connections");
    c.ssl = true;
    let tls = db::test(&c).await.unwrap();
    assert!(tls.ok, "{}", tls.message);
    let r = db::run_query(
        &c,
        "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
        None,
    )
    .await
    .unwrap();
    assert_eq!(r.rows, vec![vec![json!(true)]]);
}

#[tokio::test]
async fn pg_ssl_required_but_unsupported_fails_cleanly() {
    let mut c = require_conn!("DV_TEST_PG_URL", DriverKind::Postgres);
    c.ssl = true;
    let r = db::test(&c).await.unwrap();
    // The shared test server has TLS off: with sslmode=require we must not
    // silently fall back to plaintext.
    eprintln!(
        "ssl=true against non-TLS server: ok={} message={}",
        r.ok, r.message
    );
    if !r.ok {
        assert!(
            r.message.contains("TLS") || r.message.contains("SSL"),
            "{}",
            r.message
        );
    }
}

#[tokio::test]
async fn mssql_ssl_connection() {
    let mut c = require_conn!("DV_TEST_MSSQL_URL", DriverKind::Mssql);
    c.ssl = true;
    let r = db::test(&c).await.unwrap();
    assert!(r.ok, "{}", r.message);
    let r = db::run_query(
        &c,
        "SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID",
        None,
    )
    .await
    .unwrap();
    assert_eq!(r.rows, vec![vec![json!("TRUE")]]);
    // Explicit opt-in to certificate verification rejects the self-signed cert.
    c.options
        .insert("trustServerCertificate".into(), "false".into());
    assert!(!db::test(&c).await.unwrap().ok);
}

#[tokio::test]
async fn mysql_ssl_connection() {
    let mut c = require_conn!("DV_TEST_MYSQL_URL", DriverKind::Mysql);
    c.ssl = true;
    let r = db::test(&c).await.unwrap();
    assert!(r.ok, "{}", r.message);
    let r = db::run_query(&c, "SHOW SESSION STATUS LIKE 'Ssl_cipher'", None)
        .await
        .unwrap();
    let cipher = r.rows[0][1].as_str().unwrap_or("");
    assert!(!cipher.is_empty(), "connection is not encrypted");
}
