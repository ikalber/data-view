//! JSON-backed connection storage in the OS app-data directory.

use crate::crypto;
use crate::error::{AppError, AppResult};
use crate::model::{
    ConnectionConfig, ConnectionInput, DriverKind, Folder, FolderInput, ResolvedConnection, Tag,
    TagColor, TagInput, TagKind,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::{collections::HashMap, fs};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredConnection {
    pub id: String,
    pub name: String,
    pub driver: DriverKind,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    /// AES-256-GCM ciphertext or empty if no password was provided.
    pub password_cipher: String,
    pub ssl: bool,
    pub options: HashMap<String, String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    #[serde(default)]
    pub tag_ids: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl StoredConnection {
    pub fn to_public(&self) -> ConnectionConfig {
        ConnectionConfig {
            id: self.id.clone(),
            name: self.name.clone(),
            driver: self.driver,
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            ssl: self.ssl,
            options: self.options.clone(),
            folder_id: self.folder_id.clone(),
            tag_ids: self.tag_ids.clone(),
            created_at: self.created_at.clone(),
            updated_at: self.updated_at.clone(),
        }
    }

    pub fn resolve(&self) -> AppResult<ResolvedConnection> {
        let password = if self.password_cipher.is_empty() {
            String::new()
        } else {
            crypto::decrypt(&self.password_cipher)?
        };
        Ok(ResolvedConnection {
            id: self.id.clone(),
            driver: self.driver,
            host: self.host.clone(),
            port: self.port,
            database: self.database.clone(),
            username: self.username.clone(),
            password,
            ssl: self.ssl,
            options: self.options.clone(),
        })
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoreFile {
    #[serde(default)]
    connections: Vec<StoredConnection>,
    #[serde(default)]
    folders: Vec<Folder>,
    #[serde(default)]
    tags: Vec<Tag>,
}

pub struct ConnectionStore {
    path: PathBuf,
    inner: Mutex<StoreFile>,
}

const SEED_TAGS: &[(&str, TagColor)] =
    &[("Test", TagColor::Info), ("Producción", TagColor::Danger)];

impl ConnectionStore {
    pub fn open() -> AppResult<Self> {
        let dir = app_data_dir()?;
        fs::create_dir_all(&dir)?;
        Self::open_at(dir.join("connections.json"))
    }

    /// Open (or create) the store backed by `path`.
    pub fn open_at(path: PathBuf) -> AppResult<Self> {
        let mut inner: StoreFile = if path.exists() {
            let data = fs::read_to_string(&path)?;
            match serde_json::from_str(&data) {
                Ok(file) => file,
                Err(e) => {
                    // Never silently replace an unreadable store with an empty
                    // one (that wiped every saved connection): keep a copy
                    // next to it so nothing is lost, then start fresh.
                    let backup = path.with_extension(format!(
                        "json.corrupt-{}",
                        chrono::Utc::now().format("%Y%m%d%H%M%S")
                    ));
                    fs::copy(&path, &backup)?;
                    eprintln!(
                        "data-view: connections store unreadable ({e}); backup at {}",
                        backup.display()
                    );
                    StoreFile::default()
                }
            }
        } else {
            StoreFile::default()
        };
        seed_tags_if_needed(&mut inner);
        let store = Self {
            path,
            inner: Mutex::new(inner),
        };
        // Persist seeded tags so they show up on the next launch even if no edit happens.
        store.persist(&store.inner.lock())?;
        Ok(store)
    }

    fn persist(&self, file: &StoreFile) -> AppResult<()> {
        let json = serde_json::to_string_pretty(file)?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json)?;
        fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn list(&self) -> Vec<ConnectionConfig> {
        self.inner
            .lock()
            .connections
            .iter()
            .map(StoredConnection::to_public)
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<ConnectionConfig> {
        self.inner
            .lock()
            .connections
            .iter()
            .find(|c| c.id == id)
            .map(StoredConnection::to_public)
    }

    pub fn resolve(&self, id: &str) -> AppResult<ResolvedConnection> {
        let inner = self.inner.lock();
        let row = inner
            .connections
            .iter()
            .find(|c| c.id == id)
            .ok_or(AppError::NotFound)?;
        row.resolve()
    }

    pub fn upsert(&self, input: ConnectionInput) -> AppResult<ConnectionConfig> {
        let mut inner = self.inner.lock();
        let now = chrono::Utc::now().to_rfc3339();

        let password_cipher = match input.password.as_deref() {
            Some(s) if !s.is_empty() => Some(crypto::encrypt(s)?),
            _ => None,
        };

        let folder_id = normalize_folder_id(&inner, input.folder_id.clone());
        let tag_ids = normalize_tag_ids(&inner, input.tag_ids.clone());

        if let Some(id) = input.id.as_ref() {
            let row = inner
                .connections
                .iter_mut()
                .find(|c| &c.id == id)
                .ok_or(AppError::NotFound)?;
            row.name = input.name;
            row.driver = input.driver;
            row.host = input.host;
            row.port = input.port;
            row.database = input.database;
            row.username = input.username;
            if let Some(c) = password_cipher {
                row.password_cipher = c;
            }
            row.ssl = input.ssl;
            row.options = input.options;
            row.folder_id = folder_id;
            row.tag_ids = tag_ids;
            row.updated_at = now;
            let public = row.to_public();
            self.persist(&inner)?;
            return Ok(public);
        }

        let stored = StoredConnection {
            id: uuid::Uuid::new_v4().to_string(),
            name: input.name,
            driver: input.driver,
            host: input.host,
            port: input.port,
            database: input.database,
            username: input.username,
            password_cipher: password_cipher.unwrap_or_default(),
            ssl: input.ssl,
            options: input.options,
            folder_id,
            tag_ids,
            created_at: now.clone(),
            updated_at: now,
        };
        let public = stored.to_public();
        inner.connections.push(stored);
        self.persist(&inner)?;
        Ok(public)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let mut inner = self.inner.lock();
        let before = inner.connections.len();
        inner.connections.retain(|c| c.id != id);
        if inner.connections.len() == before {
            return Err(AppError::NotFound);
        }
        self.persist(&inner)?;
        Ok(())
    }

    pub fn resolve_or_input(&self, input: &ConnectionInput) -> AppResult<ResolvedConnection> {
        // Always test what the form currently says (host, port, db, user,
        // ssl, options). Only the password may come from the saved record:
        // the UI never receives it back, so an edited connection arrives with
        // an empty one. A new connection without password is legit (trust /
        // passwordless auth).
        let typed = input.password.as_deref().filter(|p| !p.is_empty());
        let password = match (typed, input.id.as_deref()) {
            (Some(p), _) => p.to_string(),
            (None, Some(id)) => match self.resolve(id) {
                Ok(saved) => saved.password,
                Err(AppError::NotFound) => String::new(),
                Err(e) => return Err(e),
            },
            (None, None) => String::new(),
        };
        Ok(ResolvedConnection {
            id: input.id.clone().unwrap_or_else(|| "draft".into()),
            driver: input.driver,
            host: input.host.clone(),
            port: input.port,
            database: input.database.clone(),
            username: input.username.clone(),
            password,
            ssl: input.ssl,
            options: input.options.clone(),
        })
    }

    // ── Folders ───────────────────────────────────────────────────────────
    pub fn list_folders(&self) -> Vec<Folder> {
        let mut out = self.inner.lock().folders.clone();
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        out
    }

    pub fn upsert_folder(&self, input: FolderInput) -> AppResult<Folder> {
        let mut inner = self.inner.lock();
        let now = chrono::Utc::now().to_rfc3339();
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::msg("El nombre de la carpeta es obligatorio"));
        }
        if let Some(id) = input.id.as_ref() {
            let row = inner
                .folders
                .iter_mut()
                .find(|f| &f.id == id)
                .ok_or(AppError::NotFound)?;
            row.name = name;
            row.color = input.color;
            row.updated_at = now;
            let out = row.clone();
            self.persist(&inner)?;
            return Ok(out);
        }
        let folder = Folder {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            color: input.color,
            created_at: now.clone(),
            updated_at: now,
        };
        let out = folder.clone();
        inner.folders.push(folder);
        self.persist(&inner)?;
        Ok(out)
    }

    pub fn delete_folder(&self, id: &str) -> AppResult<()> {
        let mut inner = self.inner.lock();
        let before = inner.folders.len();
        inner.folders.retain(|f| f.id != id);
        if inner.folders.len() == before {
            return Err(AppError::NotFound);
        }
        // Reset folder_id on connections that pointed there.
        for c in inner.connections.iter_mut() {
            if c.folder_id.as_deref() == Some(id) {
                c.folder_id = None;
                c.updated_at = chrono::Utc::now().to_rfc3339();
            }
        }
        self.persist(&inner)?;
        Ok(())
    }

    // ── Tags ──────────────────────────────────────────────────────────────
    pub fn list_tags(&self) -> Vec<Tag> {
        let mut inner = self.inner.lock();
        seed_tags_if_needed(&mut inner);
        let mut out = inner.tags.clone();
        out.sort_by(|a, b| {
            let ak = if matches!(a.kind, TagKind::System) {
                0
            } else {
                1
            };
            let bk = if matches!(b.kind, TagKind::System) {
                0
            } else {
                1
            };
            ak.cmp(&bk)
                .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        out
    }

    pub fn upsert_tag(&self, input: TagInput) -> AppResult<Tag> {
        let mut inner = self.inner.lock();
        let name = input.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::msg("El nombre de la etiqueta es obligatorio"));
        }
        if let Some(id) = input.id.as_ref() {
            let row = inner
                .tags
                .iter_mut()
                .find(|t| &t.id == id)
                .ok_or(AppError::NotFound)?;
            row.name = name;
            row.color = input.color;
            let out = row.clone();
            self.persist(&inner)?;
            return Ok(out);
        }
        let tag = Tag {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            color: input.color,
            kind: TagKind::User,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        let out = tag.clone();
        inner.tags.push(tag);
        self.persist(&inner)?;
        Ok(out)
    }

    pub fn delete_tag(&self, id: &str) -> AppResult<()> {
        let mut inner = self.inner.lock();
        if let Some(t) = inner.tags.iter().find(|t| t.id == id) {
            if matches!(t.kind, TagKind::System) {
                return Err(AppError::msg(
                    "No se pueden borrar las etiquetas del sistema",
                ));
            }
        }
        let before = inner.tags.len();
        inner.tags.retain(|t| t.id != id);
        if inner.tags.len() == before {
            return Ok(());
        }
        for c in inner.connections.iter_mut() {
            c.tag_ids.retain(|t| t != id);
        }
        self.persist(&inner)?;
        Ok(())
    }
}

fn seed_tags_if_needed(file: &mut StoreFile) {
    let has_system = file.tags.iter().any(|t| matches!(t.kind, TagKind::System));
    if has_system {
        return;
    }
    let now = chrono::Utc::now().to_rfc3339();
    for (name, color) in SEED_TAGS {
        file.tags.push(Tag {
            id: uuid::Uuid::new_v4().to_string(),
            name: (*name).to_string(),
            color: color.clone(),
            kind: TagKind::System,
            created_at: now.clone(),
        });
    }
}

fn normalize_folder_id(file: &StoreFile, id: Option<String>) -> Option<String> {
    let id = id?;
    if file.folders.iter().any(|f| f.id == id) {
        Some(id)
    } else {
        None
    }
}

fn normalize_tag_ids(file: &StoreFile, ids: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for id in ids {
        if seen.contains(&id) {
            continue;
        }
        if file.tags.iter().any(|t| t.id == id) {
            seen.insert(id.clone());
            out.push(id);
        }
    }
    out
}

fn app_data_dir() -> AppResult<PathBuf> {
    if let Some(dir) = dirs_next() {
        Ok(dir.join("data-view"))
    } else {
        Ok(Path::new(".").join(".data-view"))
    }
}

fn dirs_next() -> Option<PathBuf> {
    // Mirrors the `dirs` crate without adding the dep — we only need the
    // platform-specific config dir.
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DriverKind;

    /// Fresh store in a unique temp dir (removed on drop).
    struct TempStore {
        dir: PathBuf,
        store: ConnectionStore,
    }

    impl TempStore {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("dvt_rs_store_{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&dir).unwrap();
            let store = ConnectionStore::open_at(dir.join("connections.json")).unwrap();
            Self { dir, store }
        }
        fn reopen(&self) -> ConnectionStore {
            ConnectionStore::open_at(self.dir.join("connections.json")).unwrap()
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn input(id: Option<String>, password: Option<&str>) -> ConnectionInput {
        ConnectionInput {
            id,
            name: "Local".into(),
            driver: DriverKind::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: "postgres".into(),
            username: "postgres".into(),
            password: password.map(String::from),
            ssl: false,
            options: HashMap::new(),
            folder_id: None,
            tag_ids: Vec::new(),
        }
    }

    #[test]
    fn password_is_encrypted_and_kept_on_empty_update() {
        let t = TempStore::new();
        let saved = t.store.upsert(input(None, Some("s3cret"))).unwrap();
        let raw = fs::read_to_string(t.dir.join("connections.json")).unwrap();
        assert!(!raw.contains("s3cret"), "password stored in plaintext");
        assert_eq!(t.store.resolve(&saved.id).unwrap().password, "s3cret");

        // Update without password keeps the stored one.
        let mut upd = input(Some(saved.id.clone()), Some(""));
        upd.host = "db.example".into();
        t.store.upsert(upd).unwrap();
        let r = t.store.resolve(&saved.id).unwrap();
        assert_eq!(r.password, "s3cret");
        assert_eq!(r.host, "db.example");

        // A new password replaces it.
        t.store
            .upsert(input(Some(saved.id.clone()), Some("other")))
            .unwrap();
        assert_eq!(t.store.resolve(&saved.id).unwrap().password, "other");

        // Survives a reload from disk.
        assert_eq!(t.reopen().resolve(&saved.id).unwrap().password, "other");
    }

    #[test]
    fn update_of_unknown_connection_is_not_found() {
        let t = TempStore::new();
        assert!(matches!(
            t.store.upsert(input(Some("nope".into()), None)),
            Err(AppError::NotFound)
        ));
    }

    #[test]
    fn test_connection_uses_form_fields_with_saved_password() {
        let t = TempStore::new();
        let saved = t.store.upsert(input(None, Some("s3cret"))).unwrap();
        let mut edited = input(Some(saved.id.clone()), None);
        edited.host = "edited-host".into();
        edited.port = 6543;
        edited.database = "otherdb".into();
        edited.ssl = true;
        let r = t.store.resolve_or_input(&edited).unwrap();
        assert_eq!(r.host, "edited-host");
        assert_eq!(r.port, 6543);
        assert_eq!(r.database, "otherdb");
        assert!(r.ssl);
        assert_eq!(r.password, "s3cret");

        // Typed password wins.
        let mut typed = edited;
        typed.password = Some("typed".into());
        assert_eq!(t.store.resolve_or_input(&typed).unwrap().password, "typed");

        // New connection without password (trust auth) is allowed.
        let r = t.store.resolve_or_input(&input(None, None)).unwrap();
        assert_eq!(r.password, "");
    }

    #[test]
    fn system_tags_are_seeded_once_and_protected() {
        let t = TempStore::new();
        let tags = t.store.list_tags();
        let names: Vec<&str> = tags.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, vec!["Producción", "Test"]);
        assert!(tags.iter().all(|t| matches!(t.kind, TagKind::System)));
        // Reopening doesn't duplicate them.
        assert_eq!(t.reopen().list_tags().len(), 2);
        let err = t.store.delete_tag(&tags[0].id).unwrap_err();
        assert!(err.to_string().contains("sistema"));
        // ...but they can be renamed.
        let renamed = t
            .store
            .upsert_tag(TagInput {
                id: Some(tags[0].id.clone()),
                name: "Prod".into(),
                color: TagColor::Danger,
            })
            .unwrap();
        assert!(matches!(renamed.kind, TagKind::System));
    }

    #[test]
    fn deleting_a_tag_removes_it_from_connections() {
        let t = TempStore::new();
        let tag = t
            .store
            .upsert_tag(TagInput {
                id: None,
                name: "Mine".into(),
                color: TagColor::Info,
            })
            .unwrap();
        let mut inp = input(None, None);
        inp.tag_ids = vec![tag.id.clone(), tag.id.clone(), "unknown".into()];
        let conn = t.store.upsert(inp).unwrap();
        assert_eq!(conn.tag_ids, vec![tag.id.clone()]);
        t.store.delete_tag(&tag.id).unwrap();
        assert!(t.store.get(&conn.id).unwrap().tag_ids.is_empty());
        assert!(t.reopen().get(&conn.id).unwrap().tag_ids.is_empty());
    }

    #[test]
    fn deleting_a_folder_unparents_its_connections() {
        let t = TempStore::new();
        let folder = t
            .store
            .upsert_folder(FolderInput {
                id: None,
                name: " Clientes ".into(),
                color: TagColor::Accent,
            })
            .unwrap();
        assert_eq!(folder.name, "Clientes");
        let mut inp = input(None, None);
        inp.folder_id = Some(folder.id.clone());
        let conn = t.store.upsert(inp).unwrap();
        assert_eq!(conn.folder_id.as_deref(), Some(folder.id.as_str()));
        t.store.delete_folder(&folder.id).unwrap();
        assert_eq!(t.store.get(&conn.id).unwrap().folder_id, None);
        assert!(t.store.list_folders().is_empty());
        // Unknown folder ids are dropped on save.
        let mut inp = input(None, None);
        inp.folder_id = Some("ghost".into());
        assert_eq!(t.store.upsert(inp).unwrap().folder_id, None);
    }

    #[test]
    fn empty_names_are_rejected() {
        let t = TempStore::new();
        assert!(t
            .store
            .upsert_folder(FolderInput {
                id: None,
                name: "  ".into(),
                color: TagColor::Neutral,
            })
            .is_err());
        assert!(t
            .store
            .upsert_tag(TagInput {
                id: None,
                name: "".into(),
                color: TagColor::Neutral,
            })
            .is_err());
    }

    #[test]
    fn corrupt_store_is_backed_up_not_wiped() {
        let t = TempStore::new();
        let path = t.dir.join("connections.json");
        fs::write(&path, "{ not json").unwrap();
        let store = ConnectionStore::open_at(path).unwrap();
        assert!(store.list().is_empty());
        let backups: Vec<_> = fs::read_dir(&t.dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains("corrupt"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "{ not json");
    }

    #[test]
    fn wire_shape_is_camel_case() {
        let t = TempStore::new();
        let conn = t.store.upsert(input(None, Some("x"))).unwrap();
        let v = serde_json::to_value(&conn).unwrap();
        for key in ["folderId", "tagIds", "createdAt", "updatedAt", "driver"] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
        assert!(v.get("password").is_none());
        assert_eq!(v["driver"], "postgres");
        let input: ConnectionInput = serde_json::from_value(serde_json::json!({
            "name": "n", "driver": "mssql", "host": "h", "port": 1433,
            "database": "d", "username": "u", "folderId": null
        }))
        .unwrap();
        assert_eq!(input.driver, DriverKind::Mssql);
        assert!(input.tag_ids.is_empty());
    }
}
