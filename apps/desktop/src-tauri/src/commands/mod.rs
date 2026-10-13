pub mod categories;
pub mod folders;
pub mod notes;
pub mod outbox;
pub mod settings;

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

/// Current UTC time in epoch milliseconds, matching `EpochMs` in `packages/core`.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}
