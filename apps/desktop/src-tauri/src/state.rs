use crate::error::AppResult;
use crate::storage::ConnectionStore;
use parking_lot::Mutex;
use std::sync::Arc;

pub struct AppState {
    store: Mutex<Option<Arc<ConnectionStore>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            store: Mutex::new(None),
        }
    }
}

impl AppState {
    /// Lazily opens the connection store on first use. A failure (e.g.
    /// unwritable config dir) surfaces as a command error instead of a panic.
    pub fn store(&self) -> AppResult<Arc<ConnectionStore>> {
        let mut guard = self.store.lock();
        if let Some(s) = guard.as_ref() {
            return Ok(s.clone());
        }
        let store = Arc::new(ConnectionStore::open()?);
        *guard = Some(store.clone());
        Ok(store)
    }
}
