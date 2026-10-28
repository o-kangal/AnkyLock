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

/// The AppImage launcher points library, module and data paths into its bundle. Host programs
/// that open a URL (xdg-open, gio, flatpak) inherit them, load the bundled older libraries and
/// crash, so nothing opens. Returns each such variable with the bundle's entries removed, or
/// `None` when nothing else is left.
fn without_bundle_paths(vars: impl IntoIterator<Item = (String, String)>, appdir: &str) -> Vec<(String, Option<String>)> {
    vars.into_iter()
        .filter(|(_, value)| value.contains(appdir))
        .map(|(key, value)| {
            let kept: Vec<&str> = value.split(':').filter(|part| !part.is_empty() && !part.contains(appdir)).collect();
            (key, (!kept.is_empty()).then(|| kept.join(":")))
        })
        .collect()
}

/// Opens `url` in the system browser. Inside an AppImage, xdg-open runs with the host's own
/// environment; elsewhere the opener plugin does the work.
pub fn open_in_browser(app: &AppHandle, url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    if let Some(appdir) = std::env::var("APPDIR").ok().filter(|dir| !dir.is_empty()) {
        use std::process::{Command, Stdio};
        let vars = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
        let mut command = Command::new("xdg-open");
        command.arg(url).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        // The launcher forces its own GTK theme, which would restyle the browser.
        command.env_remove("GTK_THEME");
        for (key, value) in without_bundle_paths(vars, &appdir) {
            match value {
                Some(value) => command.env(key, value),
                None => command.env_remove(key),
            };
        }
        let mut child = command.spawn()?;
        // xdg-open returns once the browser has the URL; reap it so it does not linger.
        std::thread::spawn(move || child.wait());
        return Ok(());
    }
    app.opener().open_url(url, None::<&str>).map_err(std::io::Error::other)
}

/// Opens a link from a note in the system browser (Ctrl/⌘+click in the editor).
#[tauri::command]
pub fn link_open(app: AppHandle, url: String) -> AppResult<()> {
    open_in_browser(&app, check_web_url(&url)?)
        .map_err(|e| AppError::Io(std::io::Error::other(format!("Could not open the browser: {e}"))))
}

#[cfg(test)]
mod tests {
    use super::{check_web_url, without_bundle_paths};

    #[test]
    fn opens_only_web_links() {
        assert!(check_web_url("https://ankylock.com/a?b=c#d").is_ok());
        assert!(check_web_url("HTTP://example.com").is_ok());
        for bad in ["javascript:alert(1)", "file:///etc/passwd", "ftp://x", "https://a b", "https://a\n", "mailto:a@b", "", "https:"] {
            let err = check_web_url(bad).expect_err(bad);
            assert_eq!(err.code(), "ERR_INVALID_TRANSITION");
        }
    }

    #[test]
    fn strips_appimage_bundle_paths_from_the_environment() {
        let appdir = "/tmp/.mount_ankyloX";
        let vars = [
            ("LD_LIBRARY_PATH", "/tmp/.mount_ankyloX/usr/lib/:/tmp/.mount_ankyloX/lib/:"),
            ("XDG_DATA_DIRS", "/tmp/.mount_ankyloX/usr/share:/usr/share:/usr/local/share"),
            ("GIO_MODULE_DIR", "/tmp/.mount_ankyloX//usr/lib/gio/modules"),
            ("HOME", "/home/me"),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned()));
        assert_eq!(
            without_bundle_paths(vars, appdir),
            [
                ("LD_LIBRARY_PATH".to_owned(), None),
                ("XDG_DATA_DIRS".to_owned(), Some("/usr/share:/usr/local/share".to_owned())),
                ("GIO_MODULE_DIR".to_owned(), None),
            ]
        );
    }
}
