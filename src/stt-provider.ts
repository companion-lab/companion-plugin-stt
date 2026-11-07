// STT provider — port of the host's app/src/audio/moonshine-stt.ts (NativeStt,
// setSttSuppress, micEnergy, listDevices) and app/src/audio/cloud-stt.ts
// (CloudStt), wrapped in the SDK's SttProvider shape.
//
// Backend wiring: every former `moonshine_stt_*` tauri command maps 1:1 onto
// a `stt.*` backend method with the same snake_case payload (see the voice
// backend's lib.rs table).
//
// Model loading: the frontend never calls "stt.load" — that method requires
// an absolute model path. The backend instead resolves the voice-assets root
// itself during plugin init (env override → dev checkout → plugin bundle
// assets) and configures the default model dir + arch
// (MOONSHINE_MODEL_ARCH_MEDIUM_STREAMING); the transcriber then lazy-loads
// from that dir on the first "stt.start_listening"/"stt.transcribe"/
// "stt.create_stream" call (ensure_transcriber in the backend).

import type { PluginContext, SttEngine, SttProvider } from "../../../sdk/js/@companion/plugin";
import { cloudTranscribe } from "./cloud-stt";

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface TranscriptLine {
  text: string;
  start_time: number;
  duration: number;
  is_complete: boolean;
  id: number;
  words: TranscriptWord[];
  last_transcription_latency_ms: number;
}

export interface TranscriptResult {
  lines: TranscriptLine[];
}

type LeanPoll = { live: string; completed: string };
type Activity = { samples: number; energy: number; speech: boolean };
type RawChunk = { samples: number[]; sample_rate: number };

const POLL_ACTIVE_MS = 200;
const POLL_IDLE_MS = 800;
// Consecutive silent polls before backing off to the idle interval.
const IDLE_BACKOFF_POLLS = 4;
// VAD energy above this counts as deliberate speech for barge-in. Mic-level
// TTS leak sits well below; a nearby voice sits well above. Hand-tuned.
export const BARGE_ENERGY_THRESHOLD = 0.35;

export function normTranscript(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[,\.:;!?\-–—'"()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── NativeStt (Moonshine) — host port over ctx.backend.call ───

export class NativeStt {
  private pollTimer: number | null = null;
  private silenceTimer: number | null = null;
  private stopped = false;
  private firedCompletedPrefix = "";
  private lastFiredText = "";
  private lastFiredAt = 0;
  private lastLive = "";
  private lastCompleted = "";
  private lastSamples = 0;
  private quietPolls = 0;
  private onLiveText: (text: string) => void;
  private onSpeechEnd: (text: string) => void;
  private onError: (err: string) => void;
  private onBargeIn: ((energy: number) => void) | null = null;
  private backend: PluginContext["backend"];

  constructor(
    backend: PluginContext["backend"],
    onLiveText: (text: string) => void,
    onSpeechEnd: (text: string) => void,
    onError: (err: string) => void = console.error,
  ) {
    this.backend = backend;
    this.onLiveText = onLiveText;
    this.onSpeechEnd = onSpeechEnd;
    this.onError = onError;
  }

  /** Called with VAD energy when loud speech arrives mid-suppression. */
  setBargeInListener(fn: ((energy: number) => void) | null): void {
    this.onBargeIn = fn;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.firedCompletedPrefix = "";
    this.lastFiredText = "";
    this.lastFiredAt = 0;
    this.resetBaseline();
    // Lazy-loads the Moonshine model backend-side on the first call.
    await this.backend.call("stt.start_listening");
    this.schedulePoll(POLL_ACTIVE_MS);
  }

  resetBaseline() {
    this.lastLive = "";
    this.lastCompleted = "";
    this.lastSamples = 0;
    this.quietPolls = 0;
    this.clearTimer();
  }

  discardPending() {
    this.firedCompletedPrefix = this.lastCompleted;
    this.lastLive = "";
    this.clearTimer();
    this.onLiveText("");
  }

  shouldSend(text: string): boolean {
    const t = normTranscript(text);
    if (!t) return false;
    const now = Date.now();
    if (t === this.lastFiredText && now - this.lastFiredAt < 8000) return false;
    this.lastFiredText = t;
    this.lastFiredAt = now;
    return true;
  }

  async stop(): Promise<TranscriptResult | null> {
    this.stopped = true;
    this.clearTimer();
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    try {
      return await this.backend.call<TranscriptResult>("stt.stop_listening");
    } catch (e) {
      this.onError(String(e));
      return null;
    }
  }

  private clearTimer() {
    if (this.silenceTimer !== null) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  private schedulePoll(ms: number) {
    if (this.stopped) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    this.pollTimer = null;
    if (this.stopped) return;
    try {
      // Cheap VAD snapshot first: skip inference entirely when the mic has
      // been silent since the last poll, and back off the cadence.
      let act: Activity | null = null;
      try {
        act = await this.backend.call<Activity>("stt.activity");
      } catch {
        /* fall through to inference */
      }

      const sawNewAudio = act ? act.samples !== this.lastSamples : true;
      if (act) this.lastSamples = act.samples;

      // Barge-in: loud speech while suppressed means the user is talking over
      // the avatar. Fire before the quiet early-return so suppression never
      // swallows it. VAD snapshot only — no inference cost.
      if (
        this.onBargeIn &&
        act &&
        act.speech &&
        act.energy >= BARGE_ENERGY_THRESHOLD
      ) {
        this.onBargeIn(act.energy);
      }

      if (!sawNewAudio && !act?.speech) {
        this.quietPolls++;
        this.schedulePoll(
          this.quietPolls >= IDLE_BACKOFF_POLLS ? POLL_IDLE_MS : POLL_ACTIVE_MS,
        );
        return;
      }
      this.quietPolls = 0;

      const { live: inProgress, completed: allCompleted } = await this.backend.call<LeanPoll>(
        "stt.poll_text",
      );

      // Nothing changed: skip the React re-render and stay responsive.
      if (inProgress !== this.lastLive) {
        this.lastLive = inProgress;
        this.lastCompleted = allCompleted;
        this.handleTexts(inProgress, allCompleted);
      } else if (allCompleted !== this.lastCompleted) {
        this.lastCompleted = allCompleted;
        this.handleTexts(inProgress, allCompleted);
      }
    } catch {
      // "Not listening" expected
    }
    this.schedulePoll(this.quietPolls >= IDLE_BACKOFF_POLLS ? POLL_IDLE_MS : POLL_ACTIVE_MS);
  }

  private handleTexts(inProgress: string, allCompleted: string) {
    // Strip already-fired prefix to get only new text
    let newCompleted = allCompleted;
    if (
      this.firedCompletedPrefix &&
      allCompleted.startsWith(this.firedCompletedPrefix)
    ) {
      newCompleted = allCompleted.slice(this.firedCompletedPrefix.length).trim();
    }

    if (inProgress) {
      this.clearTimer();
      this.onLiveText(inProgress);
    } else if (!newCompleted) {
      this.onLiveText("");
    } else if (!this.silenceTimer) {
      this.onLiveText(newCompleted);
      this.silenceTimer = window.setTimeout(() => {
        this.silenceTimer = null;
        if (!this.stopped && newCompleted) {
          this.firedCompletedPrefix = allCompleted;
          this.onLiveText("");
          this.onSpeechEnd(newCompleted);
        }
      }, 1000);
    }
  }
}

// ─── CloudStt — host port ───

export const CLOUD_SILENCE_RMS = 0.015;
// Barge-in trigger; mirrors NativeStt's BARGE_ENERGY_THRESHOLD.
export const CLOUD_BARGE_ENERGY_THRESHOLD = 0.35;

const CLOUD_POLL_MS = 120;
// Silence that ends an utterance once speech was detected.
const END_SILENCE_MS = 800;
// Pre-roll kept before the detected speech onset so first syllables survive.
const PRE_ROLL_MS = 350;
// Hard cap per utterance (~30s of audio) — finalize and send.
const MAX_SEGMENT_MS = 30_000;

// While the avatar speaks, TTS audio must never reach transcription. The
// Rust writer drops muted audio; this flag covers the IPC gap around it.
let cloudSuppressed = false;

export function setCloudSttSuppressed(suppressed: boolean): void {
  cloudSuppressed = suppressed;
}

export class CloudStt {
  private pollTimer: number | null = null;
  private stopped = true;
  private lastFiredText = "";
  private lastFiredAt = 0;
  private onLiveText: (text: string) => void;
  private onSpeechEnd: (text: string) => void;
  private onError: (err: string) => void;
  private onBargeIn: ((energy: number) => void) | null = null;
  private backend: PluginContext["backend"];

  // Segment state
  private preRoll: Float32Array[] = [];
  private preRollLen = 0;
  private segment: Float32Array[] = [];
  private segmentLen = 0;
  private inSegment = false;
  private silenceMs = 0;
  private rate = 48_000;

  constructor(
    backend: PluginContext["backend"],
    onLiveText: (text: string) => void,
    onSpeechEnd: (text: string) => void,
    onError: (err: string) => void = console.error,
  ) {
    this.backend = backend;
    this.onLiveText = onLiveText;
    this.onSpeechEnd = onSpeechEnd;
    this.onError = onError;
  }

  /** Called with VAD energy when loud speech arrives mid-suppression. */
  setBargeInListener(fn: ((energy: number) => void) | null): void {
    this.onBargeIn = fn;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.lastFiredText = "";
    this.lastFiredAt = 0;
    this.resetSegment();
    await this.backend.call("stt.start_raw");
    this.schedulePoll(CLOUD_POLL_MS);
  }

  async stop(): Promise<null> {
    this.stopped = true;
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.onLiveText("");
    try {
      await this.backend.call("stt.stop_raw");
    } catch (e) {
      this.onError(String(e));
    }
    return null;
  }

  /** Drop the in-flight utterance (used when TTS output would bleed in). */
  discardPending(): void {
    this.resetSegment();
    this.onLiveText("");
  }

  shouldSend(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    const now = Date.now();
    if (t === this.lastFiredText && now - this.lastFiredAt < 8000) return false;
    this.lastFiredText = t;
    this.lastFiredAt = now;
    return true;
  }

  private resetSegment(): void {
    this.preRoll = [];
    this.preRollLen = 0;
    this.segment = [];
    this.segmentLen = 0;
    this.inSegment = false;
    this.silenceMs = 0;
  }

  private schedulePoll(ms: number) {
    if (this.stopped) return;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = window.setTimeout(() => this.poll(), ms);
  }

  private async poll() {
    this.pollTimer = null;
    if (this.stopped) return;
    try {
      const chunk = await this.backend.call<RawChunk>("stt.take_raw_audio");
      if (chunk.sample_rate > 0) this.rate = chunk.sample_rate;
      if (chunk.samples.length > 0) {
        const samples = Float32Array.from(chunk.samples);
        this.handleSamples(samples);
      }
    } catch {
      // "Not listening" or IPC hiccup — keep polling.
    }
    this.schedulePoll(CLOUD_POLL_MS);
  }

  private handleSamples(samples: Float32Array) {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) sumSq += samples[i] * samples[i];
    const rms = Math.sqrt(sumSq / samples.length);
    const speech = rms >= CLOUD_SILENCE_RMS;

    // Barge-in stays live even while TTS output is being dropped, matching
    // the native engine's behavior.
    if (this.onBargeIn && speech && rms >= CLOUD_BARGE_ENERGY_THRESHOLD) {
      this.onBargeIn(rms);
    }

    if (cloudSuppressed) {
      // Speaker echo window: forget any half-built utterance.
      this.resetSegment();
      return;
    }

    const ms = (samples.length / this.rate) * 1000;

    if (!this.inSegment) {
      // Keep a rolling pre-roll so utterance onsets are preserved.
      this.preRoll.push(samples);
      this.preRollLen += samples.length;
      const keep = Math.ceil((PRE_ROLL_MS / 1000) * this.rate);
      while (
        this.preRollLen - this.preRoll[0].length > keep &&
        this.preRoll.length > 1
      ) {
        this.preRollLen -= this.preRoll.shift()!.length;
      }
      if (speech) {
        this.inSegment = true;
        this.silenceMs = 0;
        this.segment = [...this.preRoll];
        this.segmentLen = this.preRollLen;
        this.preRoll = [];
        this.preRollLen = 0;
      }
      return;
    }

    // In segment
    this.segment.push(samples);
    this.segmentLen += samples.length;
    if (speech) {
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
    }

    if (
      (this.silenceMs >= END_SILENCE_MS && this.segmentLen > this.rate * 0.2) ||
      this.segmentLen > (MAX_SEGMENT_MS / 1000) * this.rate
    ) {
      void this.finalizeSegment();
    }
  }

  private async finalizeSegment() {
    const parts = this.segment;
    const len = this.segmentLen;
    this.resetSegment();

    if (len === 0) return;
    const pcm = new Float32Array(len);
    let off = 0;
    for (const part of parts) {
      pcm.set(part, off);
      off += part.length;
    }

    // Skip trailing silence so short utterances upload less.
    let end = pcm.length;
    while (end > 0 && Math.abs(pcm[end - 1]) < CLOUD_SILENCE_RMS) end--;

    if (end < this.rate * 0.15) return; // too short to be speech

    try {
      const text = await cloudTranscribe(pcm.subarray(0, end), this.rate);
      if (this.stopped) return;
      if (text) {
        this.onSpeechEnd(text);
      }
    } catch (e) {
      if (!this.stopped) this.onError(e instanceof Error ? e.message : String(e));
    }
  }
}

// ─── Module-level helpers (host ports) ───

export async function transcribe(
  backend: PluginContext["backend"],
  audio: Float32Array,
  sampleRate: number = 16000,
): Promise<TranscriptResult> {
  return backend.call<TranscriptResult>("stt.transcribe", {
    audio: Array.from(audio),
    sample_rate: sampleRate,
  });
}

export async function listDevices(
  backend: PluginContext["backend"],
): Promise<string[]> {
  return backend.call<string[]>("stt.list_devices");
}

/** Host port of setSttSuppress: the cloud engine has no Rust stream to mute,
 *  it watches this flag; the native capture is muted backend-side. */
export async function setSttSuppress(
  backend: PluginContext["backend"],
  suppress: boolean,
): Promise<void> {
  setCloudSttSuppressed(suppress);
  await backend.call("stt.set_suppress", { suppress }).catch(() => {});
}

export async function micEnergy(
  backend: PluginContext["backend"],
): Promise<number> {
  try {
    const act = await backend.call<Activity>("stt.activity");
    return act.energy;
  } catch {
    return 0;
  }
}

// ─── Provider ───

export function createSttProvider(ctx: PluginContext): SttProvider {
  return {
    id: "voice",
    createEngine: (kind, onLiveText, onSpeechEnd, onError) => {
      const engine: SttEngine =
        kind === "cloud"
          ? new CloudStt(ctx.backend, onLiveText, onSpeechEnd, onError)
          : new NativeStt(ctx.backend, onLiveText, onSpeechEnd, onError);
      return engine;
    },
    setSuppress: (suppress) => setSttSuppress(ctx.backend, suppress),
    micEnergy: () => micEnergy(ctx.backend),
  };
}
