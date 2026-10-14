pub mod categories;
pub mod folders;
pub mod notes;
pub mod oauth;
pub mod outbox;
pub mod settings;
pub mod sync;
pub mod vaults;

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};

/// Mirrors `SYSTEM_CATEGORY_IDS` in `packages/core/src/constants.ts`.
const SYSTEM_CATEGORY_IDS: [&str; 3] = ["system_all", "system_archive", "system_trash"];

/// System categories are views (all, archived, trashed), not containers.
fn reject_system_category(category_id: Option<&str>) -> AppResult<()> {
    match category_id {
        Some(id) if SYSTEM_CATEGORY_IDS.contains(&id) => Err(AppError::SystemCategoryImmutable),
        _ => Ok(()),
    }
}

/// A random (version 4) UUID, for ids the host creates itself.
pub fn new_uuid() -> AppResult<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?;
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    let hex: String = b.iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32]))
}

/// Current UTC time in epoch milliseconds, matching `EpochMs` in `packages/core`.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
