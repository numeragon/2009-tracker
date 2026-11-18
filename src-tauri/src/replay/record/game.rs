//! Fullscreen / borderless-fullscreen game process detector (Vanguard-safe: zero injection).
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use windows::core::PWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, HMONITOR, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    MONITOR_DEFAULTTONULL,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsZoomed,
};

const NOT_GAMES: &[&str] = &[
    "chrome",
    "msedge",
    "firefox",
    "opera",
    "brave",
    "vivaldi",
    "vlc",
    "mpc-hc",
    "mpc-hc64",
    "mpc-be",
    "mpc-be64",
    "mpv",
    "potplayer",
    "potplayer64",
    "potplayermini",
    "potplayermini64",
    "microsoft.media.player",
    "video.ui",
    "wmplayer",
    "explorer",
    "applicationframehost",
    "powerpnt",
    "lockapp",
    "searchhost",
    "startmenuexperiencehost",
    "shellexperiencehost",
    "snippingtool",
    "screenclippinghost",
    "clippy",
    "valorant-tracker",
    "2009 tracker",
    "2009-tracker",
    "msedgewebview2",
];

const FS_EVERY: i64 = 2_500_000; // 250 ms
const ALIVE_EVERY: i64 = 30_000_000; // 3 s
const STILL_ACTIVE: u32 = 259;

struct Proc {
    pid: u32,
    exe: String,
    handle: HANDLE,
    window: HWND,
}

impl Drop for Proc {
    fn drop(&mut self) {
        if !self.handle.is_invalid() {
            unsafe {
                let _ = CloseHandle(self.handle);
            }
        }
    }
}

#[derive(Default)]
pub struct Detector {
    game: Option<Proc>,
    in_front: bool,
    not_game: u32,
    next_fs: i64,
    next_alive: i64,
}

impl Detector {
    pub fn poll(&mut self, now: i64) -> bool {
        let mut changed = false;
        if now >= self.next_alive {
            self.next_alive = now + ALIVE_EVERY;
            if self.game.as_ref().is_some_and(|g| !alive(g)) {
                self.game = None;
                changed = true;
            }
        }
        if now >= self.next_fs {
            self.next_fs = now + FS_EVERY;
            self.in_front = false;
            if let Some((pid, window)) = fullscreen_window() {
                if let Some(g) = self.game.as_mut().filter(|g| g.pid == pid) {
                    g.window = window;
                    self.in_front = true;
                } else if pid != self.not_game {
                    match open(pid, window) {
                        Some(p) if is_game(&p.exe) => {
                            self.game = Some(p);
                            self.in_front = true;
                            changed = true;
                        }
                        _ => self.not_game = pid,
                    }
                }
            }
        }
        changed
    }

    pub fn pid(&self) -> Option<u32> {
        self.game.as_ref().map(|g| g.pid)
    }

    pub fn name(&self) -> Option<String> {
        self.game.as_ref().map(|g| g.exe.clone())
    }

    pub fn monitor(&self) -> Option<HMONITOR> {
        let w = self.game.as_ref()?.window;
        unsafe {
            if !IsWindow(w).as_bool() || IsIconic(w).as_bool() {
                return None;
            }
            let m = MonitorFromWindow(w, MONITOR_DEFAULTTONULL);
            (!m.is_invalid()).then_some(m)
        }
    }

    pub fn visible(&self) -> bool {
        let Some(m) = self.monitor() else { return false };
        self.in_front
            || foreground()
                .is_none_or(|h| unsafe { MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST) } != m)
    }
}

pub fn active_monitor() -> Option<HMONITOR> {
    let m = unsafe { MonitorFromWindow(foreground()?, MONITOR_DEFAULTTONULL) };
    (!m.is_invalid()).then_some(m)
}

fn foreground() -> Option<HWND> {
    unsafe {
        let h = GetForegroundWindow();
        if h.is_invalid() {
            return None;
        }
        let mut cls = [0u16; 64];
        let n = GetClassNameW(h, &mut cls).max(0) as usize;
        let cls = String::from_utf16_lossy(&cls[..n]);
        (!matches!(
            cls.as_str(),
            "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
        ))
        .then_some(h)
    }
}

fn is_game(exe: &str) -> bool {
    !exe.is_empty() && !NOT_GAMES.iter().any(|n| exe.eq_ignore_ascii_case(n))
}

fn open(pid: u32, window: HWND) -> Option<Proc> {
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).unwrap_or_default();
        let mut buf = [0u16; 512];
        let mut len = buf.len() as u32;
        let path = if !handle.is_invalid()
            && QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len)
                .is_ok()
        {
            String::from_utf16_lossy(&buf[..len as usize])
        } else {
            snapshot().into_iter().find(|(p, _)| *p == pid).map(|(_, n)| n)?
        };
        Some(Proc { pid, exe: exe_stem(&path), handle, window })
    }
}

fn exe_stem(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or("");
    match file.len().checked_sub(4) {
        Some(n) if file.is_char_boundary(n) && file[n..].eq_ignore_ascii_case(".exe") => {
            file[..n].to_string()
        }
        _ => file.to_string(),
    }
}

fn alive(p: &Proc) -> bool {
    if p.handle.is_invalid() {
        return snapshot().iter().any(|(pid, _)| *pid == p.pid);
    }
    let mut code = 0u32;
    unsafe { GetExitCodeProcess(p.handle, &mut code).is_ok() && code == STILL_ACTIVE }
}

fn snapshot() -> Vec<(u32, String)> {
    let mut v = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return v };
        let mut e = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let n = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                v.push((e.th32ProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    v
}

fn fullscreen_window() -> Option<(u32, HWND)> {
    unsafe {
        let h = foreground()?;
        if IsZoomed(h).as_bool() {
            return None;
        }
        let mut r = RECT::default();
        GetWindowRect(h, &mut r).ok()?;
        let mut mi = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(MonitorFromWindow(h, MONITOR_DEFAULTTONEAREST), &mut mi).as_bool() {
            return None;
        }
        let m = mi.rcMonitor;
        if !(r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom) {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, Some(&mut pid));
        (pid != 0).then_some((pid, h))
    }
}
