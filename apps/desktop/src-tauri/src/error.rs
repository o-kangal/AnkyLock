use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Error codes shared with `packages/core/src/errors.ts`; serialized as `{ code, message }`.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Moving this folder would create a cycle.")]
    CircularHierarchy,
    #[error("Folders can nest at most 3 levels deep.")]
    MaxDepthExceeded,
    #[error("System categories are views and cannot contain notes or folders.")]
    SystemCategoryImmutable,
    #[error("Notes in Trash are read-only. Restore the note to edit.")]
    ReadOnlyTrashedEntity,
    #[error("{0}")]
    InvalidTransition(String),
    #[error("{0}")]
    InvalidSetting(String),
    #[error("{0} not found.")]
    NotFound(&'static str),
    #[error("Storage error: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("Storage error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Auth(String),
    /// The stored Google session is gone or revoked; the user has to sign in again.
    #[error("Your Google sign-in has expired. Please sign in again.")]
    AuthExpired,
    #[error("Network error: {0}")]
    Network(String),
    #[error("No vault is open.")]
    VaultLocked,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CircularHierarchy => "ERR_CIRCULAR_HIERARCHY",
            Self::MaxDepthExceeded => "ERR_MAX_DEPTH_EXCEEDED",
            Self::SystemCategoryImmutable => "ERR_SYSTEM_CATEGORY_IMMUTABLE",
            Self::ReadOnlyTrashedEntity => "ERR_READ_ONLY_TRASHED_ENTITY",
            Self::InvalidTransition(_) => "ERR_INVALID_TRANSITION",
            Self::InvalidSetting(_) => "ERR_INVALID_SETTING",
            Self::NotFound(_) => "ERR_NOT_FOUND",
            Self::Storage(_) | Self::Io(_) => "ERR_STORAGE",
            Self::Auth(_) => "ERR_AUTH",
            Self::AuthExpired => "ERR_AUTH_EXPIRED",
            Self::Network(_) => "ERR_NETWORK",
            Self::VaultLocked => "ERR_VAULT_LOCKED",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut s = serializer.serialize_struct("AppError", 2)?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.to_string())?;
        s.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
