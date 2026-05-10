//! AES-256-GCM encryption for stored connection passwords.
//!
//! Desktop login is optional, so we still want passwords-at-rest protected.
//! The key is derived from a fixed local secret (rotatable later) using Argon2.
//! This is *not* a substitute for OS keyring — it's a pragmatic step up from
//! storing plaintext in the user's home dir.

use crate::error::{AppError, AppResult};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::OsRng, RngCore};

const SALT: &[u8] = b"data-view::v1::salt";
const SECRET: &[u8] = b"data-view-default-key-change-me-via-master-password";

fn derive_key() -> [u8; 32] {
    let argon2 = Argon2::new(
        Algorithm::Argon2id,
        Version::V0x13,
        Params::new(19_456, 2, 1, Some(32)).expect("argon2 params"),
    );
    let mut key = [0u8; 32];
    argon2
        .hash_password_into(SECRET, SALT, &mut key)
        .expect("argon2");
    key
}

pub fn encrypt(plaintext: &str) -> AppResult<String> {
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::msg(e.to_string()))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ct = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(format!("v1:{}:{}", B64.encode(nonce_bytes), B64.encode(ct)))
}

pub fn decrypt(encoded: &str) -> AppResult<String> {
    let parts: Vec<&str> = encoded.splitn(3, ':').collect();
    if parts.len() != 3 || parts[0] != "v1" {
        return Err(AppError::msg("unrecognized secret format"));
    }
    let nonce_bytes = B64
        .decode(parts[1])
        .map_err(|e| AppError::msg(e.to_string()))?;
    let ct = B64
        .decode(parts[2])
        .map_err(|e| AppError::msg(e.to_string()))?;
    let key = derive_key();
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::msg(e.to_string()))?;
    let plain = cipher
        .decrypt(Nonce::from_slice(&nonce_bytes), ct.as_ref())
        .map_err(|e| AppError::msg(e.to_string()))?;
    Ok(String::from_utf8(plain).map_err(|e| AppError::msg(e.to_string()))?)
}
