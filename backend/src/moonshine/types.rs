//! Port of `app/src-tauri/src/moonshine/types.rs` (verbatim).

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptWord {
    pub text: String,
    pub start: f32,
    pub end: f32,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptLine {
    pub text: String,
    pub start_time: f32,
    pub duration: f32,
    pub is_complete: bool,
    pub id: u64,
    pub words: Vec<TranscriptWord>,
    pub last_transcription_latency_ms: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptResult {
    pub lines: Vec<TranscriptLine>,
}
