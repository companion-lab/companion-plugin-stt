//! STT feature plugin backend for companion-tauri.
//!
//! Port of the host app's on-device speech engines into plugin backends:
//! `moonshine` ← `app/src-tauri/src/moonshine/` (Moonshine STT, FFI) and
//! `mic_permission` ← `app/src-tauri/src/mic_permission.rs` (macOS TCC gate).
//! The TTS side lives in its own `tts` plugin (`features/tts/backend`); this
//! crate is recognition-only.
//!
//! Wire protocol — every former tauri command maps 1:1 onto a method with the
//! same JSON args and result shapes (snake_case payload fields preserved):
//!
//! | former tauri command / host internal      | method                    |
//! |-------------------------------------------|---------------------------|
//! | `moonshine_stt_load`                       | `stt.load`                |
//! | `moonshine_stt_transcribe`                 | `stt.transcribe`          |
//! | `moonshine_stt_create_stream`              | `stt.create_stream`       |
//! | `moonshine_stt_stream_start`               | `stt.stream_start`        |
//! | `moonshine_stt_stream_add_audio`           | `stt.stream_add_audio`    |
//! | `moonshine_stt_stream_transcribe`          | `stt.stream_transcribe`   |
//! | `moonshine_stt_stream_stop`                | `stt.stream_stop`         |
//! | `moonshine_stt_start_raw`                  | `stt.start_raw`           |
//! | `moonshine_stt_take_raw_audio`             | `stt.take_raw_audio`      |
//! | `moonshine_stt_stop_raw`                   | `stt.stop_raw`            |
//! | `moonshine_stt_start_listening`            | `stt.start_listening`     |
//! | `moonshine_stt_stop_listening`             | `stt.stop_listening`      |
//! | `moonshine_stt_transcribe_streaming`       | `stt.transcribe_streaming`|
//! | `moonshine_stt_list_devices`               | `stt.list_devices`        |
//! | `moonshine_stt_unload`                     | `stt.unload`              |
//! | `moonshine_stt_poll_text`                  | `stt.poll_text`           |
//! | `moonshine_stt_set_suppress`               | `stt.set_suppress`        |
//! | `moonshine_stt_activity`                   | `stt.activity`            |
//!
//! Concurrency: the ported sources are fully synchronous (no async fns, no
//! tokio), so `handle` runs directly on the calling thread. cpal capture
//! keeps its native realtime/writer threads exactly as in the host.
//!
//! Assets: `init` resolves the assets root (containing `moonshine/stt/` with
//! the STT models) and stores it; the loader resolves models lazily, so the
//! plugin loads fine before any model has been downloaded.

use companion_plugin_sdk::{export_plugin, Plugin, PluginCtx};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

mod mic_permission;
mod moonshine;

/// Environment override for the assets root (checked first).
const ENV_STT_ASSETS: &str = "COMPANION_STT_ASSETS";

/// Lexically resolve `..` components so returned dev candidates are clean
/// absolute paths (the dev candidates are built by joining `..` segments).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Resolve the assets root, in order:
/// 1. `COMPANION_STT_ASSETS` env var, when set (trimmed non-empty);
/// 2. `{plugin_dir()}/assets`, i.e. assets bundled with the plugin package
///    (preferred — the plugin is self-contained; models ship inside
///    `features/stt/assets/`);
/// 3. the dev checkout fallback: `{CARGO_MANIFEST_DIR}/../../assets`;
/// 4. fallback to the dev-checkout path without an existence check (so lazy
///    load errors name a sensible location), or the last-resort relative
///    `assets` when even the manifest dir is unknown.
fn resolve_assets_dir(
    env_value: Option<&str>,
    manifest_dir: Option<&Path>,
    plugin_dir: Option<&Path>,
) -> PathBuf {
    // 1. Explicit override.
    if let Some(value) = env_value.map(str::trim).filter(|v| !v.is_empty()) {
        return PathBuf::from(value);
    }

    // 2. Assets bundled with the plugin package (preferred — the plugin is
    //    self-contained).
    if let Some(dir) = plugin_dir {
        let candidate = dir.join("assets");
        if candidate.exists() {
            return candidate;
        }
    }

    // 3. Dev-checkout candidate (existence-checked) — fallback for builds
    //    that haven't staged assets into the package yet.
    if let Some(manifest) = manifest_dir {
        let candidate = normalize(&manifest.join("../../assets"));
        if candidate.exists() {
            return candidate;
        }
        return candidate;
    }

    // 4. Fallback.
    PathBuf::from("assets")
}

// ─── Payload extraction (tauri's named-argument binding, over JSON) ───

fn req_str<'a>(payload: &'a Value, key: &str) -> Result<&'a str, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing or invalid argument: {key}"))
}

fn req_bool(payload: &Value, key: &str) -> Result<bool, String> {
    payload
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("missing or invalid argument: {key}"))
}

fn req_u32(payload: &Value, key: &str) -> Result<u32, String> {
    payload
        .get(key)
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .ok_or_else(|| format!("missing or invalid argument: {key}"))
}

fn req_i32(payload: &Value, key: &str) -> Result<i32, String> {
    payload
        .get(key)
        .and_then(Value::as_i64)
        .map(|v| v as i32)
        .ok_or_else(|| format!("missing or invalid argument: {key}"))
}

fn req_vec_f32(payload: &Value, key: &str) -> Result<Vec<f32>, String> {
    let array = payload
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("missing or invalid argument: {key}"))?;
    array
        .iter()
        .map(|v| {
            v.as_f64()
                .map(|f| f as f32)
                .ok_or_else(|| format!("invalid argument: {key} contains a non-numeric value"))
        })
        .collect()
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

pub struct SttPlugin {
    ctx: Option<PluginCtx>,
    stt: moonshine::commands::MoonshineSttState,
}

impl Default for SttPlugin {
    fn default() -> Self {
        Self::new()
    }
}

impl SttPlugin {
    pub fn new() -> Self {
        SttPlugin {
            ctx: None,
            stt: moonshine::commands::MoonshineSttState::new(),
        }
    }

    /// Wire the resolved assets root into the engine, mirroring the host's
    /// `MoonshineSttState::set_model(resolve_asset_dir("moonshine/stt"))`
    /// setup (STT stays lazy: the dir is only used by `ensure_transcriber`).
    fn apply_assets_root(&mut self, root: &Path) {
        let model_dir = root.join("moonshine").join("stt");
        self.stt.set_model(
            model_dir.to_string_lossy().into_owned(),
            moonshine_sys::MOONSHINE_MODEL_ARCH_MEDIUM_STREAMING,
        );
    }

    fn route(&self, method: &str, payload: Value) -> Result<Value, String> {
        match method {
            "stt.load" => {
                let model_path = req_str(&payload, "model_path")?.to_string();
                let model_arch = req_u32(&payload, "model_arch")?;
                moonshine::commands::stt_load(&self.stt, model_path, model_arch)?;
                Ok(Value::Null)
            }
            "stt.transcribe" => {
                let audio = req_vec_f32(&payload, "audio")?;
                let sample_rate = req_i32(&payload, "sample_rate")?;
                let result = moonshine::commands::stt_transcribe(&self.stt, audio, sample_rate)?;
                to_value(result)
            }
            "stt.create_stream" => {
                let id = moonshine::commands::stt_create_stream(&self.stt)?;
                Ok(json!(id))
            }
            "stt.stream_start" => {
                let stream_id = req_i32(&payload, "stream_id")?;
                moonshine::commands::stt_stream_start(&self.stt, stream_id)?;
                Ok(Value::Null)
            }
            "stt.stream_add_audio" => {
                let stream_id = req_i32(&payload, "stream_id")?;
                let audio = req_vec_f32(&payload, "audio")?;
                let sample_rate = req_i32(&payload, "sample_rate")?;
                moonshine::commands::stt_stream_add_audio(&self.stt, stream_id, audio, sample_rate)?;
                Ok(Value::Null)
            }
            "stt.stream_transcribe" => {
                let stream_id = req_i32(&payload, "stream_id")?;
                let flags = req_u32(&payload, "flags")?;
                let result = moonshine::commands::stt_stream_transcribe(&self.stt, stream_id, flags)?;
                to_value(result)
            }
            "stt.stream_stop" => {
                let stream_id = req_i32(&payload, "stream_id")?;
                let result = moonshine::commands::stt_stream_stop(&self.stt, stream_id)?;
                to_value(result)
            }
            "stt.start_raw" => {
                moonshine::commands::stt_start_raw(&self.stt)?;
                Ok(Value::Null)
            }
            "stt.take_raw_audio" => {
                let chunk = moonshine::commands::stt_take_raw_audio(&self.stt)?;
                to_value(chunk)
            }
            "stt.stop_raw" => {
                let chunk = moonshine::commands::stt_stop_raw(&self.stt)?;
                to_value(chunk)
            }
            "stt.start_listening" => {
                let stream_id = moonshine::commands::stt_start_listening(&self.stt)?;
                Ok(json!(stream_id))
            }
            "stt.stop_listening" => {
                let result = moonshine::commands::stt_stop_listening(&self.stt)?;
                to_value(result)
            }
            "stt.transcribe_streaming" => {
                let result = moonshine::commands::stt_transcribe_streaming(&self.stt)?;
                to_value(result)
            }
            "stt.list_devices" => {
                let devices = moonshine::commands::stt_list_devices()?;
                Ok(json!(devices))
            }
            "stt.unload" => {
                moonshine::commands::stt_unload(&self.stt)?;
                Ok(Value::Null)
            }
            "stt.poll_text" => {
                let result = moonshine::commands::stt_poll_text(&self.stt)?;
                to_value(result)
            }
            "stt.set_suppress" => {
                let suppress = req_bool(&payload, "suppress")?;
                moonshine::commands::stt_set_suppress(&self.stt, suppress)?;
                Ok(Value::Null)
            }
            "stt.activity" => {
                let activity = moonshine::commands::stt_activity(&self.stt)?;
                to_value(activity)
            }
            // Lifecycle parity with the tts plugin (perf panel contract):
            // release the engine; report its load state.
            "stt.release_memory" => {
                moonshine::commands::unload_transcriber(&self.stt);
                Ok(json!({ "ok": true }))
            }
            "stt.engine_status" => Ok(json!({
                "stt_loaded": moonshine::commands::is_transcriber_loaded(&self.stt),
            })),
            other => Err(format!("unknown method: {other}")),
        }
    }
}

impl Plugin for SttPlugin {
    fn init(&mut self, ctx: PluginCtx) -> Result<(), String> {
        let env_value = std::env::var(ENV_STT_ASSETS).ok();
        let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let assets_root = resolve_assets_dir(
            env_value.as_deref(),
            Some(&manifest_dir),
            ctx.plugin_dir().as_deref(),
        );
        ctx.info(&format!("stt assets dir: {}", assets_root.display()));
        self.apply_assets_root(&assets_root);
        self.ctx = Some(ctx);
        Ok(())
    }

    fn handle(&mut self, method: &str, payload: Value) -> Result<Value, String> {
        self.route(method, payload)
    }

    fn shutdown(&mut self) {
        // Mirror the host's teardown (dropping managed state): stop capture
        // first so the writer threads release their raw Moonshine handles,
        // then free streams and the engine. Best-effort, like the Drop impls
        // in the ported modules.
        if let Ok(mut mic) = self.stt.mic_capture.lock() {
            mic.stop();
        }
        if let Ok(mut streams) = self.stt.streams.lock() {
            streams.clear();
        }
        if let Ok(mut active) = self.stt.active_stream_id.lock() {
            *active = None;
        }
        if let Ok(mut raw) = self.stt.raw_listening.lock() {
            *raw = false;
        }
        moonshine::commands::unload_transcriber(&self.stt);
        if let Some(ctx) = &self.ctx {
            ctx.info("stt backend shut down");
        }
    }
}

export_plugin!(SttPlugin::new());

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stt-plugin-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Repo-shaped fixture: `root/l0/l1` is the (fake) CARGO_MANIFEST_DIR so
    /// `{manifest}/../../assets` resolves to `root/assets`.
    fn fixture(tag: &str, with_assets: bool) -> (PathBuf, PathBuf) {
        let root = temp_root(tag);
        let mut manifest = root.clone();
        for i in 0..2 {
            manifest = manifest.join(format!("l{i}"));
        }
        fs::create_dir_all(&manifest).unwrap();
        if with_assets {
            fs::create_dir_all(root.join("assets")).unwrap();
        }
        (root, manifest)
    }

    #[test]
    fn env_var_wins_over_everything() {
        let (root, manifest) = fixture("env", true);
        let resolved = resolve_assets_dir(Some("/custom/stt-assets"), Some(&manifest), None);
        assert_eq!(resolved, PathBuf::from("/custom/stt-assets"));
        assert!(root.exists(), "fixture sanity");
    }

    #[test]
    fn dev_checkout_assets_win_when_no_plugin_dir() {
        let (root, manifest) = fixture("dev-win", true);
        let resolved = resolve_assets_dir(None, Some(&manifest), None);
        assert_eq!(resolved, root.join("assets"));
    }

    #[test]
    fn falls_back_to_dev_path_without_existence_check() {
        let (_root, manifest) = fixture("fallback", false);
        let resolved = resolve_assets_dir(None, Some(&manifest), None);
        assert!(
            resolved.ends_with("assets"),
            "dev candidate returned even when it does not exist, got {resolved:?}"
        );
    }

    /// The resolved root must feed the engine exactly like the host setup:
    /// the STT model dir at `<root>/moonshine/stt`.
    #[test]
    fn apply_assets_root_wires_engine() {
        let mut plugin = SttPlugin::new();
        plugin.apply_assets_root(Path::new("/assets/root"));
        assert_eq!(
            plugin.stt.model_dir.lock().unwrap().as_deref(),
            Some("/assets/root/moonshine/stt")
        );
        assert_eq!(
            *plugin.stt.model_arch.lock().unwrap(),
            moonshine_sys::MOONSHINE_MODEL_ARCH_MEDIUM_STREAMING
        );
    }

    /// Every wire method routes (1:1 command mapping), except `stt.start_raw`
    /// and `stt.start_listening` which would trigger the macOS mic permission
    /// prompt in a test process.
    #[test]
    fn all_wire_methods_route() {
        let mut plugin = SttPlugin::new();
        let cases: Vec<(&str, Value)> = vec![
            ("stt.load", json!({ "model_path": "/nonexistent-model", "model_arch": 5 })),
            ("stt.transcribe", json!({ "audio": [0.0], "sample_rate": 16000 })),
            ("stt.create_stream", json!({})),
            ("stt.stream_start", json!({ "stream_id": 999 })),
            ("stt.stream_add_audio", json!({ "stream_id": 999, "audio": [0.0], "sample_rate": 16000 })),
            ("stt.stream_transcribe", json!({ "stream_id": 999, "flags": 0 })),
            ("stt.stream_stop", json!({ "stream_id": 999 })),
            ("stt.take_raw_audio", json!({})),
            ("stt.stop_raw", json!({})),
            ("stt.stop_listening", json!({})),
            ("stt.transcribe_streaming", json!({})),
            ("stt.list_devices", json!({})),
            ("stt.unload", json!({})),
            ("stt.poll_text", json!({})),
            ("stt.set_suppress", json!({ "suppress": true })),
            ("stt.activity", json!({})),
            ("stt.release_memory", json!({})),
            ("stt.engine_status", json!({})),
        ];
        for (method, payload) in cases {
            let result = plugin.handle(method, payload);
            assert!(
                !matches!(&result, Err(e) if e.contains("unknown method")),
                "{method} must be routed, got {result:?}"
            );
        }
        assert!(plugin.handle("bogus.method", json!({})).unwrap_err().contains("unknown method"));
    }

    #[test]
    fn stt_helpers_behave_without_a_model() {
        let mut plugin = SttPlugin::new();
        // Lazy ensure path with no configured model dir.
        assert_eq!(
            plugin.handle("stt.create_stream", json!({})).unwrap_err(),
            "STT model dir not configured"
        );
        // Raw capture plumbing without any capture session.
        let chunk = plugin.handle("stt.take_raw_audio", json!({})).unwrap();
        assert!(chunk["samples"].as_array().unwrap().is_empty());
        let tail = plugin.handle("stt.stop_raw", json!({})).unwrap();
        assert!(tail["samples"].as_array().unwrap().is_empty());
        // VAD snapshot without a capture stream.
        let activity = plugin.handle("stt.activity", json!({})).unwrap();
        assert_eq!(activity["samples"], 0);
        assert_eq!(activity["speech"], false);
        // Poll/stream helpers with no active stream.
        assert_eq!(plugin.handle("stt.poll_text", json!({})).unwrap_err(), "Not listening");
        assert_eq!(plugin.handle("stt.stop_listening", json!({})).unwrap_err(), "Not listening");
        assert_eq!(
            plugin.handle("stt.stream_start", json!({ "stream_id": 42 })).unwrap_err(),
            "Stream not found"
        );
    }

    #[test]
    fn engine_status_and_release_memory_roundtrip() {
        let mut plugin = SttPlugin::new();
        let status = plugin.handle("stt.engine_status", json!({})).unwrap();
        assert_eq!(status["stt_loaded"], false);
        plugin.handle("stt.release_memory", json!({})).unwrap();
        let status = plugin.handle("stt.engine_status", json!({})).unwrap();
        assert_eq!(status["stt_loaded"], false);
    }

    #[test]
    fn shutdown_is_safe_when_idle() {
        let mut plugin = SttPlugin::new();
        plugin.handle("stt.set_suppress", json!({ "suppress": true })).unwrap();
        plugin.shutdown();
        // Engine remains in a consistent (unloaded) state afterwards.
        let status = plugin.handle("stt.engine_status", json!({})).unwrap();
        assert_eq!(status["stt_loaded"], false);
    }
}
