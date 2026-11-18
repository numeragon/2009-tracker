//! App data folder (%APPDATA%\2009-tracker), rotating recorder.log, and local timestamps.
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use std::io::Write;
use std::path::PathBuf;

use windows::Win32::System::SystemInformation::GetLocalTime;

pub fn app_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("2009-tracker")
}

fn timestamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

pub fn file_stamp() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02}_{:02}-{:02}-{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

pub fn log(msg: &str) {
    let dir = app_dir();
    let _ = std::fs::create_dir_all(&dir);
    let p = dir.join("recorder.log");
    if let Ok(m) = std::fs::metadata(&p) {
        if m.len() > 512 * 1024 {
            let _ = std::fs::remove_file(&p);
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "[{}] {}", timestamp(), msg);
    }
    #[cfg(debug_assertions)]
    eprintln!("[recorder] {msg}");
}
