//! Port of `app/src-tauri/src/moonshine/audio.rs` (verbatim): the native cpal
//! mic capture with its own realtime callback and writer threads.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};

use super::error::MoonshineError;

// RMS below this counts as silence for the VAD gate.
// ponytail: fixed threshold; expose in perf settings if wake-word misfires.
const SILENCE_RMS: f32 = 0.01;

pub fn is_speech_energy(energy: f32) -> bool {
    energy >= SILENCE_RMS
}
// Cap buffered audio at ~10s @16kHz; drop oldest on overflow.
const MAX_QUEUE_SAMPLES: usize = 160_000;
// Writer drains in chunks no larger than ~1s @16kHz.
const DRAIN_CHUNK: usize = 16_000;

/// Rolling audio activity, written by the realtime callback, read by pollers.
pub struct AudioActivity {
    /// Total mono samples pushed since `start`. Pollers diff this to detect new audio.
    pub samples: AtomicU64,
    /// Decaying peak RMS (f32 bits). Above SILENCE_RMS means speech is likely.
    pub energy: AtomicU32,
}

impl AudioActivity {
    fn new() -> Self {
        AudioActivity {
            samples: AtomicU64::new(0),
            energy: AtomicU32::new(0f32.to_bits()),
        }
    }

    fn reset(&self) {
        self.samples.store(0, Ordering::Relaxed);
        self.energy.store(0f32.to_bits(), Ordering::Relaxed);
    }

    /// Fold one callback buffer's energy in. Called on the audio thread.
    fn observe(&self, sum_sq: f32, n: usize) {
        if n == 0 {
            return;
        }
        self.samples.fetch_add(n as u64, Ordering::Relaxed);
        let rms = (sum_sq / n as f32).sqrt();
        let prev = f32::from_bits(self.energy.load(Ordering::Relaxed));
        let next = prev * 0.95 + rms * 0.05;
        self.energy.store(next.max(rms.min(1.0)).to_bits(), Ordering::Relaxed);
    }

    pub fn snapshot(&self) -> (u64, f32) {
        (
            self.samples.load(Ordering::Relaxed),
            f32::from_bits(self.energy.load(Ordering::Relaxed)),
        )
    }

    #[allow(dead_code)]
    pub fn is_speech(&self) -> bool {
        f32::from_bits(self.energy.load(Ordering::Relaxed)) >= SILENCE_RMS
    }
}

pub struct NativeMicCapture {
    stream: Option<cpal::Stream>,
    writer: Option<std::thread::JoinHandle<()>>,
    stop_flag: Arc<AtomicBool>,
    muted: Arc<AtomicBool>,
    sample_rate: u32,
    activity: Arc<AudioActivity>,
    /// Raw mic audio for cloud STT: the writer thread appends here instead of
    /// feeding Moonshine. Drained by `take_pending` from the frontend.
    pending: Arc<Mutex<VecDeque<f32>>>,
}

// ~30s at 48kHz; cloud endpointing sends long before this.
const MAX_RAW_PENDING: usize = 1_440_000;

// cpal::Stream contains *mut () internally but is safe to send across threads
unsafe impl Send for NativeMicCapture {}
unsafe impl Sync for NativeMicCapture {}

impl NativeMicCapture {
    pub fn new() -> Self {
        NativeMicCapture {
            stream: None,
            writer: None,
            stop_flag: Arc::new(AtomicBool::new(false)),
            muted: Arc::new(AtomicBool::new(false)),
            sample_rate: 16000,
            activity: Arc::new(AudioActivity::new()),
            pending: Arc::new(Mutex::new(VecDeque::with_capacity(32_768))),
        }
    }

    #[allow(dead_code)]
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn activity(&self) -> Arc<AudioActivity> {
        Arc::clone(&self.activity)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn start(
        &mut self,
        transcriber_handle: i32,
        stream_handle: i32,
    ) -> Result<(), MoonshineError> {
        self.stop();

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| MoonshineError {
                code: -1,
                message: "No input device available".into(),
            })?;

        let supported = device
            .default_input_config()
            .map_err(|e| MoonshineError {
                code: -1,
                message: e.to_string(),
            })?;

        self.sample_rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;
        let sample_format = supported.sample_format();
        let sr = self.sample_rate;

        let config: StreamConfig = supported.into();

        let err_fn = |e: cpal::StreamError| {
            eprintln!("Audio stream error: {e}");
        };

        // Bounded queue decouples the realtime callback from inference latency.
        let queue: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::with_capacity(32768)));
        let th = transcriber_handle;
        let sh = stream_handle;

        self.activity.reset();
        self.stop_flag.store(false, Ordering::Relaxed);
        self.muted.store(false, Ordering::Relaxed);
        let activity = Arc::clone(&self.activity);

        let stream = build_input_stream(
            &device,
            &config,
            &queue,
            &activity,
            channels,
            sample_format,
            err_fn,
        )?;

        // Writer thread feeds Moonshine off the audio thread so a slow
        // inference call can never stall/glitch realtime capture.
        // While muted (TTS playing) the queue is drained and dropped so
        // buffered speaker audio never hits inference. Energy tracking
        // stays live so the frontend barge-in detector still sees voice.
        let writer_queue = Arc::clone(&queue);
        let writer_stop = Arc::clone(&self.stop_flag);
        let writer_muted = Arc::clone(&self.muted);
        self.writer = Some(
            std::thread::Builder::new()
                .name("moonshine-mic-writer".into())
                .spawn(move || {
                    let mut chunk = Vec::with_capacity(DRAIN_CHUNK);
                    while !writer_stop.load(Ordering::Relaxed) {
                        chunk.clear();
                        if let Ok(mut q) = writer_queue.lock() {
                            let n = q.len().min(DRAIN_CHUNK);
                            chunk.extend(q.drain(..n));
                        }
                        if !chunk.is_empty() {
                            if writer_muted.load(Ordering::Relaxed) {
                                std::thread::sleep(std::time::Duration::from_millis(10));
                                continue;
                            }
                            unsafe {
                                moonshine_sys::moonshine_transcribe_add_audio_to_stream(
                                    th,
                                    sh,
                                    chunk.as_ptr(),
                                    chunk.len() as u64,
                                    sr as i32,
                                    0,
                                );
                            }
                        } else {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                        }
                    }
                })
                .map_err(|e| MoonshineError {
                    code: -1,
                    message: e.to_string(),
                })?,
        );

        stream.play().map_err(|e| {
            // Don't leak the writer thread when capture fails to start.
            self.stop_flag.store(true, Ordering::Relaxed);
            if let Some(writer) = self.writer.take() {
                let _ = writer.join();
            }
            MoonshineError {
                code: -1,
                message: e.to_string(),
            }
        })?;

        self.stream = Some(stream);
        Ok(())
    }

    /// Capture mic audio WITHOUT the Moonshine engine, for cloud STT: the
    /// writer thread buffers samples into `pending` for the frontend to drain
    /// and forward to the provider. Muted (TTS playing) drops audio exactly
    /// like the Moonshine path; VAD energy stays live for barge-in.
    pub fn start_raw(&mut self) -> Result<(), MoonshineError> {
        self.stop();

        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or_else(|| MoonshineError {
                code: -1,
                message: "No input device available".into(),
            })?;

        let supported = device
            .default_input_config()
            .map_err(|e| MoonshineError {
                code: -1,
                message: e.to_string(),
            })?;

        self.sample_rate = supported.sample_rate().0;
        let channels = supported.channels() as usize;
        let sample_format = supported.sample_format();

        let config: StreamConfig = supported.into();

        let err_fn = |e: cpal::StreamError| {
            eprintln!("Audio stream error: {e}");
        };

        let queue: Arc<Mutex<VecDeque<f32>>> = Arc::new(Mutex::new(VecDeque::with_capacity(32768)));
        self.activity.reset();
        self.stop_flag.store(false, Ordering::Relaxed);
        self.muted.store(false, Ordering::Relaxed);
        // Drop anything stale from a previous session.
        if let Ok(mut p) = self.pending.lock() {
            p.clear();
        }
        let activity = Arc::clone(&self.activity);

        let stream = build_input_stream(
            &device,
            &config,
            &queue,
            &activity,
            channels,
            sample_format,
            err_fn,
        )?;

        let writer_queue = Arc::clone(&queue);
        let writer_stop = Arc::clone(&self.stop_flag);
        let writer_muted = Arc::clone(&self.muted);
        let writer_pending = Arc::clone(&self.pending);
        self.writer = Some(
            std::thread::Builder::new()
                .name("cloud-mic-writer".into())
                .spawn(move || {
                    let mut chunk: Vec<f32> = Vec::with_capacity(DRAIN_CHUNK);
                    while !writer_stop.load(Ordering::Relaxed) {
                        chunk.clear();
                        if let Ok(mut q) = writer_queue.lock() {
                            let n = q.len().min(DRAIN_CHUNK);
                            chunk.extend(q.drain(..n));
                        }
                        if chunk.is_empty() {
                            std::thread::sleep(std::time::Duration::from_millis(10));
                            continue;
                        }
                        if writer_muted.load(Ordering::Relaxed) {
                            continue;
                        }
                        if let Ok(mut p) = writer_pending.lock() {
                            for s in chunk.drain(..) {
                                if p.len() >= MAX_RAW_PENDING {
                                    p.pop_front();
                                }
                                p.push_back(s);
                            }
                        }
                    }
                })
                .map_err(|e| MoonshineError {
                    code: -1,
                    message: e.to_string(),
                })?,
        );

        stream.play().map_err(|e| {
            self.stop_flag.store(true, Ordering::Relaxed);
            if let Some(writer) = self.writer.take() {
                let _ = writer.join();
            }
            MoonshineError {
                code: -1,
                message: e.to_string(),
            }
        })?;

        self.stream = Some(stream);
        Ok(())
    }

    /// Drain buffered raw mic audio (cloud STT). Returns the samples at the
    /// device sample rate; the frontend resamples before uploading.
    pub fn take_pending(&self) -> (Vec<f32>, u32) {
        let mut out = Vec::new();
        if let Ok(mut p) = self.pending.lock() {
            out.reserve(p.len());
            while let Some(s) = p.pop_front() {
                out.push(s);
            }
        }
        (out, self.sample_rate)
    }

    pub fn stop(&mut self) {
        self.stop_flag.store(true, Ordering::Relaxed);
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        self.stream.take();
    }
}

/// Build the mono downmixing input stream for the shared realtime queue.
/// The sample-format match exists because cpal requires a typed callback.
fn build_input_stream(
    device: &cpal::Device,
    config: &StreamConfig,
    queue: &Arc<Mutex<VecDeque<f32>>>,
    activity: &Arc<AudioActivity>,
    channels: usize,
    sample_format: SampleFormat,
    err_fn: impl Fn(cpal::StreamError) + Send + Copy + 'static,
) -> Result<cpal::Stream, MoonshineError> {
    let cb_queue = Arc::clone(queue);
    let cb_activity = Arc::clone(activity);
    if !matches!(sample_format, SampleFormat::F32 | SampleFormat::I16 | SampleFormat::U16) {
        return Err(MoonshineError {
            code: -1,
            message: format!("Unsupported sample format: {sample_format:?}"),
        });
    }
    let stream = match sample_format {
        SampleFormat::F32 => device.build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                push_f32(&cb_queue, &cb_activity, data, channels, |s| s);
            },
            err_fn,
            None,
        ),
        SampleFormat::I16 => device.build_input_stream(
            config,
            move |data: &[i16], _: &cpal::InputCallbackInfo| {
                push_f32(&cb_queue, &cb_activity, data, channels, |s| s as f32 / 32768.0);
            },
            err_fn,
            None,
        ),
        SampleFormat::U16 => device.build_input_stream(
            config,
            move |data: &[u16], _: &cpal::InputCallbackInfo| {
                push_f32(&cb_queue, &cb_activity, data, channels, |s| {
                    (s as f32 - 32768.0) / 32768.0
                });
            },
            err_fn,
            None,
        ),
        _ => unreachable!("filtered above"),
    };
    stream.map_err(|e| MoonshineError {
        code: -1,
        message: e.to_string(),
    })
}

impl Drop for NativeMicCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Downmix one callback buffer to mono and append it to the queue.
/// No allocation: frames are averaged inline. Also folds RMS into `activity`.
fn push_f32<T>(
    queue: &Arc<Mutex<VecDeque<f32>>>,
    activity: &Arc<AudioActivity>,
    data: &[T],
    channels: usize,
    conv: impl Fn(T) -> f32 + Copy,
)
where
    T: Copy,
{
    let frames = data.len() / channels.max(1);
    if frames == 0 {
        return;
    }
    let mut sum_sq = 0f32;
    if let Ok(mut q) = queue.try_lock() {
        if channels <= 1 {
            for &s in data.iter().take(frames) {
                let m = conv(s);
                sum_sq += m * m;
                if q.len() < MAX_QUEUE_SAMPLES {
                    q.push_back(m);
                }
            }
        } else {
            for frame in data.chunks_exact(channels).take(frames) {
                let mut acc = 0f32;
                for &s in frame {
                    acc += conv(s);
                }
                let m = acc / channels as f32;
                sum_sq += m * m;
                if q.len() < MAX_QUEUE_SAMPLES {
                    q.push_back(m);
                }
            }
        }
        // Drop oldest when over capacity instead of growing unbounded.
        while q.len() > MAX_QUEUE_SAMPLES {
            q.pop_front();
        }
    } else {
        // Writer holds the lock; still account energy so the VAD stays live.
        if channels <= 1 {
            for &s in data.iter().take(frames) {
                let m = conv(s);
                sum_sq += m * m;
            }
        } else {
            for frame in data.chunks_exact(channels).take(frames) {
                let mut acc = 0f32;
                for &s in frame {
                    acc += conv(s);
                }
                let m = acc / channels as f32;
                sum_sq += m * m;
            }
        }
    }
    activity.observe(sum_sq, frames);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speech_energy_threshold_matches_silence_rms() {
        assert!(!is_speech_energy(SILENCE_RMS - 0.001), "below the gate is silence");
        assert!(is_speech_energy(SILENCE_RMS), "at/above the gate is speech");
    }

    #[test]
    fn activity_snapshot_counts_samples_and_decays_energy() {
        let activity = AudioActivity::new();
        let (samples, energy) = activity.snapshot();
        assert_eq!(samples, 0);
        assert_eq!(energy, 0.0);
        activity.observe(0.04, 100); // rms = 0.02 > SILENCE_RMS
        let (samples, energy) = activity.snapshot();
        assert_eq!(samples, 100);
        assert!(energy > SILENCE_RMS, "rms 0.02 should register as speech");
        activity.reset();
        assert_eq!(activity.snapshot().0, 0);
    }
}
