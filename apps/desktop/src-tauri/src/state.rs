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
    /// Lazily opens the connection store on first use.
    pub fn store(&self) -> Arc<ConnectionStore> {
        let mut guard = self.store.lock();
        if let Some(s) = guard.as_ref() {
            return s.clone();
        }
        let store = Arc::new(ConnectionStore::open().expect("open connection store"));
        *guard = Some(store.clone());
        store
    }
}
