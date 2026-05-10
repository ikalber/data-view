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
            driver: self.driver.clone(),
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
            driver: self.driver.clone(),
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

const SEED_TAGS: &[(&str, TagColor)] = &[
    ("Test", TagColor::Info),
    ("Producción", TagColor::Danger),
];

impl ConnectionStore {
    pub fn open() -> AppResult<Self> {
        let dir = app_data_dir()?;
        fs::create_dir_all(&dir)?;
        let path = dir.join("connections.json");
        let mut inner: StoreFile = if path.exists() {
            let data = fs::read_to_string(&path)?;
            serde_json::from_str(&data).unwrap_or_default()
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
        let row = inner.connections.iter().find(|c| c.id == id).ok_or(AppError::NotFound)?;
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

    pub fn resolve_or_input(
        &self,
        input: &ConnectionInput,
    ) -> AppResult<ResolvedConnection> {
        // If input carries a password, use it directly. Otherwise look up the
        // saved connection so the UI doesn't need to round-trip secrets.
        if let Some(pwd) = &input.password {
            if !pwd.is_empty() {
                return Ok(ResolvedConnection {
                    id: input.id.clone().unwrap_or_else(|| "draft".into()),
                    driver: input.driver.clone(),
                    host: input.host.clone(),
                    port: input.port,
                    database: input.database.clone(),
                    username: input.username.clone(),
                    password: pwd.clone(),
                    ssl: input.ssl,
                    options: input.options.clone(),
                });
            }
        }
        let id = input.id.as_deref().ok_or_else(|| AppError::msg("password is required for new connections"))?;
        self.resolve(id)
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
            let ak = if matches!(a.kind, TagKind::System) { 0 } else { 1 };
            let bk = if matches!(b.kind, TagKind::System) { 0 } else { 1 };
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
