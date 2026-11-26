//! Persistent recorder configuration (%APPDATA%\2009-tracker\recorder_config.json).
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::log::app_dir;

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{FOLDERID_Videos, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Debug, Default)]
#[serde(from = "String", into = "&'static str")]
pub enum CaptureMode {
    #[default]
    Screen,
    GamesOnly,
}

impl From<String> for CaptureMode {
    fn from(s: String) -> Self {
        if s == "games" || s == "juegos" {
            CaptureMode::GamesOnly
        } else {
            CaptureMode::Screen
        }
    }
}

impl From<CaptureMode> for &'static str {
    fn from(m: CaptureMode) -> Self {
        match m {
            CaptureMode::Screen => "screen",
            CaptureMode::GamesOnly => "games",
        }
    }
}

pub const MAX_SECONDS: u32 = 300;
pub const MIN_MBPS: u32 = 5;
pub const MAX_MBPS: u32 = 150;
pub const RESOLUTIONS: [u32; 4] = [0, 1440, 1080, 720];

fn default_true() -> bool {
    true
}

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub enabled: bool,
    pub output_dir: PathBuf,
    pub seconds: u32,
    pub hotkey_vk: u32,
    /// MOD_ALT = 1, MOD_CONTROL = 2, MOD_SHIFT = 4
    pub hotkey_mods: u32,
    pub fps: u32,
    pub bitrate_mbps: u32,
    /// Short side in px (720, 1080, 1440); 0 = monitor native. Never upscales.
    pub resolution: u32,
    /// Process-isolated fullscreen game audio.
    pub game_audio: bool,
    pub game_volume: u32,
    /// Desktop audio excluding game process (Discord, music, etc.).
    pub desktop_audio: bool,
    pub desktop_volume: u32,
    /// Microphone capture (`mic_device` empty = Windows default).
    pub mic_audio: bool,
    pub mic_volume: u32,
    pub mic_device: String,
    pub capture_mode: CaptureMode,
    pub sound_on_save: bool,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    /// Global hotkey to pause/resume recording (vk 0 = unbound).
    pub toggle_vk: u32,
    pub toggle_mods: u32,
    /// Global hotkey to open Clip Studio editor (vk 0 = unbound).
    pub editor_vk: u32,
    pub editor_mods: u32,
    /// Global hotkey to open Clips output folder (vk 0 = unbound).
    pub folder_vk: u32,
    pub folder_mods: u32,
    /// Global hotkey to toggle the in-game overlay (vk 0 = unbound).
    pub overlay_vk: u32,
    pub overlay_mods: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GlobalAction {
    SaveClip,
    ToggleRecording,
    OpenEditor,
    OpenFolder,
    OverlayToggle,
}

impl GlobalAction {
    pub const ALL: [GlobalAction; 5] = [
        GlobalAction::SaveClip,
        GlobalAction::ToggleRecording,
        GlobalAction::OpenEditor,
        GlobalAction::OpenFolder,
        GlobalAction::OverlayToggle,
    ];

    pub fn id(self) -> i32 {
        self as i32 + 1
    }

    pub fn from_id(id: i32) -> Option<Self> {
        Self::ALL.into_iter().find(|a| a.id() == id)
    }

    pub fn label(self) -> &'static str {
        match self {
            GlobalAction::SaveClip => "クリップを保存",
            GlobalAction::ToggleRecording => "録画の一時停止 / 再開",
            GlobalAction::OpenEditor => "クリップ編集を開く",
            GlobalAction::OpenFolder => "保存先フォルダを開く",
            GlobalAction::OverlayToggle => "オーバーレイの表示 / 非表示",
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            output_dir: default_output_dir(),
            seconds: 30,
            hotkey_vk: 0x78, // F9
            hotkey_mods: 0,
            fps: 60,
            bitrate_mbps: 30,
            resolution: 0,
            game_audio: true,
            game_volume: 100,
            desktop_audio: true,
            desktop_volume: 100,
            mic_audio: false,
            mic_volume: 100,
            mic_device: String::new(),
            capture_mode: CaptureMode::Screen,
            sound_on_save: true,
            minimize_to_tray: true,
            toggle_vk: 0,
            toggle_mods: 0,
            editor_vk: 0,
            editor_mods: 0,
            folder_vk: 0,
            folder_mods: 0,
            overlay_vk: 0x77, // F8
            overlay_mods: 0,
        }
    }
}

impl Config {
    pub fn video_params(&self) -> (bool, u32, u32, u32) {
        (self.enabled, self.fps, self.bitrate_mbps, self.resolution)
    }

    pub fn video_size(&self, full: (u32, u32)) -> (u32, u32) {
        let short = full.0.min(full.1);
        if self.resolution == 0 || self.resolution >= short {
            return full;
        }
        let k = |x: u32| ((x as u64 * self.resolution as u64 / short as u64) as u32).max(2) & !1;
        (k(full.0), k(full.1))
    }

    pub fn audio_on(&self) -> bool {
        self.game_audio || self.desktop_audio || self.mic_audio
    }

    pub fn sanitize(&mut self) {
        self.seconds = self.seconds.clamp(5, MAX_SECONDS);
        if !matches!(self.fps, 30 | 60 | 120) {
            self.fps = 60;
        }
        self.bitrate_mbps = self.bitrate_mbps.clamp(MIN_MBPS, MAX_MBPS);
        if !RESOLUTIONS.contains(&self.resolution) {
            self.resolution = 0;
        }
        self.game_volume = self.game_volume.min(100);
        self.desktop_volume = self.desktop_volume.min(100);
        self.mic_volume = self.mic_volume.min(200);
        if self.output_dir.as_os_str().is_empty() {
            self.output_dir = default_output_dir();
        }
        if self.hotkey_vk == 0 || self.hotkey_vk > 0xFE {
            self.hotkey_vk = 0x78;
        }
        self.hotkey_mods &= 0x7;
        self.toggle_mods &= 0x7;
        for a in GlobalAction::ALL {
            if a == GlobalAction::SaveClip {
                continue;
            }
            let (vk, mods) = self.hotkey_mut(a);
            *mods &= 0x7;
            if *vk > 0xFE {
                *vk = 0;
            }
        }
    }

    pub fn hotkey(&self, a: GlobalAction) -> (u32, u32) {
        match a {
            GlobalAction::SaveClip => (self.hotkey_vk, self.hotkey_mods),
            GlobalAction::ToggleRecording => (self.toggle_vk, self.toggle_mods),
            GlobalAction::OpenEditor => (self.editor_vk, self.editor_mods),
            GlobalAction::OpenFolder => (self.folder_vk, self.folder_mods),
            GlobalAction::OverlayToggle => (self.overlay_vk, self.overlay_mods),
        }
    }

    pub fn typical_ram_mb(&self) -> u32 {
        let channels = self.game_audio as u32 + self.desktop_audio as u32 + self.mic_audio as u32;
        let audio = channels * self.seconds * 192 / 1000;
        let video = self.bitrate_mbps * self.seconds / 80;
        (40 + audio + video).div_ceil(10) * 10
    }

    pub fn hotkey_mut(&mut self, a: GlobalAction) -> (&mut u32, &mut u32) {
        match a {
            GlobalAction::SaveClip => (&mut self.hotkey_vk, &mut self.hotkey_mods),
            GlobalAction::ToggleRecording => (&mut self.toggle_vk, &mut self.toggle_mods),
            GlobalAction::OpenEditor => (&mut self.editor_vk, &mut self.editor_mods),
            GlobalAction::OpenFolder => (&mut self.folder_vk, &mut self.folder_mods),
            GlobalAction::OverlayToggle => (&mut self.overlay_vk, &mut self.overlay_mods),
        }
    }
}

pub fn config_path() -> PathBuf {
    app_dir().join("recorder_config.json")
}

pub fn exists() -> bool {
    config_path().exists()
}

pub fn load() -> Config {
    let mut cfg: Config = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str(s.trim_start_matches('\u{feff}')).ok())
        .unwrap_or_default();
    cfg.sanitize();
    cfg
}

pub fn save(cfg: &Config) -> std::io::Result<()> {
    std::fs::create_dir_all(app_dir())?;
    let tmp = app_dir().join("recorder_config.json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg).unwrap_or_default())?;
    std::fs::rename(&tmp, config_path())
}

fn default_output_dir() -> PathBuf {
    unsafe {
        if let Ok(p) = SHGetKnownFolderPath(&FOLDERID_Videos, KF_FLAG_DEFAULT, HANDLE::default()) {
            let s = p.to_string().ok();
            CoTaskMemFree(Some(p.0 as *const _));
            if let Some(s) = s {
                return PathBuf::from(s).join("2009 tracker");
            }
        }
    }
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("Videos")
        .join("2009 tracker")
}
