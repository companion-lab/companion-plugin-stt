//! Port of `app/src-tauri/src/moonshine/mod.rs` (module glue).
//!
//! The hardware-dependent `mic_capture_delivers_samples` probe test is not
//! ported: it needs a downloaded model, a real microphone and an interactive
//! permission grant, so it cannot run in `cargo test` here (in the host it is
//! `#[ignore]`d and run explicitly).

pub mod audio;
pub mod commands;
pub mod error;
pub mod stt;
pub mod types;

pub use stt::MoonshineTranscriber;
