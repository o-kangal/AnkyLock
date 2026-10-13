//! Serde adapter carrying `Vec<u8>` over IPC as a base64 string; a JSON number array is ~3x larger.

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde::{Deserialize, Deserializer, Serializer};

pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&STANDARD.encode(bytes))
}

pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
    let encoded = String::deserialize(deserializer)?;
    STANDARD.decode(encoded).map_err(serde::de::Error::custom)
}
