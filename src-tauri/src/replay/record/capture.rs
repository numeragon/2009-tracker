//! Zero-CPU DXGI Desktop Duplication monitor capture (100% GPU texture copy, Vanguard-compatible).
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use anyhow::{anyhow, Result};
use windows::core::Interface;
use windows::Win32::Foundation::{HMODULE, LUID, POINT};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_MODE_ROTATION, DXGI_MODE_ROTATION_ROTATE270, DXGI_MODE_ROTATION_ROTATE90,
};
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::Graphics::Gdi::{MonitorFromPoint, HMONITOR, MONITOR_DEFAULTTOPRIMARY};

use super::screen::{self, wide};
use crate::replay::log::log;

const QUICK_RETRY: i64 = 2_500_000;
const QUICK_FOR: i64 = 30_000_000;
const RETRY: i64 = 50_000_000;

pub enum Aim {
    Same,
    Switched,
    Restart,
}

pub struct Frame {
    pub tex: ID3D11Texture2D,
    pub rotation: DXGI_MODE_ROTATION,
    pub shape: (u32, u32),
}

struct Output {
    monitor: HMONITOR,
    output: IDXGIOutput1,
    name: String,
    width: u32,
    height: u32,
}

pub struct Capture {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    pub luid: LUID,
    pub width: u32,
    pub height: u32,
    pub latest: Option<Frame>,
    adapter: IDXGIAdapter1,
    gpu: String,
    out: Output,
    dup: Option<IDXGIOutputDuplication>,
    rotation: DXGI_MODE_ROTATION,
    stretch: Option<(u32, u32)>,
    retry_at: i64,
    failing_since: Option<i64>,
    failing: bool,
    skipped: Option<HMONITOR>,
}

impl Capture {
    pub fn new(monitor: Option<HMONITOR>) -> Result<Self> {
        let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
        let mut all = Vec::new();
        let mut i = 0;
        while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
            i += 1;
            all.extend(outputs(&adapter).into_iter().map(|o| (adapter.clone(), o)));
        }
        let primary = unsafe { MonitorFromPoint(POINT::default(), MONITOR_DEFAULTTOPRIMARY) };
        let want = monitor.filter(|m| all.iter().any(|(_, o)| o.monitor == *m)).unwrap_or(primary);
        let mut last = anyhow!("録画可能なモニターが見つかりません");
        for (adapter, out) in all.into_iter().filter(|(_, o)| o.monitor == want) {
            let name = out.name.clone();
            match Self::open_on(adapter, out) {
                Ok(c) => return Ok(c),
                Err(e) => {
                    log(&format!("モニター {name} のキャプチャ失敗: {e}"));
                    last = e;
                }
            }
        }
        Err(last)
    }

    fn open_on(adapter: IDXGIAdapter1, out: Output) -> Result<Self> {
        unsafe {
            let adesc = adapter.GetDesc1()?;
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
            let device = device.ok_or_else(|| anyhow!("D3D11デバイスを作成できませんでした"))?;
            let context = context.ok_or_else(|| anyhow!("D3D11コンテキストを作成できませんでした"))?;
            if let Ok(mt) = device.cast::<ID3D11Multithread>() {
                let _ = mt.SetMultithreadProtected(true);
            }
            let mut cap = Capture {
                device,
                context,
                luid: adesc.AdapterLuid,
                width: out.width,
                height: out.height,
                latest: None,
                adapter,
                gpu: wide(&adesc.Description),
                out,
                dup: None,
                rotation: DXGI_MODE_ROTATION::default(),
                stretch: None,
                retry_at: 0,
                failing_since: None,
                failing: false,
                skipped: None,
            };
            cap.open()?;
            Ok(cap)
        }
    }

    pub fn describe(&self) -> String {
        format!("{} ({})", self.out.name, self.gpu)
    }

    fn open(&mut self) -> Result<()> {
        self.dup = None;
        let dup = unsafe { self.out.output.DuplicateOutput(&self.device)? };
        self.rotation = unsafe { dup.GetDesc() }.Rotation;
        self.dup = Some(dup);
        self.stretch = screen::all()
            .into_iter()
            .find(|s| s.name == self.out.name && !s.keeps_shape)
            .map(|s| s.panel);
        Ok(())
    }

    pub fn aim(&mut self, monitor: HMONITOR, native: bool) -> Aim {
        let same_size = |o: &Output| (o.width, o.height) == (self.width, self.height);
        if monitor == self.out.monitor && (!native || same_size(&self.out)) {
            return Aim::Same;
        }
        let Some(out) = outputs(&self.adapter).into_iter().find(|o| o.monitor == monitor) else {
            return self.skip(monitor, native, "別GPUに接続されています");
        };
        if native && !same_size(&out) {
            log(&format!(
                "{} の解像度 ({}x{}) に合わせてキャプチャを再開します",
                out.name, out.width, out.height
            ));
            return Aim::Restart;
        }
        let prev = std::mem::replace(&mut self.out, out);
        match self.open() {
            Ok(()) => {
                log(&format!("キャプチャ中: {}", self.describe()));
                (self.failing, self.failing_since) = (false, None);
                self.skipped = None;
                Aim::Switched
            }
            Err(e) => {
                self.out = prev;
                self.dup = None;
                self.retry_at = 0;
                self.skip(monitor, native, &format!("このGPUでキャプチャできません ({e})"))
            }
        }
    }

    fn skip(&mut self, monitor: HMONITOR, native: bool, why: &str) -> Aim {
        if native {
            log(&format!("ゲームモニターが{why}: キャプチャを再起動します"));
            return Aim::Restart;
        }
        if self.skipped != Some(monitor) {
            self.skipped = Some(monitor);
            log(&format!("アクティブモニターが{why}: {} の録画を継続します", self.out.name));
        }
        Aim::Same
    }

    pub fn poll(&mut self, now: i64) -> Result<()> {
        if self.dup.is_none() {
            if now < self.retry_at {
                return Ok(());
            }
            if let Err(e) = self.open() {
                let since = *self.failing_since.get_or_insert(now);
                let quick = now - since < QUICK_FOR;
                self.retry_at = now + if quick { QUICK_RETRY } else { RETRY };
                if !quick && !self.failing {
                    self.failing = true;
                    log(&format!("{} をキャプチャできません ({e}): 5秒ごとに再試行します", self.out.name));
                }
                return Ok(());
            }
            self.failing_since = None;
            if std::mem::take(&mut self.failing) {
                log(&format!("{} のキャプチャが復帰しました", self.out.name));
            }
        }
        let dup = self.dup.clone().unwrap();
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut res: Option<IDXGIResource> = None;
        match unsafe { dup.AcquireNextFrame(0, &mut info, &mut res) } {
            Ok(()) => {
                let r = if info.LastPresentTime != 0 {
                    match res {
                        Some(res) => res
                            .cast::<ID3D11Texture2D>()
                            .map_err(Into::into)
                            .and_then(|t| self.copy(&t)),
                        None => Ok(()),
                    }
                } else {
                    Ok(())
                };
                unsafe {
                    let _ = dup.ReleaseFrame();
                }
                r?;
            }
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {}
            Err(e) => {
                if e.code() != DXGI_ERROR_ACCESS_LOST {
                    log(&format!("DXGI Duplication ({}): {e}", self.out.name));
                }
                self.dup = None;
                self.retry_at = now;
            }
        }
        Ok(())
    }

    fn copy(&mut self, frame: &ID3D11Texture2D) -> Result<()> {
        unsafe {
            let mut d = D3D11_TEXTURE2D_DESC::default();
            frame.GetDesc(&mut d);
            let turned = matches!(
                self.rotation,
                DXGI_MODE_ROTATION_ROTATE90 | DXGI_MODE_ROTATION_ROTATE270
            );
            let image = if turned { (d.Height, d.Width) } else { (d.Width, d.Height) };
            let shape = self.stretch.unwrap_or(image);
            let fits = self.latest.as_ref().is_some_and(|f| {
                let mut l = D3D11_TEXTURE2D_DESC::default();
                f.tex.GetDesc(&mut l);
                (f.rotation, f.shape) == (self.rotation, shape)
                    && (l.Width, l.Height, l.Format) == (d.Width, d.Height, d.Format)
            });
            if !fits {
                d.MipLevels = 1;
                d.ArraySize = 1;
                d.Usage = D3D11_USAGE_DEFAULT;
                d.BindFlags = (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32;
                d.CPUAccessFlags = 0;
                d.MiscFlags = 0;
                let mut t = None;
                self.device.CreateTexture2D(&d, None, Some(&mut t))?;
                let tex = t.ok_or_else(|| anyhow!("キャプチャ用テクスチャを作成できません"))?;
                self.latest = Some(Frame { tex, rotation: self.rotation, shape });
            }
            if let Some(f) = &self.latest {
                self.context.CopyResource(&f.tex, frame);
            }
        }
        Ok(())
    }
}

fn outputs(adapter: &IDXGIAdapter1) -> Vec<Output> {
    let screens = screen::all();
    let mut v = Vec::new();
    let mut j = 0;
    while let Ok(output) = unsafe { adapter.EnumOutputs(j) } {
        j += 1;
        let (Ok(d), Ok(output)) = (unsafe { output.GetDesc() }, output.cast::<IDXGIOutput1>()) else {
            continue;
        };
        if !d.AttachedToDesktop.as_bool() {
            continue;
        }
        let name = wide(&d.DeviceName);
        let r = d.DesktopCoordinates;
        let desktop = screen::desktop(&name)
            .unwrap_or(((r.right - r.left) as u32, (r.bottom - r.top) as u32));
        let panel = screens.iter().find(|s| s.name == name).map(|s| s.panel);
        let (width, height) = video_size(desktop, panel);
        v.push(Output { monitor: d.Monitor, output, name, width, height });
    }
    v
}

fn video_size(desktop: (u32, u32), panel: Option<(u32, u32)>) -> (u32, u32) {
    let (w, h) = match panel {
        Some((pw, ph)) => {
            let short = desktop.0.min(desktop.1).min(pw.min(ph)) as u64;
            let (pw, ph) = (pw as u64, ph as u64);
            if pw >= ph {
                (short * pw / ph, short)
            } else {
                (short, short * ph / pw)
            }
        }
        None => (desktop.0 as u64, desktop.1 as u64),
    };
    ((w as u32).max(2) & !1, (h as u32).max(2) & !1)
}
