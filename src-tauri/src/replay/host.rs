//! Background Win32 Global Hotkeys + System Tray host & Tauri Command bridge for `#2009 tracker`.
//! Integrates `santiremedi/clippy`'s GPU Recorder and Media Foundation Clip Editor into Tauri.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Gdi::{CreateBitmap, DeleteObject};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT,
};
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

use super::autostart;
use super::clipcache;
use super::config::{self, Config, GlobalAction};
use super::keys::{hotkey_name, pressed_key};
use super::library::{self, Asset, Folder};
use super::log::{file_stamp, log};
use super::media::{self, Clip, Curve, Edit, ExportOpts, Frame, Progress, Sizing, Target};
use super::mf::Mf;
use super::record::audio;
use super::record::recorder::{Event, Notify, Recorder};
use super::sound;

const WM_TRAY: u32 = WM_APP + 1;
const WM_REC_EVENT: u32 = WM_APP + 2;
const WM_APPLY_CONFIG: u32 = WM_APP + 3;
const WM_SAVE_NOW: u32 = WM_APP + 4;
const WM_HOTKEY_SUSPEND: u32 = WM_APP + 5;
const WM_SHUTDOWN: u32 = WM_APP + 6;
const NIN_BALLOONUSERCLICK: u32 = WM_USER + 5;

const ID_EDITOR: usize = 10;
const ID_SAVE: usize = 11;
const ID_FOLDER: usize = 12;
const ID_TOGGLE: usize = 13;
const ID_MIC: usize = 14;
const ID_RECORDER_TAB: usize = 15;
const ID_SHOW_APP: usize = 16;
const ID_EXIT: usize = 17;

pub struct ExportJobState {
    pub progress: Arc<Progress>,
    pub out_path: PathBuf,
}

pub struct SharedHost {
    pub cfg: Config,
    pub hwnd: isize,
    pub encoder_name: Option<String>,
    pub detected_game: Option<String>,
    pub error: Option<String>,
    pub failed_hotkeys: Vec<String>,
    pub events: VecDeque<Event>,
    pub export_job: Option<ExportJobState>,
    pub tray_balloon_shown: bool,
}

#[derive(Clone)]
pub struct ReplayHostHandle(pub Arc<Mutex<SharedHost>>);

// --- DTOs for Frontend ---

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyLabelsDto {
    pub save_clip: String,
    pub toggle_recording: String,
    pub open_editor: String,
    pub open_folder: String,
    pub overlay_toggle: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MicrophoneDto {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStateDto {
    pub config: Config,
    pub encoder_name: Option<String>,
    pub detected_game: Option<String>,
    pub error: Option<String>,
    pub typical_ram_mb: u32,
    pub autostart: bool,
    pub hotkey_labels: HotkeyLabelsDto,
    pub failed_hotkeys: Vec<String>,
    pub microphones: Vec<MicrophoneDto>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PressedKeyDto {
    pub vk: u32,
    pub mods: u32,
    pub label: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipSavedEventDto {
    pub path: String,
    pub title: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryScanDto {
    pub root_dir: String,
    pub current_dir: Option<String>,
    pub folders: Vec<Folder>,
    pub assets: Vec<Asset>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDto {
    pub duration_100ns: i64,
    pub duration_sec: f64,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub codec: String,
    pub has_audio: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipInspectDto {
    pub path: String,
    pub probe: ProbeDto,
    pub thumb_path: Option<String>,
    pub peaks: Vec<f32>,
    pub rms: Vec<f32>,
    pub keyframes: Vec<i64>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ClipPieceDto {
    pub id: u64,
    pub path: String,
    pub start: i64,
    pub len: i64,
    pub src_in: i64,
    pub speed: f64,
    pub fade_in: i64,
    pub fade_out: i64,
    pub gain: f32,
    #[serde(default)]
    pub curve_in: String,
    #[serde(default)]
    pub curve_out: String,
    #[serde(default)]
    pub turns: u8,
    #[serde(default)]
    pub flip: bool,
    #[serde(default = "default_crop")]
    pub crop: [f32; 4],
    #[serde(default)]
    pub sizing: String,
}

fn default_crop() -> [f32; 4] {
    [0.0, 0.0, 1.0, 1.0]
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportEditDto {
    pub video_tracks: Vec<Vec<ClipPieceDto>>,
    pub audio_tracks: Vec<Vec<ClipPieceDto>>,
    pub ratio: Option<[u32; 2]>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequestDto {
    pub edit: ExportEditDto,
    pub name: String,
    pub dir: String,
    /// 0 = Original, 1440 / 1080 / 720
    pub height: u32,
    /// 0 = Original, 60 / 30
    pub fps: u32,
    /// "recommended" | "high" | "medium" | "low" | "maxsize"
    pub quality: String,
    pub size_mb: u32,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlanDto {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub bitrate: u32,
    pub constant: bool,
    pub can_lossless_copy: bool,
    pub estimated_bytes: f64,
    pub duration_sec: f64,
    pub original_quality: bool,
    pub low_quality_warning: bool,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportStatusDto {
    pub active: bool,
    pub progress: f32,
    pub out_path: Option<String>,
    pub finished_mode: Option<String>,
    pub error: Option<String>,
}

// --- Initialization & Win32 Host Thread ---

pub fn init(app: AppHandle) -> ReplayHostHandle {
    autostart::repair();
    std::thread::spawn(clipcache::prune);

    let first_run = !config::exists();
    let cfg = config::load();
    if first_run {
        let _ = config::save(&cfg);
    }

    let shared = Arc::new(Mutex::new(SharedHost {
        cfg: cfg.clone(),
        hwnd: 0,
        encoder_name: None,
        detected_game: None,
        error: None,
        failed_hotkeys: Vec::new(),
        events: VecDeque::new(),
        export_job: None,
        tray_balloon_shown: false,
    }));

    let shared_thread = shared.clone();
    std::thread::Builder::new()
        .name("2009-win32-host".into())
        .spawn(move || host_thread_main(app, shared_thread))
        .expect("failed to spawn Win32 recorder host thread");

    ReplayHostHandle(shared)
}

pub fn should_minimize_to_tray(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<ReplayHostHandle>() else {
        return false;
    };
    let Ok(mut g) = state.0.lock() else {
        return false;
    };
    let keep = g.cfg.minimize_to_tray && g.cfg.enabled;
    if keep && !g.tray_balloon_shown {
        g.tray_balloon_shown = true;
        let hwnd = HWND(g.hwnd as *mut _);
        let key = hotkey_name(g.cfg.hotkey_vk, g.cfg.hotkey_mods);
        let secs = g.cfg.seconds;
        drop(g);
        if !hwnd.is_invalid() {
            show_tray_balloon(
                hwnd,
                "#2009 tracker はバックグラウンドで録画中",
                &format!(
                    "{key} で直近 {secs} 秒のクリップを保存できます。トレイアイコンからいつでも再表示・終了できます。"
                ),
                false,
            );
        }
    }
    keep
}

pub fn shutdown_tray(app: &AppHandle) {
    if let Some(state) = app.try_state::<ReplayHostHandle>() {
        if let Ok(g) = state.0.lock() {
            if g.hwnd != 0 {
                unsafe {
                    let _ = PostMessageW(HWND(g.hwnd as *mut _), WM_SHUTDOWN, WPARAM(0), LPARAM(0));
                }
            }
        }
    }
}

pub(crate) fn show_main_window(app: &AppHandle, navigate_to: Option<&str>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    if let Some(route) = navigate_to {
        let _ = app.emit("replay:navigate", route);
    }
}

struct ThreadCtx {
    app: AppHandle,
    shared: Arc<Mutex<SharedHost>>,
    hwnd: HWND,
    applied_cfg: Config,
    rec: Option<Recorder>,
    icon_on: HICON,
    icon_off: HICON,
    taskbar_created_msg: u32,
}

thread_local! {
    static HOST_CTX: std::cell::RefCell<Option<ThreadCtx>> = const { std::cell::RefCell::new(None) };
}

fn with_ctx<R>(f: impl FnOnce(&mut ThreadCtx) -> R) -> Option<R> {
    HOST_CTX.with(|c| c.try_borrow_mut().ok().and_then(|mut b| b.as_mut().map(f)))
}

fn host_thread_main(app: AppHandle, shared: Arc<Mutex<SharedHost>>) {
    unsafe {
        let hinst: HINSTANCE = GetModuleHandleW(None).unwrap_or_default().into();
        let class_name = w!("Tracker2009RecorderHost");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wndproc),
            hInstance: hinst,
            lpszClassName: class_name,
            ..Default::default()
        };
        let _ = RegisterClassW(&wc);
        let Ok(hwnd) = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class_name,
            w!("2009TrackerHost"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            hinst,
            None,
        ) else {
            log("Win32ホストウィンドウの作成に失敗しました");
            return;
        };

        let taskbar_created_msg = RegisterWindowMessageW(w!("TaskbarCreated"));
        let size = GetSystemMetrics(SM_CXSMICON).max(16) as u32;
        let icon_on = create_status_hicon(size, true);
        let icon_off = create_status_hicon(size, false);

        let initial_cfg = {
            let mut g = shared.lock().unwrap();
            g.hwnd = hwnd.0 as isize;
            g.cfg.clone()
        };

        let ctx = ThreadCtx {
            app,
            shared,
            hwnd,
            applied_cfg: Config { enabled: false, ..initial_cfg.clone() },
            rec: None,
            icon_on,
            icon_off,
            taskbar_created_msg,
        };
        ctx.update_tray(NIM_ADD);
        HOST_CTX.with(|c| *c.borrow_mut() = Some(ctx));
        with_ctx(|c| c.apply(initial_cfg, true));

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

fn make_notifier(hwnd: HWND, shared: Arc<Mutex<SharedHost>>) -> Notify {
    let h = hwnd.0 as isize;
    Arc::new(move |ev| {
        if let Ok(mut g) = shared.lock() {
            g.events.push_back(ev);
        }
        unsafe {
            let _ = PostMessageW(HWND(h as *mut _), WM_REC_EVENT, WPARAM(0), LPARAM(0));
        }
    })
}

impl ThreadCtx {
    fn apply(&mut self, new_cfg: Config, startup: bool) {
        let restart = new_cfg.video_params() != self.applied_cfg.video_params();
        let keys = |c: &Config| (GlobalAction::ALL.map(|a| c.hotkey(a)), c.enabled);
        let hotkey_changed = keys(&new_cfg) != keys(&self.applied_cfg);
        self.applied_cfg = new_cfg.clone();

        if restart || (self.applied_cfg.enabled && self.rec.is_none()) {
            self.rec = None;
            if let Ok(mut g) = self.shared.lock() {
                g.error = None;
                g.encoder_name = None;
                if !self.applied_cfg.enabled {
                    g.detected_game = None;
                }
            }
            if self.applied_cfg.enabled {
                self.rec = Some(Recorder::start(
                    self.applied_cfg.clone(),
                    make_notifier(self.hwnd, self.shared.clone()),
                ));
            }
        } else if let Some(r) = &self.rec {
            r.update(self.applied_cfg.clone());
        }

        if hotkey_changed || startup {
            let failed = self.register_hotkeys();
            if let Ok(mut g) = self.shared.lock() {
                g.failed_hotkeys = failed.clone();
            }
            if !failed.is_empty() && !startup {
                let k = failed.join(", ");
                show_tray_balloon(
                    self.hwnd,
                    "ショートカットキーが競合しています",
                    &format!("{k} は他のアプリで使用中です。録画設定から別のキーを選択してください。"),
                    true,
                );
            }
        }

        self.update_tray(NIM_MODIFY);
        let _ = self.app.emit("replay:state-changed", ());
    }

    fn unregister_all(&self) {
        unsafe {
            for a in GlobalAction::ALL {
                let _ = UnregisterHotKey(self.hwnd, a.id());
            }
        }
    }

    fn register_hotkeys(&self) -> Vec<String> {
        self.unregister_all();
        let mut failed = Vec::new();
        for a in GlobalAction::ALL {
            let (vk, mods) = self.applied_cfg.hotkey(a);
            if vk == 0 || (a == GlobalAction::SaveClip && !self.applied_cfg.enabled) {
                continue;
            }
            let ok = unsafe {
                RegisterHotKey(self.hwnd, a.id(), HOT_KEY_MODIFIERS(mods | MOD_NOREPEAT.0), vk).is_ok()
            };
            if !ok {
                failed.push(hotkey_name(vk, mods));
            }
        }
        failed
    }

    fn tip(&self) -> String {
        let (err, game) = self
            .shared
            .lock()
            .map(|g| (g.error.clone(), g.detected_game.clone()))
            .unwrap_or((None, None));
        if let Some(e) = err {
            return format!("#2009 tracker · 録画エラー: {e}");
        }
        if self.applied_cfg.enabled {
            let mut t = format!(
                "#2009 tracker · 録画中 · {} で直近{}秒を保存",
                hotkey_name(self.applied_cfg.hotkey_vk, self.applied_cfg.hotkey_mods),
                self.applied_cfg.seconds
            );
            if let Some(g) = game {
                t.push_str(&format!(" · {g}"));
            }
            t
        } else {
            "#2009 tracker · 録画一時停止中".into()
        }
    }

    fn update_tray(&self, op: NOTIFY_ICON_MESSAGE) {
        let has_err = self.shared.lock().map(|g| g.error.is_some()).unwrap_or(false);
        let mut n = nid(self.hwnd);
        n.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
        n.uCallbackMessage = WM_TRAY;
        n.hIcon = if self.applied_cfg.enabled && !has_err {
            self.icon_on
        } else {
            self.icon_off
        };
        set_wstr(&mut n.szTip, &self.tip());
        unsafe {
            let _ = Shell_NotifyIconW(op, &n);
        }
    }

    fn handle_event(&mut self, ev: Event) {
        match ev {
            Event::Started(enc) => {
                if let Ok(mut g) = self.shared.lock() {
                    g.encoder_name = Some(enc);
                    g.error = None;
                }
                self.update_tray(NIM_MODIFY);
                let _ = self.app.emit("replay:state-changed", ());
            }
            Event::Game(game) => {
                if let Ok(mut g) = self.shared.lock() {
                    g.detected_game = game;
                }
                self.update_tray(NIM_MODIFY);
                let _ = self.app.emit("replay:state-changed", ());
            }
            Event::Saved(path) => {
                let title = library::pretty_name(&path);
                let payload = ClipSavedEventDto {
                    path: path.to_string_lossy().into_owned(),
                    title,
                };
                let _ = self.app.emit("replay:clip-saved", payload);
                let _ = self.app.emit("replay:state-changed", ());
            }
            Event::SaveFailed(msg) => {
                let _ = self.app.emit("replay:save-failed", &msg);
                show_tray_balloon(self.hwnd, "クリップを保存できませんでした", &msg, true);
            }
            Event::Error(err) => {
                let first_err = if let Ok(mut g) = self.shared.lock() {
                    let was_none = g.error.is_none();
                    g.error = Some(err.clone());
                    was_none
                } else {
                    false
                };
                self.update_tray(NIM_MODIFY);
                let _ = self.app.emit("replay:state-changed", ());
                if first_err {
                    log(&format!("録画エラー通知: {err}"));
                }
            }
        }
    }

    fn toggle_recording(&mut self, play_chime: bool) {
        let mut next = self.applied_cfg.clone();
        next.enabled = !next.enabled;
        let _ = config::save(&next);
        if let Ok(mut g) = self.shared.lock() {
            g.cfg = next.clone();
        }
        self.apply(next.clone(), false);
        if play_chime {
            if next.enabled {
                sound::play_resumed();
            } else {
                sound::play_paused();
            }
        }
    }

    fn toggle_mic(&mut self) {
        let mut next = self.applied_cfg.clone();
        next.mic_audio = !next.mic_audio;
        let _ = config::save(&next);
        if let Ok(mut g) = self.shared.lock() {
            g.cfg = next.clone();
        }
        self.apply(next, false);
    }

    fn shutdown(&mut self, exit_app: bool) {
        self.rec = None;
        self.unregister_all();
        unsafe {
            let _ = Shell_NotifyIconW(NIM_DELETE, &nid(self.hwnd));
            let _ = DestroyWindow(self.hwnd);
        }
        if exit_app {
            self.app.exit(0);
        }
    }
}

fn nid(hwnd: HWND) -> NOTIFYICONDATAW {
    NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        ..Default::default()
    }
}

fn show_tray_balloon(hwnd: HWND, title: &str, text: &str, warn: bool) {
    let mut n = nid(hwnd);
    n.uFlags = NIF_INFO;
    set_wstr(&mut n.szInfoTitle, title);
    set_wstr(&mut n.szInfo, text);
    n.dwInfoFlags = if warn { NIIF_WARNING } else { NIIF_INFO };
    unsafe {
        let _ = Shell_NotifyIconW(NIM_MODIFY, &n);
    }
}

fn set_wstr(dst: &mut [u16], s: &str) {
    let v: Vec<u16> = s.encode_utf16().take(dst.len().saturating_sub(1)).collect();
    dst[..v.len()].copy_from_slice(&v);
    dst[v.len()] = 0;
}

fn show_tray_menu(hwnd: HWND) {
    let Some((enabled, mic, key)) = with_ctx(|c| {
        (
            c.applied_cfg.enabled,
            c.applied_cfg.mic_audio,
            hotkey_name(c.applied_cfg.hotkey_vk, c.applied_cfg.hotkey_mods),
        )
    }) else {
        return;
    };
    unsafe {
        let Ok(menu) = CreatePopupMenu() else { return };
        let _ = AppendMenuW(menu, MF_STRING, ID_EDITOR, w!("クリップ編集を開く"));
        let _ = SetMenuDefaultItem(menu, ID_EDITOR as u32, 0);
        let save_label = HSTRING::from(format!("今すぐクリップを保存\t{key}"));
        let save_flags = if enabled { MF_STRING } else { MF_STRING | MF_GRAYED };
        let _ = AppendMenuW(menu, save_flags, ID_SAVE, &save_label);
        let _ = AppendMenuW(menu, MF_STRING, ID_FOLDER, w!("保存先フォルダを開く"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(
            menu,
            MF_STRING | if enabled { MF_CHECKED } else { MF_UNCHECKED },
            ID_TOGGLE,
            w!("インスタントリプレイ録画中"),
        );
        let _ = AppendMenuW(
            menu,
            MF_STRING | if mic { MF_CHECKED } else { MF_UNCHECKED },
            ID_MIC,
            w!("マイク録音"),
        );
        let _ = AppendMenuW(menu, MF_STRING, ID_RECORDER_TAB, w!("録画設定を開く"));
        let _ = AppendMenuW(menu, MF_STRING, ID_SHOW_APP, w!("#2009 tracker を表示"));
        let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
        let _ = AppendMenuW(menu, MF_STRING, ID_EXIT, w!("終了"));

        let mut pt = POINT::default();
        let _ = GetCursorPos(&mut pt);
        let _ = SetForegroundWindow(hwnd);
        let cmd = TrackPopupMenu(
            menu,
            TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON,
            pt.x,
            pt.y,
            0,
            hwnd,
            None,
        );
        let _ = PostMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));
        let _ = DestroyMenu(menu);

        match cmd.0 as usize {
            ID_EDITOR => {
                with_ctx(|c| show_main_window(&c.app, Some("clips")));
            }
            ID_SAVE => {
                with_ctx(|c| {
                    if let Some(r) = &c.rec {
                        r.save();
                    }
                });
            }
            ID_FOLDER => {
                with_ctx(|c| library::open_folder(&c.applied_cfg.output_dir));
            }
            ID_TOGGLE => {
                with_ctx(|c| c.toggle_recording(false));
            }
            ID_MIC => {
                with_ctx(|c| c.toggle_mic());
            }
            ID_RECORDER_TAB => {
                with_ctx(|c| show_main_window(&c.app, Some("recorder")));
            }
            ID_SHOW_APP => {
                with_ctx(|c| show_main_window(&c.app, None));
            }
            ID_EXIT => {
                with_ctx(|c| c.shutdown(true));
            }
            _ => {}
        }
    }
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match msg {
        WM_TRAY => {
            match (lp.0 & 0xFFFF) as u32 {
                WM_LBUTTONUP => {
                    with_ctx(|c| show_main_window(&c.app, None));
                }
                NIN_BALLOONUSERCLICK => {
                    with_ctx(|c| show_main_window(&c.app, Some("clips")));
                }
                WM_RBUTTONUP => show_tray_menu(hwnd),
                _ => {}
            }
            LRESULT(0)
        }
        WM_HOTKEY => {
            match GlobalAction::from_id(wp.0 as i32) {
                Some(GlobalAction::SaveClip) => {
                    with_ctx(|c| {
                        if let Some(r) = &c.rec {
                            r.save();
                        }
                    });
                }
                Some(GlobalAction::ToggleRecording) => {
                    with_ctx(|c| c.toggle_recording(true));
                }
                Some(GlobalAction::OpenEditor) => {
                    with_ctx(|c| show_main_window(&c.app, Some("clips")));
                }
                Some(GlobalAction::OpenFolder) => {
                    with_ctx(|c| library::open_folder(&c.applied_cfg.output_dir));
                }
                Some(GlobalAction::OverlayToggle) => {
                    with_ctx(|c| {
                        let _ = crate::overlay::toggle(&c.app);
                    });
                }
                None => {}
            }
            LRESULT(0)
        }
        WM_APPLY_CONFIG => {
            with_ctx(|c| {
                let next = c.shared.lock().map(|g| g.cfg.clone()).unwrap_or_default();
                c.apply(next, false);
            });
            LRESULT(0)
        }
        WM_SAVE_NOW => {
            with_ctx(|c| {
                if let Some(r) = &c.rec {
                    r.save();
                } else {
                    let _ = c
                        .app
                        .emit("replay:save-failed", "現在録画がオフになっています");
                }
            });
            LRESULT(0)
        }
        WM_HOTKEY_SUSPEND => {
            with_ctx(|c| {
                if wp.0 == 1 {
                    c.unregister_all();
                } else {
                    c.register_hotkeys();
                }
            });
            LRESULT(0)
        }
        WM_REC_EVENT => {
            with_ctx(|c| {
                let evs: Vec<Event> = c
                    .shared
                    .lock()
                    .map(|mut g| g.events.drain(..).collect())
                    .unwrap_or_default();
                for ev in evs {
                    c.handle_event(ev);
                }
            });
            LRESULT(0)
        }
        WM_SHUTDOWN => {
            with_ctx(|c| c.shutdown(false));
            LRESULT(0)
        }
        WM_ENDSESSION if wp.0 == 0 => LRESULT(0),
        WM_CLOSE | WM_ENDSESSION => {
            with_ctx(|c| c.shutdown(true));
            LRESULT(0)
        }
        WM_DESTROY => {
            PostQuitMessage(0);
            LRESULT(0)
        }
        _ => {
            let is_tc = with_ctx(|c| c.taskbar_created_msg != 0 && msg == c.taskbar_created_msg)
                .unwrap_or(false);
            if is_tc {
                with_ctx(|c| c.update_tray(NIM_ADD));
                return LRESULT(0);
            }
            DefWindowProcW(hwnd, msg, wp, lp)
        }
    }
}

/// Custom monochrome `#2009 tracker` status tray icon (crisp anti-aliased ring + active dot).
fn create_status_hicon(size: u32, on: bool) -> HICON {
    let s = size.max(16);
    let mut bgra = vec![0u8; (s * s * 4) as usize];
    let center = (s as f32 - 1.0) * 0.5;
    let half = s as f32 * 0.44;
    let corner = s as f32 * 0.24;

    for y in 0..s {
        for x in 0..s {
            let dx = (x as f32 - center).abs();
            let dy = (y as f32 - center).abs();
            // Signed distance to rounded box
            let qx = (dx - (half - corner)).max(0.0);
            let qy = (dy - (half - corner)).max(0.0);
            let box_dist = (qx * qx + qy * qy).sqrt() - corner;
            let box_alpha = (0.6 - box_dist).clamp(0.0, 1.0);
            if box_alpha <= 0.0 {
                continue;
            }

            let r_dist = ((x as f32 - center).powi(2) + (y as f32 - center).powi(2)).sqrt();
            let ring_r = s as f32 * 0.27;
            let ring_w = (s as f32 * 0.065).max(1.1);
            let ring_cov = (ring_w - (r_dist - ring_r).abs()).clamp(0.0, 1.0);

            let fg = if on {
                let dot_r = s as f32 * 0.125;
                let dot_cov = (dot_r + 0.5 - r_dist).clamp(0.0, 1.0);
                ring_cov.max(dot_cov) * 0.96
            } else {
                ring_cov * 0.42
            };

            // Base #111111 + subtle border + foreground #f2f2f2
            let border = (1.1 - box_dist.abs()).clamp(0.0, 1.0) * 0.22;
            let lum = (17.0 + border * 180.0 + fg * 225.0).clamp(0.0, 245.0);
            let a = (box_alpha * 255.0).round() as u32;
            let premul = ((lum as u32) * a / 255) as u8;

            let idx = ((y * s + x) * 4) as usize;
            bgra[idx] = premul;
            bgra[idx + 1] = premul;
            bgra[idx + 2] = premul;
            bgra[idx + 3] = a as u8;
        }
    }

    let mask = vec![0u8; s.div_ceil(16) as usize * 2 * s as usize];
    unsafe {
        let color = CreateBitmap(s as i32, s as i32, 1, 32, Some(bgra.as_ptr() as *const _));
        let mask_bmp = CreateBitmap(s as i32, s as i32, 1, 1, Some(mask.as_ptr() as *const _));
        let ii = ICONINFO {
            fIcon: true.into(),
            xHotspot: 0,
            yHotspot: 0,
            hbmMask: mask_bmp,
            hbmColor: color,
        };
        let icon = CreateIconIndirect(&ii).unwrap_or_default();
        let _ = DeleteObject(color);
        let _ = DeleteObject(mask_bmp);
        icon
    }
}

fn build_state_dto(shared: &SharedHost, include_mics: bool) -> ReplayStateDto {
    let cfg = &shared.cfg;
    let microphones = if include_mics {
        let _mf = Mf::init();
        audio::capture_devices()
            .into_iter()
            .map(|(id, name)| MicrophoneDto { id, name })
            .collect()
    } else {
        Vec::new()
    };
    ReplayStateDto {
        config: cfg.clone(),
        encoder_name: shared.encoder_name.clone(),
        detected_game: shared.detected_game.clone(),
        error: shared.error.clone(),
        typical_ram_mb: cfg.typical_ram_mb(),
        autostart: autostart::enabled(),
        hotkey_labels: HotkeyLabelsDto {
            save_clip: hotkey_name(cfg.hotkey_vk, cfg.hotkey_mods),
            toggle_recording: hotkey_name(cfg.toggle_vk, cfg.toggle_mods),
            open_editor: hotkey_name(cfg.editor_vk, cfg.editor_mods),
            open_folder: hotkey_name(cfg.folder_vk, cfg.folder_mods),
            overlay_toggle: hotkey_name(cfg.overlay_vk, cfg.overlay_mods),
        },
        failed_hotkeys: shared.failed_hotkeys.clone(),
        microphones,
    }
}

// --- Tauri Commands: Recorder & System ---

#[tauri::command]
pub async fn replay_get_state(state: State<'_, ReplayHostHandle>) -> Result<ReplayStateDto, String> {
    let handle = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let snap = {
            let g = handle.lock().map_err(|e| e.to_string())?;
            build_state_dto(&g, true)
        };
        Ok(snap)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn replay_update_config(
    mut config: Config,
    state: State<'_, ReplayHostHandle>,
) -> Result<ReplayStateDto, String> {
    config.sanitize();
    config::save(&config).map_err(|e| format!("設定の保存に失敗しました: {e}"))?;
    let hwnd = {
        let mut g = state.0.lock().map_err(|e| e.to_string())?;
        g.cfg = config;
        g.hwnd
    };
    if hwnd != 0 {
        unsafe {
            let _ = PostMessageW(HWND(hwnd as *mut _), WM_APPLY_CONFIG, WPARAM(0), LPARAM(0));
        }
    }
    replay_get_state(state).await
}

#[tauri::command]
pub async fn replay_toggle_recording(
    state: State<'_, ReplayHostHandle>,
) -> Result<ReplayStateDto, String> {
    let next = {
        let g = state.0.lock().map_err(|e| e.to_string())?;
        let mut c = g.cfg.clone();
        c.enabled = !c.enabled;
        c
    };
    replay_update_config(next, state).await
}

#[tauri::command]
pub fn replay_save_now(state: State<'_, ReplayHostHandle>) -> Result<(), String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    if !g.cfg.enabled {
        return Err("現在インスタントリプレイ録画がオフになっています".into());
    }
    if g.hwnd != 0 {
        unsafe {
            let _ = PostMessageW(HWND(g.hwnd as *mut _), WM_SAVE_NOW, WPARAM(0), LPARAM(0));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn replay_set_autostart(enabled: bool) -> Result<bool, String> {
    autostart::set(enabled);
    Ok(autostart::enabled())
}

#[tauri::command]
pub fn replay_suspend_hotkeys(
    suspend: bool,
    state: State<'_, ReplayHostHandle>,
) -> Result<(), String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    if g.hwnd != 0 {
        unsafe {
            let _ = PostMessageW(
                HWND(g.hwnd as *mut _),
                WM_HOTKEY_SUSPEND,
                WPARAM(if suspend { 1 } else { 0 }),
                LPARAM(0),
            );
        }
    }
    Ok(())
}

#[tauri::command]
pub fn replay_poll_pressed_key() -> Option<PressedKeyDto> {
    let (vk, mods) = pressed_key()?;
    Some(PressedKeyDto {
        vk,
        mods,
        label: hotkey_name(vk, mods),
    })
}

#[tauri::command]
pub async fn replay_pick_folder(initial: Option<String>) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let mut dlg = rfd::FileDialog::new().set_title("保存先フォルダを選択");
        if let Some(dir) = initial {
            let p = PathBuf::from(dir);
            if p.exists() {
                dlg = dlg.set_directory(p);
            }
        }
        Ok(dlg.pick_folder().map(|p| p.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn replay_open_folder(
    path: Option<String>,
    state: State<'_, ReplayHostHandle>,
) -> Result<(), String> {
    let target = match path {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => state.0.lock().map_err(|e| e.to_string())?.cfg.output_dir.clone(),
    };
    library::open_folder(&target);
    Ok(())
}

#[tauri::command]
pub fn replay_reveal_file(path: String) -> Result<(), String> {
    library::reveal_file(Path::new(&path));
    Ok(())
}

// --- Tauri Commands: Clip Studio Library & Inspection ---

#[tauri::command]
pub async fn clips_scan(
    subfolder: Option<String>,
    state: State<'_, ReplayHostHandle>,
) -> Result<LibraryScanDto, String> {
    let root = state.0.lock().map_err(|e| e.to_string())?.cfg.output_dir.clone();
    tokio::task::spawn_blocking(move || {
        let mut imported = library::load_imported();
        let before = imported.len();
        imported.retain(|p| p.exists());
        if imported.len() != before {
            library::save_imported(&imported);
        }
        let sub_path = subfolder
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_dir());
        let (folders, assets) = library::scan(&root, sub_path.as_deref(), &imported);
        Ok(LibraryScanDto {
            root_dir: root.to_string_lossy().into_owned(),
            current_dir: sub_path.map(|p| p.to_string_lossy().into_owned()),
            folders,
            assets,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clips_inspect(
    path: String,
    wave_buckets: Option<usize>,
) -> Result<ClipInspectDto, String> {
    tokio::task::spawn_blocking(move || {
        let _mf = Mf::init();
        let p = PathBuf::from(&path);
        let pr = media::probe(&p).map_err(|e| e.to_string())?;
        let thumb_path = library::ensure_thumbnail(&p, &pr).map(|t| t.to_string_lossy().into_owned());

        let buckets = wave_buckets.unwrap_or(0);
        let (peaks, rms, keyframes) = match clipcache::load(&p) {
            Some((wave, kf)) => {
                let (pk, rm) = if buckets > 0 {
                    wave.summary(pr.duration, buckets)
                } else {
                    (Vec::new(), Vec::new())
                };
                (pk, rm, kf)
            }
            None if buckets > 0 => {
                let kf = media::keyframes(&p).unwrap_or_default();
                let wave = if pr.audio.is_some() {
                    media::waveform(&p).unwrap_or_default()
                } else {
                    clipcache::Wave::default()
                };
                clipcache::save(&p, &wave, &kf);
                let (pk, rm) = wave.summary(pr.duration, buckets);
                (pk, rm, kf)
            }
            None => (Vec::new(), Vec::new(), Vec::new()),
        };

        Ok(ClipInspectDto {
            path,
            probe: ProbeDto {
                duration_100ns: pr.duration,
                duration_sec: pr.duration as f64 / 1e7,
                width: pr.width,
                height: pr.height,
                fps: pr.fps(),
                codec: pr.codec().to_string(),
                has_audio: pr.audio.is_some(),
            },
            thumb_path,
            peaks,
            rms,
            keyframes,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clips_import_dialog() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let files = rfd::FileDialog::new()
            .set_title("動画をインポート")
            .add_filter("動画ファイル", &library::VIDEO_EXTS)
            .pick_files()
            .unwrap_or_default();
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let mut imported = library::load_imported();
        let mut added = Vec::new();
        for f in files {
            if !imported.contains(&f) {
                imported.push(f.clone());
            }
            added.push(f.to_string_lossy().into_owned());
        }
        library::save_imported(&imported);
        Ok(added)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clips_create_folder(
    name: String,
    move_files: Vec<String>,
    state: State<'_, ReplayHostHandle>,
) -> Result<String, String> {
    let clean = name.trim();
    if !library::folder_name_ok(clean) {
        return Err("フォルダ名に使用できない文字（< > : \" / \\ | ? *）が含まれています".into());
    }
    let root = state.0.lock().map_err(|e| e.to_string())?.cfg.output_dir.clone();
    let target = root.join(clean);
    if target.exists() {
        return Err("同じ名前のフォルダが既に存在します".into());
    }
    std::fs::create_dir_all(&target).map_err(|e| format!("フォルダを作成できませんでした: {e}"))?;
    for f in move_files {
        let _ = library::move_into(Path::new(&f), &target);
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn clips_rename_folder(
    from_path: String,
    new_name: String,
    state: State<'_, ReplayHostHandle>,
) -> Result<Vec<(String, String)>, String> {
    let clean = new_name.trim();
    if !library::folder_name_ok(clean) {
        return Err("フォルダ名に使用できない文字が含まれています".into());
    }
    let root = state.0.lock().map_err(|e| e.to_string())?.cfg.output_dir.clone();
    let from = PathBuf::from(&from_path);
    let to = root.join(clean);
    if from == to {
        return Ok(Vec::new());
    }
    if to.exists() {
        return Err("同じ名前のフォルダが既に存在します".into());
    }
    let moved = library::rename_folder(&from, &to)
        .map_err(|e| format!("フォルダ名を変更できませんでした: {e}"))?;
    Ok(moved
        .into_iter()
        .map(|(a, b)| (a.to_string_lossy().into_owned(), b.to_string_lossy().into_owned()))
        .collect())
}

#[tauri::command]
pub fn clips_move_clips(
    paths: Vec<String>,
    target_dir: String,
) -> Result<Vec<(String, String)>, String> {
    let dir = PathBuf::from(target_dir);
    let mut moved = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        let dst = library::move_into(&src, &dir)
            .map_err(|e| format!("{} の移動に失敗しました: {e}", library::pretty_name(&src)))?;
        moved.push((p, dst.to_string_lossy().into_owned()));
    }
    Ok(moved)
}

#[tauri::command]
pub async fn clips_delete_items(paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let mut imported = library::load_imported();
        let mut own = Vec::new();
        let mut changed_imp = false;
        for p_str in paths {
            let p = PathBuf::from(&p_str);
            if let Some(pos) = imported.iter().position(|x| x == &p) {
                imported.remove(pos);
                changed_imp = true;
            } else if p.exists() {
                own.push(p);
            }
        }
        if changed_imp {
            library::save_imported(&imported);
        }
        for p in own {
            library::recycle(&p).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clips_delete_folder(folder_path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let dir = PathBuf::from(folder_path);
        if dir.exists() {
            library::recycle(&dir).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// --- Tauri Commands: Clip Studio Export ---

fn parse_curve(s: &str) -> Curve {
    match s {
        "linear" => Curve::Linear,
        "smooth" => Curve::Smooth,
        _ => Curve::Even,
    }
}

fn parse_sizing(s: &str) -> Sizing {
    match s {
        "fill" => Sizing::Fill,
        "stretch" => Sizing::Stretch,
        _ => Sizing::Whole,
    }
}

fn to_media_track(mut pieces: Vec<ClipPieceDto>) -> Vec<Clip> {
    pieces.sort_by_key(|p| p.start);
    let spans: Vec<(i64, i64)> = pieces.iter().map(|p| (p.start, p.start + p.len)).collect();
    let xfade = media::overlaps(&spans);
    pieces
        .into_iter()
        .zip(xfade)
        .map(|(p, xf)| Clip {
            id: p.id,
            path: PathBuf::from(p.path),
            start: p.start,
            len: p.len.max(1),
            src_in: p.src_in.max(0),
            speed: p.speed,
            fade: (p.fade_in.max(0), p.fade_out.max(0)),
            xfade: xf,
            gain: p.gain.max(0.0),
            curves: (parse_curve(&p.curve_in), parse_curve(&p.curve_out)),
            frame: Frame {
                turns: p.turns % 4,
                flip: p.flip,
                crop: p.crop,
                sizing: parse_sizing(&p.sizing),
            },
        })
        .collect()
}

fn to_media_edit(dto: &ExportEditDto) -> Edit {
    Edit {
        video: dto.video_tracks.iter().cloned().map(to_media_track).collect(),
        audio: dto.audio_tracks.iter().cloned().map(to_media_track).collect(),
        ratio: dto.ratio.map(|[w, h]| (w, h)),
    }
}

fn bits_per_pixel(quality: &str) -> f64 {
    match quality {
        "high" => 0.18,
        "medium" => 0.10,
        "low" => 0.06,
        _ => 0.13, // recommended / maxsize
    }
}

fn compute_export_plan(req: &ExportRequestDto) -> Result<(Edit, ExportPlanDto), String> {
    let _mf = Mf::init();
    let edit = to_media_edit(&req.edit);
    let first = edit
        .first_video()
        .ok_or_else(|| "エクスポートする映像クリップがありません".to_string())?;
    let src = media::probe(&first.path).map_err(|e| e.to_string())?;
    let total_s = (edit.len() as f64 / 1e7).max(0.1);
    let src_fps = src.fps().max(1.0);
    let (ow, oh) = media::canvas_size((src.width, src.height), edit.ratio, req.height);
    let ofps = if req.fps == 0 || req.fps as f64 >= src_fps - 0.5 {
        src_fps
    } else {
        req.fps as f64
    };
    let original = req.height == 0 && req.fps == 0 && req.quality == "recommended";

    let mut probes = HashMap::new();
    probes.insert(first.path.clone(), src.clone());
    for c in edit.video.iter().flatten() {
        if !probes.contains_key(&c.path) {
            if let Ok(pr) = media::probe(&c.path) {
                probes.insert(c.path.clone(), pr);
            }
        }
    }

    let parts = edit.copy_parts((src.width, src.height));
    let mut can_copy = original && parts.is_some();
    if can_copy {
        for p in parts.unwrap_or_default() {
            let same = probes.get(&p.path).is_some_and(|q| q.same_format(&src));
            if !same {
                can_copy = false;
                break;
            }
            let kf = clipcache::load(&p.path)
                .map(|(_, k)| k)
                .unwrap_or_else(|| media::keyframes(&p.path).unwrap_or_default());
            if !media::on_keyframe(&kf, p.src_in) {
                can_copy = false;
                break;
            }
        }
    }

    let copy_size: f64 = parts
        .unwrap_or_default()
        .iter()
        .map(|p| {
            let size = std::fs::metadata(&p.path).map_or(0, |m| m.len()) as f64;
            let dur = probes.get(&p.path).map(|q| q.duration).unwrap_or(1).max(1) as f64;
            size * p.len as f64 / dur
        })
        .sum();

    let (bitrate, constant) = if req.quality == "maxsize" {
        let mb = req.size_mb.max(1) as f64;
        let bits = mb * 1_000_000.0 * 8.0 * 0.94 / total_s - 192_000.0;
        (bits.clamp(300_000.0, 80_000_000.0) as u32, true)
    } else {
        let b = ow as f64 * oh as f64 * ofps * bits_per_pixel(&req.quality);
        (b.clamp(1_500_000.0, 80_000_000.0) as u32, false)
    };

    let render_bytes = (bitrate as f64 + 192_000.0) * total_s / 8.0;
    let low_quality = (bitrate as f64) / (ow as f64 * oh as f64 * ofps) < 0.045;

    Ok((
        edit,
        ExportPlanDto {
            width: ow,
            height: oh,
            fps: ofps,
            bitrate,
            constant,
            can_lossless_copy: can_copy,
            estimated_bytes: if can_copy { copy_size } else { render_bytes },
            duration_sec: total_s,
            original_quality: original,
            low_quality_warning: !can_copy && low_quality,
        },
    ))
}

#[tauri::command]
pub async fn clips_preview_export_plan(req: ExportRequestDto) -> Result<ExportPlanDto, String> {
    tokio::task::spawn_blocking(move || compute_export_plan(&req).map(|(_, p)| p))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clips_start_export(
    req: ExportRequestDto,
    state: State<'_, ReplayHostHandle>,
) -> Result<String, String> {
    {
        let g = state.0.lock().map_err(|e| e.to_string())?;
        if let Some(job) = &g.export_job {
            if job.progress.result.lock().unwrap().is_none() {
                return Err("すでに別のエクスポートが進行中です".into());
            }
        }
    }

    let handle = state.0.clone();
    tokio::task::spawn_blocking(move || {
        let (edit, plan) = compute_export_plan(&req)?;
        let raw_name = if req.name.trim().is_empty() {
            format!("2009_edit_{}", file_stamp())
        } else {
            req.name.trim().to_string()
        };
        let clean: String = raw_name
            .chars()
            .map(|c| if library::BAD_NAME.contains(c) { '_' } else { c })
            .collect();
        let dir = PathBuf::from(&req.dir);
        let _ = std::fs::create_dir_all(&dir);
        let mut out = dir.join(format!("{clean}.mp4"));
        let mut n = 2;
        while out.exists() {
            out = dir.join(format!("{clean} ({n}).mp4"));
            n += 1;
        }

        let target = (!plan.original_quality).then_some(Target {
            height: req.height,
            fps: req.fps,
            bitrate: plan.bitrate,
            constant: plan.constant,
        });
        let opts = ExportOpts { bitrate: plan.bitrate, target };
        let progress = Arc::new(Progress::new());

        {
            let mut g = handle.lock().map_err(|e| e.to_string())?;
            g.export_job = Some(ExportJobState {
                progress: progress.clone(),
                out_path: out.clone(),
            });
        }

        let out_ret = out.to_string_lossy().into_owned();
        std::thread::Builder::new()
            .name("2009-export".into())
            .spawn(move || {
                let _mf = Mf::init();
                let r = media::export(&edit, &out, &opts, &progress);
                if let Err(e) = &r {
                    log(&format!("export error: {e:?}"));
                }
                *progress.result.lock().unwrap() = Some(r.map_err(|e| e.to_string()));
            })
            .map_err(|e| e.to_string())?;

        Ok(out_ret)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn clips_get_export_status(state: State<'_, ReplayHostHandle>) -> Result<ExportStatusDto, String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    let Some(job) = &g.export_job else {
        return Ok(ExportStatusDto {
            active: false,
            progress: 0.0,
            out_path: None,
            finished_mode: None,
            error: None,
        });
    };
    let out_path = Some(job.out_path.to_string_lossy().into_owned());
    let prog = job.progress.get();
    let res = job.progress.result.lock().unwrap().clone();
    match res {
        None => Ok(ExportStatusDto {
            active: true,
            progress: prog,
            out_path,
            finished_mode: None,
            error: None,
        }),
        Some(Ok(mode)) => {
            g.export_job = None;
            Ok(ExportStatusDto {
                active: false,
                progress: 1.0,
                out_path,
                finished_mode: Some(mode),
                error: None,
            })
        }
        Some(Err(err)) => {
            let canceled = job.progress.cancel.load(Ordering::Relaxed);
            g.export_job = None;
            Ok(ExportStatusDto {
                active: false,
                progress: prog,
                out_path,
                finished_mode: None,
                error: Some(if canceled {
                    "エクスポートをキャンセルしました".into()
                } else {
                    err
                }),
            })
        }
    }
}

#[tauri::command]
pub fn clips_cancel_export(state: State<'_, ReplayHostHandle>) -> Result<(), String> {
    let g = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(job) = &g.export_job {
        job.progress.cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
