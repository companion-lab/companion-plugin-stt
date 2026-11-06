// STT (speech recognition) settings store for the `stt` plugin.
//
// Keychain: the key lives in the plugin-namespaced account `stt:api-key`
// (SDK secrets prefix the plugin id). Edits are delivered in-band to the
// other window on the plugin event bus for live sync. Unlike the pre-split
// voice plugin there are no legacy-account migrations — the split was a
// clean cut.

import type { PluginContext } from "../../sdk/js/@companion/plugin";

// ─── STT settings ───

export type SpeechEndpoint = {
  url: string;
  model: string;
};

export type SttSettings = {
  /** STT engine: on-device Moonshine or the cloud provider from Connection. */
  sttProvider?: "local" | "cloud";
  /** Wake phrase; empty = manual mic button (consumed by the chat panel). */
  wakeWord: string;
  /** Cloud transcription endpoint (OpenAI-compatible /v1/audio/transcriptions). */
  cloud: SpeechEndpoint;
};

export const DEFAULT_STT_SETTINGS: SttSettings = {
  sttProvider: "local",
  wakeWord: "",
  cloud: { url: "https://api.openai.com", model: "whisper-1" },
};

const STT_STORE_KEY = "companion:stt";

/** Keychain account under this plugin's namespace (`stt:api-key`). */
export const STT_KEY_NAME = "api-key";

export function loadSttSettings(): SttSettings {
  try {
    const raw = localStorage.getItem(STT_STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SttSettings>;
      return {
        ...DEFAULT_STT_SETTINGS,
        ...parsed,
        cloud: { ...DEFAULT_STT_SETTINGS.cloud, ...(parsed.cloud as Partial<SpeechEndpoint> | undefined) },
      };
    }
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_STT_SETTINGS };
}

// ─── Store: snapshots + subscribe/emit + cross-window sync ───
//
// Both windows run this plugin's frontend; the provider and the settings
// sections stay in sync through this store. Saves write localStorage AND
// emit plugin events so the other window picks the change up live.

type Listener = () => void;

export type SpeechKeys = { api: string };

let ctxRef: PluginContext | null = null;
let sttSnapshot: SttSettings = DEFAULT_STT_SETTINGS;
let keysSnapshot: SpeechKeys = { api: "" };
let keysLoaded = false;
let keysError: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* listener errors must not break the store */
    }
  }
}

function normalizeStt(value: unknown): SttSettings {
  const parsed = (value ?? {}) as Partial<SttSettings>;
  return {
    ...DEFAULT_STT_SETTINGS,
    ...parsed,
    cloud: { ...DEFAULT_STT_SETTINGS.cloud, ...(parsed.cloud ?? {}) },
  };
}

/** Read the key from the namespaced keychain account. Throws on keychain
 *  failure so the UI can show why the key is missing. */
async function loadKey(): Promise<string> {
  const ctx = ctxRef;
  if (!ctx) return "";
  return (await ctx.secrets.get(STT_KEY_NAME)) ?? "";
}

async function refreshKey(): Promise<void> {
  const ctx = ctxRef;
  if (!ctx) return;
  try {
    keysSnapshot = { api: (await loadKey()) ?? "" };
    keysLoaded = true;
    keysError = null;
  } catch (e) {
    // Leave any previously delivered key untouched — an empty keychain read
    // must not clobber a live key.
    keysLoaded = true;
    keysError = `Keychain unavailable — keys won't survive a restart: ${
      e instanceof Error ? e.message : String(e)
    }`;
    ctx.log.warn(`stt keychain load failed: ${keysError}`);
  }
  notify();
}

/** Idempotent. Must run before the provider/sections touch the store. */
export function initSttSettings(ctx: PluginContext): void {
  if (ctxRef) return;
  ctxRef = ctx;
  sttSnapshot = loadSttSettings();

  // Cross-window sync: the other window's saves land here as events.
  ctx.events.on("stt-settings-changed", (payload) => {
    sttSnapshot = normalizeStt(payload);
    notify();
  });
  // In-band key delivery from the settings window: the main window never
  // touches the keychain at runtime after the initial warm-up.
  ctx.events.on("stt-keys-changed", (payload) => {
    const k = (payload ?? {}) as Partial<SpeechKeys>;
    if (typeof k.api === "string") keysSnapshot = { api: k.api };
    keysLoaded = true;
    keysError = null;
    notify();
  });

  // Warm the keychain so cloud transcription works even if the settings
  // window is never opened.
  void refreshKey();
}

export function subscribeSttSettings(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Stable snapshot reference (useSyncExternalStore-friendly). */
export function getSttSettings(): SttSettings {
  return sttSnapshot;
}

export function saveSttSettings(s: SttSettings): void {
  sttSnapshot = normalizeStt(s);
  try {
    localStorage.setItem(STT_STORE_KEY, JSON.stringify(sttSnapshot));
  } catch {
    /* ignore */
  }
  ctxRef?.events.emit("stt-settings-changed", sttSnapshot);
  notify();
}

// ─── Cloud key access (keychain-backed) ───

export function getSttKey(): string {
  return keysSnapshot.api;
}

export function isSttKeyLoaded(): boolean {
  return keysLoaded;
}

export function getSttKeyError(): string | null {
  return keysError;
}

/** Persist the key. Empty value removes it (SDK secrets.set deletes empty
 *  values). Delivers in-band immediately so the other window updates live. */
export async function setSttKey(value: string): Promise<void> {
  const ctx = ctxRef;
  keysSnapshot = { api: value };
  keysError = null;
  notify();
  ctx?.events.emit("stt-keys-changed", { api: value });
  if (!ctx) return;
  try {
    await ctx.secrets.set(STT_KEY_NAME, value);
  } catch (e) {
    keysError = `Keychain write failed — the key still works this session but won't survive a restart: ${
      e instanceof Error ? e.message : String(e)
    }`;
    notify();
  }
}
