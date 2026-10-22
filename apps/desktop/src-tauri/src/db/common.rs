//! Driver-agnostic helpers shared by the Postgres / MySQL / SQL Server modules:
//! `CellValue`-shaped JSON builders and a collector that turns the statements
//! of a (possibly multi-statement) script into a single `QueryResult`.

use crate::error::AppResult;
use crate::model::{ColumnInfo, IndexInfo, QueryResult, QueryResultColumn, QUERY_LIMIT};
use serde_json::{json, Value};
use std::time::Instant;

/// Largest integer JS can represent exactly (2^53 - 1).
const JS_MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

/// Signed integer → JSON number, or string when JS would lose precision.
pub fn int_value(v: i64) -> Value {
    if (-JS_MAX_SAFE_INT..=JS_MAX_SAFE_INT).contains(&v) {
        json!(v)
    } else {
        Value::String(v.to_string())
    }
}

/// Unsigned integer → JSON number, or string when JS would lose precision.
pub fn uint_value(v: u64) -> Value {
    if v <= JS_MAX_SAFE_INT as u64 {
        json!(v)
    } else {
        Value::String(v.to_string())
    }
}

/// Float → JSON number. Integral values are emitted as integers (so they
/// render like JS `String(2)` → "2"); NaN/±Infinity (not representable in
/// JSON) fall back to their textual form.
pub fn float_value(v: f64) -> Value {
    if !v.is_finite() {
        return Value::String(
            if v.is_nan() {
                "NaN"
            } else if v > 0.0 {
                "Infinity"
            } else {
                "-Infinity"
            }
            .to_string(),
        );
    }
    if v.fract() == 0.0 && v.abs() <= JS_MAX_SAFE_INT as f64 {
        return json!(v as i64);
    }
    serde_json::Number::from_f64(v)
        .map(Value::Number)
        .unwrap_or_else(|| Value::String(v.to_string()))
}

/// f32 → JSON number using the shortest decimal representation of the f32
/// (so 0.1f32 becomes 0.1, not 0.10000000149011612).
pub fn f32_value(v: f32) -> Value {
    match v.to_string().parse::<f64>() {
        Ok(f) => float_value(f),
        Err(_) => float_value(v as f64),
    }
}

/// Parse a textual integer coming from the server.
pub fn parse_int_text(s: &str) -> Value {
    if let Ok(i) = s.parse::<i64>() {
        return int_value(i);
    }
    if let Ok(u) = s.parse::<u64>() {
        return uint_value(u);
    }
    Value::String(s.to_string())
}

/// Parse a textual float coming from the server.
pub fn parse_float_text(s: &str) -> Value {
    match s.parse::<f64>() {
        Ok(f) if f.is_finite() => float_value(f),
        _ => Value::String(s.to_string()),
    }
}

/// `CellValue` binary marker: `{ "__binary": true, "bytes": n }`.
pub fn binary_value(len: usize) -> Value {
    json!({ "__binary": true, "bytes": len })
}

/// Collects the result sets / row counts produced by a script and shapes the
/// final `QueryResult`:
///  - the *last* statement that returned a result set (rows + columns) wins;
///  - when no statement returned rows, `affectedRows` is the sum of the
///    counts reported by the DML statements;
///  - rows beyond `QUERY_LIMIT` are dropped and `truncated` is set.
pub struct ResultCollector {
    start: Instant,
    current: Option<ResultSet>,
    last: Option<ResultSet>,
    affected: Option<u64>,
}

struct ResultSet {
    columns: Vec<QueryResultColumn>,
    rows: Vec<Vec<Value>>,
    truncated: bool,
}

impl ResultCollector {
    pub fn new(start: Instant) -> Self {
        Self {
            start,
            current: None,
            last: None,
            affected: None,
        }
    }

    /// Start a new result set (closing the previous one, if any).
    pub fn begin_set(&mut self, columns: Vec<QueryResultColumn>) {
        self.end_set();
        self.current = Some(ResultSet {
            columns,
            rows: Vec::new(),
            truncated: false,
        });
    }

    /// Whether the current set still accepts rows (callers can skip decoding
    /// rows that would be dropped anyway).
    pub fn wants_row(&self) -> bool {
        self.current
            .as_ref()
            .map(|s| s.rows.len() < QUERY_LIMIT)
            .unwrap_or(false)
    }

    /// Mark the current set as truncated without storing the row.
    pub fn skip_row(&mut self) {
        if let Some(set) = self.current.as_mut() {
            set.truncated = true;
        }
    }

    pub fn push_row(&mut self, row: Vec<Value>) {
        if let Some(set) = self.current.as_mut() {
            if set.rows.len() < QUERY_LIMIT {
                set.rows.push(row);
            } else {
                set.truncated = true;
            }
        }
    }

    pub fn end_set(&mut self) {
        if let Some(set) = self.current.take() {
            self.last = Some(set);
        }
    }

    pub fn has_current_set(&self) -> bool {
        self.current.is_some()
    }

    /// Record the row count of a statement that didn't return a result set.
    pub fn add_affected(&mut self, n: u64) {
        self.affected = Some(self.affected.unwrap_or(0).saturating_add(n));
    }

    pub fn finish(mut self) -> QueryResult {
        self.end_set();
        let duration_ms = self.start.elapsed().as_millis() as u64;
        match self.last {
            Some(set) => QueryResult {
                row_count: set.rows.len(),
                columns: set.columns,
                rows: set.rows,
                affected_rows: None,
                duration_ms,
                truncated: set.truncated,
            },
            None => QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                row_count: 0,
                affected_rows: self.affected,
                duration_ms,
                truncated: false,
            },
        }
    }
}

/// Receives the rows of a streamed table read (used by the exporters so huge
/// tables never have to fit in memory and are read with a single query).
pub trait RowSink: Send {
    /// Called once, before any row, with the result columns.
    fn columns(&mut self, columns: &[QueryResultColumn]) -> AppResult<()>;
    fn row(&mut self, row: Vec<Value>) -> AppResult<()>;
}

/// A column is "unique" when a non-primary unique index covers exactly it.
pub fn mark_unique_columns(columns: &mut [ColumnInfo], indexes: &[IndexInfo]) {
    for idx in indexes
        .iter()
        .filter(|i| i.unique && !i.primary && i.columns.len() == 1)
    {
        if let Some(col) = columns.iter_mut().find(|c| c.name == idx.columns[0]) {
            col.is_unique = true;
        }
    }
}

/// `WHERE …` fragment for a trusted, operator-provided filter.
pub fn where_fragment(where_clause: Option<&str>) -> String {
    where_clause
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| format!("WHERE {s}"))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ints_keep_precision() {
        assert_eq!(int_value(42), json!(42));
        assert_eq!(
            int_value(9_007_199_254_740_991),
            json!(9_007_199_254_740_991i64)
        );
        assert_eq!(
            int_value(9_007_199_254_740_993),
            Value::String("9007199254740993".into())
        );
        assert_eq!(int_value(i64::MIN), Value::String(i64::MIN.to_string()));
        assert_eq!(
            uint_value(u64::MAX),
            Value::String("18446744073709551615".into())
        );
        assert_eq!(parse_int_text("-12"), json!(-12));
        assert_eq!(
            parse_int_text("18446744073709551615"),
            Value::String("18446744073709551615".into())
        );
    }

    #[test]
    fn floats() {
        assert_eq!(float_value(2.0), json!(2));
        assert_eq!(float_value(1.25), json!(1.25));
        assert_eq!(float_value(f64::NAN), Value::String("NaN".into()));
        assert_eq!(f32_value(0.1), json!(0.1));
        assert_eq!(
            parse_float_text("Infinity"),
            Value::String("Infinity".into())
        );
        assert_eq!(parse_float_text("1e3"), json!(1000));
    }

    #[test]
    fn collector_keeps_last_result_set() {
        let mut c = ResultCollector::new(Instant::now());
        c.add_affected(2);
        c.begin_set(vec![QueryResultColumn {
            name: "a".into(),
            data_type: "int".into(),
        }]);
        c.push_row(vec![json!(1)]);
        c.begin_set(vec![QueryResultColumn {
            name: "b".into(),
            data_type: "int".into(),
        }]);
        c.push_row(vec![json!(2)]);
        c.push_row(vec![json!(3)]);
        let r = c.finish();
        assert_eq!(r.columns.len(), 1);
        assert_eq!(r.columns[0].name, "b");
        assert_eq!(r.rows, vec![vec![json!(2)], vec![json!(3)]]);
        assert_eq!(r.row_count, 2);
        assert_eq!(r.affected_rows, None);
        assert!(!r.truncated);
    }

    #[test]
    fn collector_sums_affected_rows_without_result_sets() {
        let mut c = ResultCollector::new(Instant::now());
        c.add_affected(2);
        c.add_affected(3);
        let r = c.finish();
        assert!(r.columns.is_empty());
        assert_eq!(r.affected_rows, Some(5));
    }

    #[test]
    fn collector_truncates() {
        let mut c = ResultCollector::new(Instant::now());
        c.begin_set(vec![QueryResultColumn {
            name: "a".into(),
            data_type: "int".into(),
        }]);
        for i in 0..(QUERY_LIMIT + 3) {
            if c.wants_row() {
                c.push_row(vec![json!(i)]);
            } else {
                c.skip_row();
            }
        }
        let r = c.finish();
        assert_eq!(r.rows.len(), QUERY_LIMIT);
        assert!(r.truncated);
    }

    #[test]
    fn collector_not_truncated_at_exact_limit() {
        let mut c = ResultCollector::new(Instant::now());
        c.begin_set(vec![]);
        for i in 0..QUERY_LIMIT {
            c.push_row(vec![json!(i)]);
        }
        let r = c.finish();
        assert!(!r.truncated);
    }
}
