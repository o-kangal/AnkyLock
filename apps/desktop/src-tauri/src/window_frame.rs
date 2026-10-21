//! Rounded window corners on Linux. The window is frameless and transparent
//! (`tauri.linux.conf.json`) and the frontend draws its content in a rounded frame
//! (`src/windowFrame.ts`). On Wayland, GTK still draws the window's client-side decoration (its
//! shadow and outline) around it, with the theme's own corners; matching them to the app's
//! keeps square corners from showing behind it, and leaves the shadow to GTK.

/// Must match `tokens.radiusPanel`, the radius of the frontend's window frame.
pub const CORNER_RADIUS_PX: u32 = 12;

/// GTK CSS for the decoration: rounded while floating or tiled, square when maximized or
/// fullscreen, where the frontend drops its corners too.
pub fn decoration_css() -> String {
    format!(
        "decoration {{ border-radius: {CORNER_RADIUS_PX}px; }}\n\
         window.maximized decoration, window.fullscreen decoration {{ border-radius: 0; }}\n"
    )
}

pub fn round_corners(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    use gtk::prelude::*;

    let gtk_window = window.gtk_window()?;
    let provider = gtk::CssProvider::new();
    provider.load_from_data(decoration_css().as_bytes())?;
    if let Some(screen) = GtkWindowExt::screen(&gtk_window) {
        gtk::StyleContext::add_provider_for_screen(&screen, &provider, gtk::STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoration_matches_the_frontend_frame() {
        let tokens = include_str!("../../../web/src/components/sidebar/styles.ts");
        assert!(tokens.contains(&format!("radiusPanel: '{CORNER_RADIUS_PX}px'")));
        let css = decoration_css();
        assert!(css.starts_with("decoration { border-radius: 12px; }"));
        assert!(css.contains("window.maximized decoration, window.fullscreen decoration { border-radius: 0; }"));
    }
}
