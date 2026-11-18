//! Per-file cache of audio waveforms (5 ms peak/RMS buckets) and video keyframes.
//! Written automatically on clip save so the editor opens clips instantaneously.
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};

use super::log::app_dir;

pub const WAVE_BUCKET: i64 = 50_000;
const CACHE_VERSION: u32 = 2;
const UNUSED_FOR: Duration = Duration::from_secs(60 * 24 * 60 * 60);

#[derive(Serialize, Deserialize)]
struct Cached {
    #[serde(default)]
    v: u32,
    size: u64,
    modified: u64,
    peak: String,
    rms: String,
    keyframes: Vec<i64>,
}

#[derive(Clone, Default)]
pub struct Wave {
    peak: Vec<u8>,
    rms: Vec<u8>,
}

impl Wave {
    pub fn range(&self, t0: i64, t1: i64) -> (f32, f32) {
        let n = self.peak.len().min(self.rms.len());
        if n == 0 {
            return (0.0, 0.0);
        }
        let i0 = ((t0.max(0) / WAVE_BUCKET) as usize).min(n - 1);
        let i1 = (((t1.max(0) + WAVE_BUCKET - 1) / WAVE_BUCKET) as usize)
            .max(i0 + 1)
            .min(n);
        let (p, r) = (&self.peak[i0..i1], &self.rms[i0..i1]);
        let peak = p.iter().copied().max().unwrap_or(0);
        let sq: u64 = r.iter().map(|&v| (v as u32 * v as u32) as u64).sum();
        let rms = (sq as f32 / r.len().max(1) as f32).sqrt();
        (peak as f32 / 255.0, rms / 255.0)
    }

    /// Downsamples the full waveform into `buckets` normalized `(peaks, rms)` arrays for timeline rendering.
    pub fn summary(&self, duration_100ns: i64, buckets: usize) -> (Vec<f32>, Vec<f32>) {
        let n = self.peak.len().min(self.rms.len());
        let buckets = buckets.clamp(16, 2048);
        if n == 0 || duration_100ns <= 0 {
            return (vec![0.0; buckets], vec![0.0; buckets]);
        }
        let mut peaks = Vec::with_capacity(buckets);
        let mut rms_out = Vec::with_capacity(buckets);
        for i in 0..buckets {
            let t0 = (duration_100ns as i128 * i as i128 / buckets as i128) as i64;
            let t1 = (duration_100ns as i128 * (i + 1) as i128 / buckets as i128) as i64;
            let (pk, rm) = self.range(t0, t1.max(t0 + WAVE_BUCKET));
            peaks.push((pk * 1000.0).round() / 1000.0);
            rms_out.push((rm * 1000.0).round() / 1000.0);
        }
        (peaks, rms_out)
    }
}

pub struct WaveBuilder {
    peak: Vec<u8>,
    rms: Vec<u8>,
    cur: u16,
    sum: f64,
    n: usize,
}

const PER: usize = super::mf::frames_at(WAVE_BUCKET) as usize;

impl WaveBuilder {
    pub fn new() -> Self {
        Self { peak: Vec::new(), rms: Vec::new(), cur: 0, sum: 0.0, n: 0 }
    }

    pub fn push(&mut self, l: i16, r: i16) {
        self.cur = self.cur.max(l.unsigned_abs()).max(r.unsigned_abs());
        let (fl, fr) = (l as f64, r as f64);
        self.sum += (fl * fl + fr * fr) / 2.0;
        self.n += 1;
        if self.n == PER {
            self.flush();
        }
    }

    pub fn pad_to_time(&mut self, t: i64) {
        let len = (t.max(0) / WAVE_BUCKET) as usize;
        while self.peak.len() < len {
            self.peak.push(0);
            self.rms.push(0);
        }
    }

    fn flush(&mut self) {
        let to_u8 = |v: f64| (v / 32768.0 * 255.0).round().clamp(0.0, 255.0) as u8;
        self.peak.push(to_u8(self.cur as f64));
        self.rms.push(to_u8((self.sum / self.n.max(1) as f64).sqrt()));
        self.cur = 0;
        self.sum = 0.0;
        self.n = 0;
    }

    pub fn finish(mut self) -> Wave {
        if self.n > 0 {
            self.flush();
        }
        Wave { peak: self.peak, rms: self.rms }
    }
}

pub fn wave_from_pcm(pcm: &[i16]) -> Wave {
    let mut b = WaveBuilder::new();
    for c in pcm.as_chunks::<2>().0 {
        b.push(c[0], c[1]);
    }
    b.finish()
}

fn to_hex(v: &[u8]) -> String {
    v.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    (0..s.len())
        .step_by(2)
        .map(|i| s.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()))
        .collect()
}

pub fn cache_dir() -> PathBuf {
    app_dir().join("cache")
}

pub fn file_hash(p: &Path) -> u64 {
    let canon = std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    canon
        .to_string_lossy()
        .to_lowercase()
        .bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x0100_0000_01b3))
}

pub fn cache_file(p: &Path) -> PathBuf {
    let h = file_hash(p);
    cache_dir().join(format!("{h:016x}.json"))
}

pub fn prune() {
    let Some(limit) = SystemTime::now().checked_sub(UNUSED_FOR) else { return };
    for dir in [cache_dir(), app_dir().join("thumbs")] {
        let Ok(rd) = std::fs::read_dir(dir) else { continue };
        for e in rd.flatten() {
            if e.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < limit) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

pub fn file_stamp(p: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(p).ok()?;
    let t = m.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs();
    Some((m.len(), t))
}

pub fn load(p: &Path) -> Option<(Wave, Vec<i64>)> {
    let (size, modified) = file_stamp(p)?;
    let f = cache_file(p);
    let c: Cached = serde_json::from_str(&std::fs::read_to_string(&f).ok()?).ok()?;
    if c.v != CACHE_VERSION || c.size != size || c.modified != modified {
        return None;
    }
    let (peak, rms) = (from_hex(&c.peak)?, from_hex(&c.rms)?);
    if peak.len() != rms.len() {
        return None;
    }
    if let Ok(file) = std::fs::File::options().write(true).open(&f) {
        let _ = file.set_modified(SystemTime::now());
    }
    Some((Wave { peak, rms }, c.keyframes))
}

pub fn save(p: &Path, wave: &Wave, keyframes: &[i64]) {
    let Some((size, modified)) = file_stamp(p) else { return };
    let c = Cached {
        v: CACHE_VERSION,
        size,
        modified,
        peak: to_hex(&wave.peak),
        rms: to_hex(&wave.rms),
        keyframes: keyframes.to_vec(),
    };
    let f = cache_file(p);
    if let Some(d) = f.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let _ = std::fs::write(f, serde_json::to_string(&c).unwrap_or_default());
}
