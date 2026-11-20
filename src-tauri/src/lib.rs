mod live_match;
mod local_api;
mod replay;
mod riot_auth;

use tauri::Manager;

#[tauri::command]
fn window_close_or_tray(app: tauri::AppHandle) {
    if replay::host::should_minimize_to_tray(&app) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
    } else {
        replay::host::shutdown_tray(&app);
        app.exit(0);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_in_background = std::env::args().any(|a| a == "--background");

    tauri::Builder::default()
        // Registered first: a second launch (e.g. while the app is hidden in the
        // tray) is forwarded to the running instance and exits immediately
        // instead of starting a duplicate recorder + tray icon.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Autostart launches use `--background`; they must not pop the
            // window open when the app is already running.
            if argv.iter().any(|arg| arg == "--background") {
                return;
            }
            replay::host::show_main_window(app, None);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let host = replay::host::init(app.handle().clone());
            app.manage(host);
            if start_in_background {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let app = window.app_handle();
                    if replay::host::should_minimize_to_tray(app) {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        replay::host::shutdown_tray(app);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            window_close_or_tray,
            live_match::fetch_live_match,
            live_match::fetch_player_loadout,
            local_api::fetch_crosshair_settings,
            local_api::fetch_storefront,
            riot_auth::riot_login,
            riot_auth::riot_last_session,
            riot_auth::riot_logout,
            replay::host::replay_get_state,
            replay::host::replay_update_config,
            replay::host::replay_toggle_recording,
            replay::host::replay_save_now,
            replay::host::replay_set_autostart,
            replay::host::replay_suspend_hotkeys,
            replay::host::replay_poll_pressed_key,
            replay::host::replay_pick_folder,
            replay::host::replay_open_folder,
            replay::host::replay_reveal_file,
            replay::host::clips_scan,
            replay::host::clips_inspect,
            replay::host::clips_import_dialog,
            replay::host::clips_create_folder,
            replay::host::clips_rename_folder,
            replay::host::clips_move_clips,
            replay::host::clips_delete_items,
            replay::host::clips_delete_folder,
            replay::host::clips_preview_export_plan,
            replay::host::clips_start_export,
            replay::host::clips_get_export_status,
            replay::host::clips_cancel_export,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
