//! Monitor panel aspect ratio & stretched-resolution detection (e.g. VALORANT 1280x960 4:3 stretched on 16:9).
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use std::mem::{size_of, size_of_val};
use windows::core::PCWSTR;
use windows::Win32::Devices::Display::*;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::Graphics::Gdi::{EnumDisplaySettingsW, DEVMODEW, ENUM_REGISTRY_SETTINGS};

pub struct Screen {
    pub name: String,
    pub panel: (u32, u32),
    pub keeps_shape: bool,
}

pub fn all() -> Vec<Screen> {
    unsafe {
        let (mut np, mut nm) = (0u32, 0u32);
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut np, &mut nm) != ERROR_SUCCESS {
            return Vec::new();
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); np as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); nm as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut np,
            paths.as_mut_ptr(),
            &mut nm,
            modes.as_mut_ptr(),
            None,
        ) != ERROR_SUCCESS
        {
            return Vec::new();
        }
        paths.truncate(np as usize);
        paths
            .iter()
            .filter_map(|p| {
                let (s, t) = (&p.sourceInfo, &p.targetInfo);
                let mut name = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
                name.header = header(
                    DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME,
                    size_of_val(&name),
                    s.adapterId,
                    s.id,
                );
                let mut pref = DISPLAYCONFIG_TARGET_PREFERRED_MODE::default();
                pref.header = header(
                    DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_PREFERRED_MODE,
                    size_of_val(&pref),
                    t.adapterId,
                    t.id,
                );
                if DisplayConfigGetDeviceInfo(&mut name.header) != 0
                    || DisplayConfigGetDeviceInfo(&mut pref.header) != 0
                {
                    return None;
                }
                if pref.width == 0 || pref.height == 0 {
                    return None;
                }
                let turned = matches!(
                    t.rotation,
                    DISPLAYCONFIG_ROTATION_ROTATE90 | DISPLAYCONFIG_ROTATION_ROTATE270
                );
                Some(Screen {
                    name: wide(&name.viewGdiDeviceName),
                    panel: if turned {
                        (pref.height, pref.width)
                    } else {
                        (pref.width, pref.height)
                    },
                    keeps_shape: matches!(
                        t.scaling,
                        DISPLAYCONFIG_SCALING_ASPECTRATIOCENTEREDMAX | DISPLAYCONFIG_SCALING_CENTERED
                    ),
                })
            })
            .collect()
    }
}

pub fn desktop(name: &str) -> Option<(u32, u32)> {
    let wname: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let mut dm = DEVMODEW { dmSize: size_of::<DEVMODEW>() as u16, ..Default::default() };
    unsafe { EnumDisplaySettingsW(PCWSTR(wname.as_ptr()), ENUM_REGISTRY_SETTINGS, &mut dm) }
        .as_bool()
        .then_some((dm.dmPelsWidth, dm.dmPelsHeight))
        .filter(|&(w, h)| w > 0 && h > 0)
}

fn header(
    kind: DISPLAYCONFIG_DEVICE_INFO_TYPE,
    size: usize,
    adapter: windows::Win32::Foundation::LUID,
    id: u32,
) -> DISPLAYCONFIG_DEVICE_INFO_HEADER {
    DISPLAYCONFIG_DEVICE_INFO_HEADER { r#type: kind, size: size as u32, adapterId: adapter, id }
}

pub fn wide(s: &[u16]) -> String {
    let n = s.iter().position(|&c| c == 0).unwrap_or(s.len());
    String::from_utf16_lossy(&s[..n])
}
