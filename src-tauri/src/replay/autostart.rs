//! Windows startup registration (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run\2009Tracker`).
//! Starts `#2009 tracker` silently in the system tray with `--background`.
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use std::path::Path;

use windows::core::{w, PCWSTR};
use windows::Win32::System::Registry::{
    RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
};

const RUN_KEY: PCWSTR = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const NAME: PCWSTR = w!("2009Tracker");

fn registered() -> Option<String> {
    unsafe {
        let mut len = 0u32;
        if RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, NAME, RRF_RT_REG_SZ, None, None, Some(&mut len)).is_err() {
            return None;
        }
        let mut buf = vec![0u16; (len as usize).div_ceil(2)];
        if RegGetValueW(
            HKEY_CURRENT_USER,
            RUN_KEY,
            NAME,
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut len),
        )
        .is_err()
        {
            return None;
        }
        let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..n]))
    }
}

pub fn enabled() -> bool {
    registered().is_some()
}

pub fn set(on: bool) {
    unsafe {
        if on {
            let Ok(exe) = std::env::current_exe() else { return };
            let cmd = format!("\"{}\" --background", exe.display());
            let v: Vec<u16> = cmd.encode_utf16().chain(std::iter::once(0)).collect();
            let _ = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                RUN_KEY,
                NAME,
                REG_SZ.0,
                Some(v.as_ptr() as *const _),
                (v.len() * 2) as u32,
            );
        } else {
            let _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, NAME);
        }
    }
}

pub fn repair() {
    let Some(cmd) = registered() else { return };
    let exe = cmd
        .trim_start()
        .strip_prefix('"')
        .and_then(|s| s.split('"').next())
        .unwrap_or(&cmd);
    if !Path::new(exe).exists() {
        set(true);
    }
}
