//! Clip library scanner, folder manager, Windows Recycle Bin deletion, and fast CPU keyframe thumbnail extractor.
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use std::collections::HashSet;
use std::os::windows::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;

use super::clipcache::{cache_file, file_hash, file_stamp};
use super::log::app_dir;
use super::media::{pack, reader, seek, Probe, ANY, EOS, VIDEO};

pub const VIDEO_EXTS: [&str; 6] = ["mp4", "mov", "m4v", "mkv", "wmv", "avi"];
pub const BAD_NAME: &str = "<>:\"/\\|?*";

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub path: String,
    pub name: String,
    pub count: usize,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub path: String,
    pub title: String,
    pub size: u64,
    pub modified_ms: u64,
    pub imported: bool,
}

fn library_file() -> PathBuf {
    app_dir().join("library.json")
}

pub fn load_imported() -> Vec<PathBuf> {
    std::fs::read_to_string(library_file())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_imported(v: &[PathBuf]) {
    let _ = std::fs::create_dir_all(app_dir());
    let _ = std::fs::write(library_file(), serde_json::to_string_pretty(v).unwrap_or_default());
}

pub fn is_video(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

fn videos_in(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let s = p.to_string_lossy();
            is_video(p) && !s.contains("2009-tmp") && !s.contains("clippy-tmp")
        })
}

pub fn scan(root: &Path, dir: Option<&Path>, imported: &[PathBuf]) -> (Vec<Folder>, Vec<Asset>) {
    let _ = std::fs::create_dir_all(root);
    let mut v: Vec<(SystemTime, Asset)> = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |p: PathBuf, is_imp: bool| {
        if !seen.insert(p.clone()) {
            return;
        }
        if let Ok(m) = std::fs::metadata(&p) {
            let modified = m.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            let modified_ms = modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            v.push((
                modified,
                Asset {
                    title: pretty_name(&p),
                    size: m.len(),
                    modified_ms,
                    path: p.to_string_lossy().into_owned(),
                    imported: is_imp,
                },
            ));
        }
    };

    for p in videos_in(dir.unwrap_or(root)) {
        add(p, false);
    }
    if dir.is_none() {
        for p in imported {
            if p.exists() {
                add(p.clone(), true);
            }
        }
    }

    let rd = std::fs::read_dir(root).into_iter().flatten().flatten();
    let mut folders: Vec<Folder> = rd
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| Folder {
            name: e.file_name().to_string_lossy().into_owned(),
            count: videos_in(&e.path()).count(),
            path: e.path().to_string_lossy().into_owned(),
        })
        .collect();
    folders.sort_by_key(|f| f.name.to_lowercase());
    v.sort_by_key(|(m, _)| std::cmp::Reverse(*m));
    let assets = v.into_iter().map(|(_, a)| a).collect();
    (folders, assets)
}

fn retry<T>(mut op: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let mut left = 20;
    loop {
        match op() {
            Err(_) if left > 0 => {
                left -= 1;
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            r => return r,
        }
    }
}

/// Moves a file or folder to the Windows Recycle Bin (`FOF_ALLOWUNDO`).
pub fn recycle(p: &Path) -> std::io::Result<()> {
    use windows::Win32::UI::Shell::*;
    let from: Vec<u16> = p.as_os_str().encode_wide().chain([0, 0]).collect();
    retry(|| {
        let mut op = SHFILEOPSTRUCTW {
            wFunc: FO_DELETE,
            pFrom: windows::core::PCWSTR(from.as_ptr()),
            fFlags: (FOF_ALLOWUNDO
                | FOF_NOCONFIRMATION
                | FOF_SILENT
                | FOF_NOERRORUI
                | FOF_WANTNUKEWARNING)
                .0 as u16,
            ..Default::default()
        };
        let r = unsafe { SHFileOperationW(&mut op) };
        if r == 0 && !op.fAnyOperationsAborted.as_bool() && !p.exists() {
            Ok(())
        } else {
            Err(std::io::Error::other(format!("ごみ箱への移動に失敗しました ({r})")))
        }
    })
}

pub fn move_into(p: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let mut to = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while to.exists() {
        to = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    let cache = cache_file(p);
    let old_thumb = thumb_file_for_existing(p);
    retry(|| std::fs::rename(p, &to))?;
    let _ = std::fs::rename(cache, cache_file(&to));
    if let (Some(ot), Some(nt)) = (old_thumb, thumb_file_for_existing(&to)) {
        let _ = std::fs::rename(ot, nt);
    }
    Ok(to)
}

pub fn rename_folder(from: &Path, to: &Path) -> std::io::Result<Vec<(PathBuf, PathBuf)>> {
    let videos: Vec<(PathBuf, PathBuf)> = videos_in(from)
        .map(|p| {
            let c = cache_file(&p);
            (p, c)
        })
        .collect();
    retry(|| std::fs::rename(from, to))?;
    Ok(videos
        .into_iter()
        .map(|(p, cache)| {
            let new = to.join(p.file_name().unwrap_or_default());
            let _ = std::fs::rename(cache, cache_file(&new));
            (p, new)
        })
        .collect())
}

pub fn folder_name_ok(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty() && !n.ends_with('.') && !n.chars().any(|c| BAD_NAME.contains(c) || c.is_control())
}

pub fn pretty_name(p: &Path) -> String {
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let stripped = stem
        .strip_prefix("Clip_")
        .or_else(|| stem.strip_prefix("Clippy_"))
        .or_else(|| stem.strip_prefix("2009_"));
    if let Some(rest) = stripped {
        let parts: Vec<&str> = rest.split(['_', '-']).collect();
        if parts.len() >= 6 && parts[..6].iter().all(|x| x.chars().all(|c| c.is_ascii_digit())) {
            let extra = if parts.len() > 6 {
                format!(" ({})", parts[6..].join(" "))
            } else {
                String::new()
            };
            return format!(
                "{}/{} · {}:{}:{}{}",
                parts[1], parts[2], parts[3], parts[4], parts[5], extra
            );
        }
    }
    stem
}

fn thumb_dir() -> PathBuf {
    app_dir().join("thumbs")
}

fn thumb_file_for_existing(p: &Path) -> Option<PathBuf> {
    let (size, mtime) = file_stamp(p)?;
    let h = file_hash(p);
    Some(thumb_dir().join(format!("{h:016x}_{size}_{mtime}.bmp")))
}

/// Extracts and caches a fast 256px-wide 24-bit BMP thumbnail on disk (~50 ms via CPU keyframe decode).
/// Must be called on a thread where Media Foundation (`Mf::init()`) is initialized.
pub fn ensure_thumbnail(p: &Path, pr: &Probe) -> Option<PathBuf> {
    let dst = thumb_file_for_existing(p)?;
    if dst.exists() {
        return Some(dst);
    }
    let _ = std::fs::create_dir_all(thumb_dir());
    let w = 256u32.min(pr.width.max(2)) & !1;
    let h = ((w as u64 * pr.height as u64 / pr.width.max(1) as u64) as u32).max(2) & !1;
    let t = (pr.duration / 2).min(10_000_000).max(0);
    let bgr = extract_keyframe_bgr24(p, w, h, t).ok()?;
    write_bmp24(&dst, w, h, &bgr).ok()?;
    Some(dst)
}

fn extract_keyframe_bgr24(path: &Path, w: u32, h: u32, t: i64) -> Result<Vec<u8>> {
    unsafe {
        let r = reader(path, true, None, true)?;
        r.SetStreamSelection(ANY, false)?;
        r.SetStreamSelection(VIDEO, true)?;
        let mt = MFCreateMediaType()?;
        mt.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        mt.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32)?;
        mt.SetUINT64(&MF_MT_FRAME_SIZE, pack(w, h))?;
        r.SetCurrentMediaType(VIDEO, None, &mt)
            .map_err(|_| anyhow!("サムネイルのデコードに失敗しました"))?;
        let cur = r.GetCurrentMediaType(VIDEO)?;
        let default_stride = cur
            .GetUINT32(&MF_MT_DEFAULT_STRIDE)
            .map(|s| s as i32)
            .unwrap_or((w * 4) as i32);
        let _ = seek(&r, t);

        let sample = loop {
            let (mut flags, mut ts, mut s) = (0u32, 0i64, None);
            r.ReadSample(VIDEO, 0, None, Some(&mut flags), Some(&mut ts), Some(&mut s))?;
            if let Some(s) = s {
                break s;
            }
            if flags & EOS != 0 {
                return Err(anyhow!("映像フレームがありません"));
            }
        };

        let (wu, hu) = (w as usize, h as usize);
        // Bottom-up 24-bit BGR rows padded to 4-byte boundary for standard BMP
        let row_bytes = (wu * 3 + 3) & !3;
        let mut out = vec![0u8; row_bytes * hu];

        let b = sample.ConvertToContiguousBuffer()?;
        let copy = |base: *const u8, pitch: isize, out: &mut [u8]| {
            for y in 0..hu {
                let src = std::slice::from_raw_parts(base.offset(y as isize * pitch), wu * 4);
                // BMP stores bottom row first (hu - 1 - y)
                let dst_row = &mut out[(hu - 1 - y) * row_bytes..];
                for x in 0..wu {
                    dst_row[x * 3] = src[x * 4]; // B
                    dst_row[x * 3 + 1] = src[x * 4 + 1]; // G
                    dst_row[x * 3 + 2] = src[x * 4 + 2]; // R
                }
            }
        };

        if let Ok(b2) = b.cast::<IMF2DBuffer>() {
            let mut p = std::ptr::null_mut();
            let mut pitch = 0i32;
            b2.Lock2D(&mut p, &mut pitch)?;
            copy(p, pitch as isize, &mut out);
            b2.Unlock2D()?;
        } else {
            let mut p = std::ptr::null_mut();
            b.Lock(&mut p, None, None)?;
            let pitch = default_stride as isize;
            let base = if pitch < 0 {
                p.offset(-pitch * (hu as isize - 1))
            } else {
                p
            };
            copy(base, pitch, &mut out);
            b.Unlock()?;
        }
        Ok(out)
    }
}

fn write_bmp24(dst: &Path, w: u32, h: u32, bgr_bottom_up: &[u8]) -> std::io::Result<()> {
    let data_size = bgr_bottom_up.len() as u32;
    let file_size = 54 + data_size;
    let mut v = Vec::with_capacity(file_size as usize);
    // BITMAPFILEHEADER (14 bytes)
    v.extend_from_slice(b"BM");
    v.extend_from_slice(&file_size.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&54u32.to_le_bytes());
    // BITMAPINFOHEADER (40 bytes)
    v.extend_from_slice(&40u32.to_le_bytes());
    v.extend_from_slice(&(w as i32).to_le_bytes());
    v.extend_from_slice(&(h as i32).to_le_bytes());
    v.extend_from_slice(&1u16.to_le_bytes()); // planes
    v.extend_from_slice(&24u16.to_le_bytes()); // bpp
    v.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
    v.extend_from_slice(&data_size.to_le_bytes());
    v.extend_from_slice(&2835i32.to_le_bytes());
    v.extend_from_slice(&2835i32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(&0u32.to_le_bytes());
    v.extend_from_slice(bgr_bottom_up);
    std::fs::write(dst, v)
}

pub fn open_folder(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let _ = std::process::Command::new("explorer").arg(dir).spawn();
}

pub fn reveal_file(file: &Path) {
    let _ = std::process::Command::new("explorer")
        .arg(format!("/select,{}", file.display()))
        .spawn();
}
