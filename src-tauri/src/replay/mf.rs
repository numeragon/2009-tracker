//! Shared Media Foundation helpers and unified 48 kHz 16-bit stereo PCM / 192 kbps AAC audio types.
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use anyhow::Result;
use windows::Win32::Media::Audio::{WAVEFORMATEX, WAVE_FORMAT_PCM};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

pub const RATE: i64 = 48_000;
pub const FRAME_BYTES: usize = 4;
const AAC_BYTES_PER_SECOND: u32 = 24_000;

pub const WAVE_FORMAT: WAVEFORMATEX = WAVEFORMATEX {
    wFormatTag: WAVE_FORMAT_PCM as u16,
    nChannels: 2,
    nSamplesPerSec: RATE as u32,
    nAvgBytesPerSec: RATE as u32 * FRAME_BYTES as u32,
    nBlockAlign: FRAME_BYTES as u16,
    wBitsPerSample: 16,
    cbSize: 0,
};

pub const fn frames_at(t: i64) -> i64 {
    t * RATE / 10_000_000
}

pub const fn time_of(frames: i64) -> i64 {
    frames * 10_000_000 / RATE
}

pub struct Mf {
    com: bool,
}

impl Mf {
    pub fn init() -> Mf {
        unsafe {
            let com = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let _ = MFStartup(MF_VERSION, MFSTARTUP_FULL);
            Mf { com }
        }
    }
}

impl Drop for Mf {
    fn drop(&mut self) {
        unsafe {
            let _ = MFShutdown();
            if self.com {
                CoUninitialize();
            }
        }
    }
}

pub unsafe fn pcm_type() -> Result<IMFMediaType> {
    let t = MFCreateMediaType()?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
    t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
    t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
    t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE as u32)?;
    t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
    t.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, FRAME_BYTES as u32)?;
    t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE as u32 * FRAME_BYTES as u32)?;
    t.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
    Ok(t)
}

pub unsafe fn aac_type() -> Result<IMFMediaType> {
    let t = MFCreateMediaType()?;
    t.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
    t.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
    t.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
    t.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE as u32)?;
    t.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
    t.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, AAC_BYTES_PER_SECOND)?;
    Ok(t)
}

pub unsafe fn sample(data: &[u8], time: i64, dur: i64) -> Result<IMFSample> {
    let buf = MFCreateMemoryBuffer(data.len() as u32)?;
    let mut p = std::ptr::null_mut();
    buf.Lock(&mut p, None, None)?;
    std::ptr::copy_nonoverlapping(data.as_ptr(), p, data.len());
    buf.Unlock()?;
    buf.SetCurrentLength(data.len() as u32)?;
    let s = MFCreateSample()?;
    s.AddBuffer(&buf)?;
    s.SetSampleTime(time)?;
    s.SetSampleDuration(dur)?;
    Ok(s)
}

pub unsafe fn pcm_sample(pcm: &[u8], time: i64) -> Result<IMFSample> {
    sample(pcm, time, time_of((pcm.len() / FRAME_BYTES) as i64))
}

pub unsafe fn sample_bytes(s: &IMFSample) -> Result<Vec<u8>> {
    let b = s.ConvertToContiguousBuffer()?;
    let mut p = std::ptr::null_mut();
    let mut len = 0u32;
    b.Lock(&mut p, None, Some(&mut len))?;
    let v = std::slice::from_raw_parts(p, len as usize).to_vec();
    b.Unlock()?;
    Ok(v)
}
