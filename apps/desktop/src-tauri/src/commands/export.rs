use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};

/// A file built by the frontend's export worker (a note or a zip), saved where the user picks.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedFile {
    name: String,
    #[serde(with = "crate::b64")]
    bytes: Vec<u8>,
}

/// Asks where to save an export with the native save dialog, then writes it there. Returns
/// false when the user cancels. The host only writes bytes it is given; it never reads notes.
#[tauri::command]
pub async fn export_save(app: AppHandle, file: ExportedFile) -> AppResult<bool> {
    let ExportedFile { name, bytes } = file;
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_file_name(&name);
        if name.to_ascii_lowercase().ends_with(".zip") {
            dialog = dialog.add_filter("Zip archive", &["zip"]);
        }
        let Some(target) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = target
            .into_path()
            .map_err(|e| AppError::Io(std::io::Error::other(format!("Cannot save there: {e}"))))?;
        std::fs::write(path, bytes)?;
        Ok(true)
    })
    .await
    .map_err(|e| AppError::Io(std::io::Error::other(e.to_string())))?
}
