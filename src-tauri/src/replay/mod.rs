//! Instant Replay Recorder & GPU Clip Editor engine ported from `santiremedi/clippy` (GPL-3.0-or-later).
#![allow(unsafe_op_in_unsafe_fn, dead_code)]

pub mod autostart;
pub mod clipcache;
pub mod config;
pub mod host;
pub mod keys;
pub mod library;
pub mod log;
pub mod media;
pub mod mf;
pub mod record;
pub mod sound;
