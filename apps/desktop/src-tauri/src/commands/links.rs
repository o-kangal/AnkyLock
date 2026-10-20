use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

/// Only web links leave the app: no `file:`, `javascript:` or custom schemes, and no control
/// characters or whitespace that a shell or URL handler could misread.
fn check_web_url(url: &str) -> AppResult<&str> {
    let lower = url.get(..8).unwrap_or(url).to_ascii_lowercase();
    let web = lower.starts_with("https://") || lower.starts_with("http://");
    if !web || url.len() > 4096 || url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::InvalidTransition("Only http and https links can be opened.".into()));
    }
    Ok(url)
}

/// Opens a link from a note in the system browser (Ctrl/⌘+click in the editor).
#[tauri::command]
pub fn link_open(app: AppHandle, url: String) -> AppResult<()> {
    app.opener()
        .open_url(check_web_url(&url)?, None::<&str>)
        .map_err(|e| AppError::Io(std::io::Error::other(format!("Could not open the browser: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::check_web_url;

    #[test]
    fn opens_only_web_links() {
        assert!(check_web_url("https://ankylock.com/a?b=c#d").is_ok());
        assert!(check_web_url("HTTP://example.com").is_ok());
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "ftp://x", "https://a b", "https://a\n", "mailto:a@b", "", "https:"] {
            let err = check_web_url(bad).expect_err(bad);
            assert_eq!(err.code(), "ERR_INVALID_TRANSITION");
        }
    }
}
