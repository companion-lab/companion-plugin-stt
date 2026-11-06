//! Port of `app/src-tauri/src/moonshine/commands.rs`.
//!
//! The `#[tauri::command]` wrappers become plain functions over
//! `&MoonshineSttState`; the plugin router in lib.rs maps them 1:1 onto the
//! `stt.*` wire methods with identical args/results (snake_case payload
//! fields preserved):
//!
//! `moonshine_stt_load` → `stt.load`, `moonshine_stt_transcribe` →
//! `stt.transcribe`, `moonshine_stt_create_stream` → `stt.create_stream`,
//! `moonshine_stt_stream_start` → `stt.stream_start`,
//! `moonshine_stt_stream_add_audio` → `stt.stream_add_audio`,
//! `moonshine_stt_stream_transcribe` → `stt.stream_transcribe`,
//! `moonshine_stt_stream_stop` → `stt.stream_stop`,
//! `moonshine_stt_start_raw` → `stt.start_raw`,
//! `moonshine_stt_take_raw_audio` → `stt.take_raw_audio`,
//! `moonshine_stt_stop_raw` → `stt.stop_raw`,
//! `moonshine_stt_start_listening` → `stt.start_listening`,
//! `moonshine_stt_stop_listening` → `stt.stop_listening`,
//! `moonshine_stt_transcribe_streaming` → `stt.transcribe_streaming`,
//! `moonshine_stt_list_devices` → `stt.list_devices`,
//! `moonshine_stt_unload` → `stt.unload`, `moonshine_stt_poll_text` →
//! `stt.poll_text`, `moonshine_stt_set_suppress` → `stt.set_suppress`,
//! `moonshine_stt_activity` → `stt.activity`.

use std::collections::HashMap;

use cpal::traits::{DeviceTrait, HostTrait};
use super::audio::NativeMicCapture;
use super::stt::{MoonshineTranscriber, StreamHandle};
use super::types::TranscriptResult;

pub struct MoonshineSttState {
    pub transcriber: std::sync::Mutex<Option<MoonshineTranscriber>>,
    pub streams: std::sync::Mutex<HashMap<i32, StreamHandle>>,
    pub mic_capture: std::sync::Mutex<NativeMicCapture>,
    pub active_stream_id: std::sync::Mutex<Option<i32>>,
    /// True while the mic is capturing for cloud STT (no Moonshine stream).
    pub raw_listening: std::sync::Mutex<bool>,
    pub model_dir: std::sync::Mutex<Option<String>>,
    pub model_arch: std::sync::Mutex<u32>,
    next_stream_id: std::sync::Mutex<i32>,
}

impl MoonshineSttState {
    pub fn new() -> Self {
        MoonshineSttState {
            transcriber: std::sync::Mutex::new(None),
            streams: std::sync::Mutex::new(HashMap::new()),
            mic_capture: std::sync::Mutex::new(NativeMicCapture::new()),
            active_stream_id: std::sync::Mutex::new(None),
            raw_listening: std::sync::Mutex::new(false),
            model_dir: std::sync::Mutex::new(None),
            model_arch: std::sync::Mutex::new(moonshine_sys::MOONSHINE_MODEL_ARCH_MEDIUM_STREAMING),
            next_stream_id: std::sync::Mutex::new(1),
        }
    }

    pub fn set_model(&self, model_dir: String, model_arch: u32) {
        *self.model_dir.lock().unwrap() = Some(model_dir);
        *self.model_arch.lock().unwrap() = model_arch;
    }
}

/// Load the transcriber on demand. Callers hold `transcriber` for the whole
/// load, serializing concurrent first-callers.
fn ensure_transcriber(state: &MoonshineSttState) -> Result<(), String> {
    let mut guard = state.transcriber.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let model_dir = state
        .model_dir
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .ok_or("STT model dir not configured")?;
    let model_arch = *state.model_arch.lock().map_err(|e| e.to_string())?;
    let t = super::MoonshineTranscriber::load(&model_dir, model_arch).map_err(|e| e.to_string())?;
    *guard = Some(t);
    Ok(())
}

pub fn unload_transcriber(state: &MoonshineSttState) {
    if let Ok(mut guard) = state.transcriber.lock() {
        *guard = None;
    }
}

pub fn is_transcriber_loaded(state: &MoonshineSttState) -> bool {
    state
        .transcriber
        .lock()
        .map(|t| t.is_some())
        .unwrap_or(false)
}

// Former `moonshine_stt_load`.
pub fn stt_load(
    state: &MoonshineSttState,
    model_path: String,
    model_arch: u32,
) -> Result<(), String> {
    let transcriber = super::MoonshineTranscriber::load(&model_path, model_arch)
        .map_err(|e| e.to_string())?;
    let mut guard = state.transcriber.lock().map_err(|e| e.to_string())?;
    *guard = Some(transcriber);
    Ok(())
}

// Former `moonshine_stt_transcribe`.
pub fn stt_transcribe(
    state: &MoonshineSttState,
    audio: Vec<f32>,
    sample_rate: i32,
) -> Result<TranscriptResult, String> {
    ensure_transcriber(state)?;
    let mut guard = state.transcriber.lock().map_err(|e| e.to_string())?;
    let t = guard.as_mut().ok_or("Transcriber not loaded")?;
    t.transcribe_without_streaming(&audio, sample_rate)
        .map_err(|e| e.to_string())
}

// Former `moonshine_stt_create_stream`.
pub fn stt_create_stream(state: &MoonshineSttState) -> Result<i32, String> {
    ensure_transcriber(state)?;
    let guard = state.transcriber.lock().map_err(|e| e.to_string())?;
    let t = guard.as_ref().ok_or("Transcriber not loaded")?;
    let stream_handle = t.create_stream(0).map_err(|e| e.to_string())?;
    let mut id_guard = state.next_stream_id.lock().map_err(|e| e.to_string())?;
    let id = *id_guard;
    *id_guard += 1;
    drop(guard);
    drop(id_guard);
    let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
    streams.insert(id, stream_handle);
    Ok(id)
}

// Former `moonshine_stt_stream_start`.
pub fn stt_stream_start(state: &MoonshineSttState, stream_id: i32) -> Result<(), String> {
    let streams = state.streams.lock().map_err(|e| e.to_string())?;
    let s = streams.get(&stream_id).ok_or("Stream not found")?;
    s.start().map_err(|e| e.to_string())
}

// Former `moonshine_stt_stream_add_audio`.
pub fn stt_stream_add_audio(
    state: &MoonshineSttState,
    stream_id: i32,
    audio: Vec<f32>,
    sample_rate: i32,
) -> Result<(), String> {
    let streams = state.streams.lock().map_err(|e| e.to_string())?;
    let s = streams.get(&stream_id).ok_or("Stream not found")?;
    s.add_audio(&audio, sample_rate)
        .map_err(|e| e.to_string())
}

// Former `moonshine_stt_stream_transcribe`.
pub fn stt_stream_transcribe(
    state: &MoonshineSttState,
    stream_id: i32,
    flags: u32,
) -> Result<TranscriptResult, String> {
    let streams = state.streams.lock().map_err(|e| e.to_string())?;
    let s = streams.get(&stream_id).ok_or("Stream not found")?;
    s.transcribe(flags).map_err(|e| e.to_string())
}

// Former `moonshine_stt_stream_stop`.
pub fn stt_stream_stop(state: &MoonshineSttState, stream_id: i32) -> Result<TranscriptResult, String> {
    let result = {
        let streams = state.streams.lock().map_err(|e| e.to_string())?;
        let s = streams.get(&stream_id).ok_or("Stream not found")?;
        s.stop().map_err(|e| e.to_string())?
    };
    let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
    streams.remove(&stream_id);
    Ok(result)
}

// --- Raw mic capture for cloud STT ---

#[derive(serde::Serialize)]
pub struct RawAudioChunk {
    pub samples: Vec<f32>,
    pub sample_rate: u32,
}

/// Start mic capture without loading Moonshine: audio buffers in Rust, the
/// frontend drains it and forwards to the cloud transcription provider.
/// Former `moonshine_stt_start_raw`.
pub fn stt_start_raw(state: &MoonshineSttState) -> Result<(), String> {
    // macOS: without the TCC grant the capture stream opens but delivers
    // pure silence, so gate before starting anything.
    #[cfg(target_os = "macos")]
    crate::mic_permission::ensure()?;

    let mut mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
    mic.start_raw().map_err(|e| e.to_string())?;
    drop(mic);
    *state.raw_listening.lock().map_err(|e| e.to_string())? = true;
    Ok(())
}

/// Drain buffered mic audio (device-rate mono f32).
/// Former `moonshine_stt_take_raw_audio`.
pub fn stt_take_raw_audio(state: &MoonshineSttState) -> Result<RawAudioChunk, String> {
    let mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
    let (samples, sample_rate) = mic.take_pending();
    Ok(RawAudioChunk { samples, sample_rate })
}

/// Stop raw capture and return the un-drained tail.
/// Former `moonshine_stt_stop_raw`.
pub fn stt_stop_raw(state: &MoonshineSttState) -> Result<RawAudioChunk, String> {
    let tail = {
        let mut mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
        mic.stop();
        let (samples, sample_rate) = mic.take_pending();
        RawAudioChunk { samples, sample_rate }
    };
    *state.raw_listening.lock().map_err(|e| e.to_string())? = false;
    Ok(tail)
}

// --- Native mic commands ---

/// Former `moonshine_stt_start_listening`.
pub fn stt_start_listening(state: &MoonshineSttState) -> Result<i32, String> {
    // macOS: without the TCC grant the capture stream opens but delivers
    // pure silence, so gate before starting anything.
    #[cfg(target_os = "macos")]
    crate::mic_permission::ensure()?;

    ensure_transcriber(state)?;
    // Create and start a stream
    let stream_id = {
        let guard = state.transcriber.lock().map_err(|e| e.to_string())?;
        let t = guard.as_ref().ok_or("Transcriber not loaded")?;
        let stream_handle = t.create_stream(0).map_err(|e| e.to_string())?;
        let mut id_guard = state.next_stream_id.lock().map_err(|e| e.to_string())?;
        let id = *id_guard;
        *id_guard += 1;
        drop(guard);
        drop(id_guard);

        let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
        streams.insert(id, stream_handle);
        id
    };

    // Start the stream on Moonshine side
    {
        let streams = state.streams.lock().map_err(|e| e.to_string())?;
        let s = streams.get(&stream_id).ok_or("Stream not found")?;
        s.start().map_err(|e| e.to_string())?;
    }

    // Get raw handles for the audio callback
    let (th, sh) = {
        let streams = state.streams.lock().map_err(|e| e.to_string())?;
        let s = streams.get(&stream_id).ok_or("Stream not found")?;
        (s.transcriber_handle(), s.stream_handle())
    };

    // Start native mic capture with raw handles
    {
        let mut mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
        mic.start(th, sh).map_err(|e| e.to_string())?;
    }

    // Track active stream
    {
        let mut active = state.active_stream_id.lock().map_err(|e| e.to_string())?;
        *active = Some(stream_id);
    }
    // Local mode replaces any raw (cloud) capture session.
    *state.raw_listening.lock().map_err(|e| e.to_string())? = false;

    Ok(stream_id)
}

/// Former `moonshine_stt_stop_listening`.
pub fn stt_stop_listening(state: &MoonshineSttState) -> Result<TranscriptResult, String> {
    // Stop mic capture
    {
        let mut mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
        mic.stop();
    }

    // Get active stream id
    let stream_id = {
        let mut active = state.active_stream_id.lock().map_err(|e| e.to_string())?;
        active.take().ok_or("Not listening")?
    };

    // Stop stream and get final result
    let result = {
        let streams = state.streams.lock().map_err(|e| e.to_string())?;
        let s = streams.get(&stream_id).ok_or("Stream not found")?;
        s.stop().map_err(|e| e.to_string())?
    };
    let mut streams = state.streams.lock().map_err(|e| e.to_string())?;
    streams.remove(&stream_id);
    Ok(result)
}

/// Former `moonshine_stt_transcribe_streaming`.
pub fn stt_transcribe_streaming(state: &MoonshineSttState) -> Result<TranscriptResult, String> {
    let active = state.active_stream_id.lock().map_err(|e| e.to_string())?;
    let stream_id = active.ok_or("Not listening")?;
    let streams = state.streams.lock().map_err(|e| e.to_string())?;
    let s = streams.get(&stream_id).ok_or("Stream not found")?;
    s.transcribe(0).map_err(|e| e.to_string())
}

/// Former `moonshine_stt_list_devices`.
pub fn stt_list_devices() -> Result<Vec<String>, String> {
    let host = cpal::default_host();
    let devices: Vec<String> = host
        .input_devices()
        .map_err(|e| e.to_string())?
        .filter_map(|d| d.name().ok())
        .collect();
    Ok(devices)
}

/// Drop the transcriber and free its memory. Used by the idle-unload path
/// and the manual "release memory" action; the next call re-loads lazily.
/// Former `moonshine_stt_unload`.
pub fn stt_unload(state: &MoonshineSttState) -> Result<(), String> {
    // Refuse while a stream is live; callers stop first.
    let active = state.active_stream_id.lock().map_err(|e| e.to_string())?;
    if active.is_some() {
        return Err("STT is currently listening".into());
    }
    drop(active);
    if *state.raw_listening.lock().map_err(|e| e.to_string())? {
        return Err("STT is currently listening".into());
    }
    unload_transcriber(state);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct LeanPollResult {
    pub live: String,
    pub completed: String,
}

/// Lean streaming poll: the frontend only reads `text` and `is_complete`,
/// so join them in Rust instead of serializing every word and timing over IPC.
/// Former `moonshine_stt_poll_text`.
pub fn stt_poll_text(state: &MoonshineSttState) -> Result<LeanPollResult, String> {
    let active = state.active_stream_id.lock().map_err(|e| e.to_string())?;
    let stream_id = active.ok_or("Not listening")?;
    let streams = state.streams.lock().map_err(|e| e.to_string())?;
    let s = streams.get(&stream_id).ok_or("Stream not found")?;
    let result = s.transcribe(0).map_err(|e| e.to_string())?;

    let mut live = String::new();
    let mut completed = String::new();
    for line in &result.lines {
        let target = if line.is_complete {
            &mut completed
        } else {
            &mut live
        };
        if !target.is_empty() {
            target.push(' ');
        }
        target.push_str(&line.text);
    }
    Ok(LeanPollResult {
        live: live.trim().to_string(),
        completed: completed.trim().to_string(),
    })
}

#[derive(serde::Serialize)]
pub struct MicActivity {
    pub samples: u64,
    pub energy: f32,
    pub speech: bool,
}

/// Drop buffered mic audio while TTS plays so speaker output queued in the
/// capture buffer never reaches inference. VAD energy stays live for barge-in.
/// Former `moonshine_stt_set_suppress`.
pub fn stt_set_suppress(state: &MoonshineSttState, suppress: bool) -> Result<(), String> {
    let mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
    mic.set_muted(suppress);
    Ok(())
}

/// Cheap VAD snapshot for the adaptive poller: no inference, no allocation.
/// Former `moonshine_stt_activity`.
pub fn stt_activity(state: &MoonshineSttState) -> Result<MicActivity, String> {
    let mic = state.mic_capture.lock().map_err(|e| e.to_string())?;
    let (samples, energy) = mic.activity().snapshot();
    let speech = super::audio::is_speech_energy(energy);
    Ok(MicActivity {
        samples,
        energy,
        speech,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unload_refuses_while_listening() {
        let state = MoonshineSttState::new();
        assert!(stt_unload(&state).is_ok(), "idle state unloads cleanly");
        *state.active_stream_id.lock().unwrap() = Some(7);
        let err = stt_unload(&state).unwrap_err();
        assert_eq!(err, "STT is currently listening");
        *state.active_stream_id.lock().unwrap() = None;
        *state.raw_listening.lock().unwrap() = true;
        assert_eq!(stt_unload(&state).unwrap_err(), "STT is currently listening");
    }

    #[test]
    fn take_and_stop_raw_return_zeroed_chunks() {
        let state = MoonshineSttState::new();
        let chunk = stt_take_raw_audio(&state).unwrap();
        assert!(chunk.samples.is_empty());
        assert_eq!(chunk.sample_rate, 16000, "default device rate before any capture");
        let tail = stt_stop_raw(&state).unwrap();
        assert!(tail.samples.is_empty());
        assert!(!*state.raw_listening.lock().unwrap());
    }

    #[test]
    fn activity_defaults_to_silence() {
        let state = MoonshineSttState::new();
        let a = stt_activity(&state).unwrap();
        assert_eq!(a.samples, 0);
        assert_eq!(a.energy, 0.0);
        assert!(!a.speech);
    }

    #[test]
    fn stream_helpers_error_without_transcriber() {
        let state = MoonshineSttState::new();
        assert_eq!(
            stt_create_stream(&state).unwrap_err(),
            "STT model dir not configured"
        );
        assert_eq!(stt_stream_start(&state, 1).unwrap_err(), "Stream not found");
        assert_eq!(
            stt_stream_add_audio(&state, 1, vec![0.0], 16000).unwrap_err(),
            "Stream not found"
        );
        assert_eq!(
            stt_stream_transcribe(&state, 1, 0).unwrap_err(),
            "Stream not found"
        );
        assert_eq!(stt_stream_stop(&state, 1).err().unwrap(), "Stream not found");
    }

    #[test]
    fn listening_helpers_error_without_active_stream() {
        let state = MoonshineSttState::new();
        assert_eq!(stt_stop_listening(&state).err().unwrap(), "Not listening");
        assert_eq!(stt_transcribe_streaming(&state).err().unwrap(), "Not listening");
        assert_eq!(stt_poll_text(&state).err().unwrap(), "Not listening");
    }
}
