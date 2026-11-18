//! Instant Replay GPU screen + 3-channel WASAPI audio capture, hardware H.264 encoding, RAM circular buffer, and lossless MP4 muxing.
//! Ported from `santiremedi/clippy` (GPL-3.0-or-later).

pub mod audio;
mod capture;
pub mod clock;
mod convert;
mod encoder;
pub mod game;
mod mux;
pub mod recorder;
mod screen;
