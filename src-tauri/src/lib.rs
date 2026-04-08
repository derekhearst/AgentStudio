use tauri::{App, Url, WebviewUrl, WebviewWindowBuilder};

const DEV_SERVER_URL: &str = "http://localhost:5173";
const MAIN_WINDOW_HEIGHT: f64 = 900.0;
const MAIN_WINDOW_LABEL: &str = "main";
const MAIN_WINDOW_TITLE: &str = "AgentStudio";
const MAIN_WINDOW_WIDTH: f64 = 1200.0;

fn main_window_url() -> WebviewUrl {
    if let Some(remote_url) = option_env!("TAURI_REMOTE_URL").filter(|value| !value.trim().is_empty()) {
        return WebviewUrl::External(
            remote_url
                .parse::<Url>()
                .expect("TAURI_REMOTE_URL must be a valid absolute URL"),
        );
    }

    #[cfg(debug_assertions)]
    {
        return WebviewUrl::External(
            DEV_SERVER_URL
                .parse::<Url>()
                .expect("DEV_SERVER_URL must be a valid absolute URL"),
        );
    }

    #[cfg(not(debug_assertions))]
    {
        WebviewUrl::App("index.html".into())
    }
}

fn build_main_window(app: &App) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, main_window_url())
        .title(MAIN_WINDOW_TITLE)
        .inner_size(MAIN_WINDOW_WIDTH, MAIN_WINDOW_HEIGHT)
        .resizable(true)
        .build()?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            build_main_window(app)?;
            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}