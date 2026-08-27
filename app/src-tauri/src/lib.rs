use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

struct TrayMenuItems {
    sync_info: MenuItem<tauri::Wry>,
    posting_count: MenuItem<tauri::Wry>,
}

#[tauri::command]
fn update_tray_info(
    state: tauri::State<'_, Mutex<TrayMenuItems>>,
    last_sync: String,
    new_count: u32,
) -> Result<(), String> {
    let items = state.lock().map_err(|e| e.to_string())?;
    items
        .sync_info
        .set_text(format!("Last sync: {last_sync}"))
        .map_err(|e| e.to_string())?;
    items
        .posting_count
        .set_text(format!("New postings: {new_count}"))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn show_window(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app);
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .invoke_handler(tauri::generate_handler![update_tray_info, show_window])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // System tray menu items
            let open = MenuItem::with_id(app, "open", "Open Nightjar", true, None::<&str>)?;
            let sync_info =
                MenuItem::with_id(app, "sync_info", "Last sync: never", false, None::<&str>)?;
            let posting_count =
                MenuItem::with_id(app, "posting_count", "New postings: 0", false, None::<&str>)?;
            let sync_now = MenuItem::with_id(app, "sync_now", "Sync now", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &sync_info,
                    &posting_count,
                    &PredefinedMenuItem::separator(app)?,
                    &sync_now,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;

            // Store dynamic menu items for later updates from frontend
            app.manage(Mutex::new(TrayMenuItems {
                sync_info: sync_info.clone(),
                posting_count: posting_count.clone(),
            }));

            // Build system tray
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Nightjar")
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main_window(app),
                    "sync_now" => {
                        let _ = app.emit("trigger-sync", ());
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // Minimize to tray on window close instead of quitting
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });

                // Auto-launch with --minimized: start hidden, tray only
                if std::env::args().any(|a| a == "--minimized") {
                    let _ = window.hide();
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
