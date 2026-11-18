import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@companion-lab/plugin";

type SttSettingsModule = typeof import("./stt-settings");
type SttSettings = import("./stt-settings").SttSettings;

// The store keeps module-level state (ctxRef, snapshots, listeners) and
// initSttSettings is idempotent by design, so every test imports a fresh
// module instance via vi.resetModules + dynamic import.
let mod: SttSettingsModule;

// Map-backed localStorage fake: node has no built-in and the store reads it
// synchronously in load/save.
function makeLocalStorageFake() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string): void => void store.set(key, String(value)),
    removeItem: (key: string): void => void store.delete(key),
    clear: (): void => void store.clear(),
  };
}

// Plain fake ctx: the store only touches events.on/emit, secrets.get/set and
// log.warn. `emit` is a recording spy only — on the real host the bus is a
// Tauri broadcast, so incoming cross-window events are simulated explicitly
// with `fire`, which invokes registered handlers directly.
function makeCtx(
  opts: {
    secret?: string | null;
    get?: () => Promise<string | null>;
    setFails?: Error;
  } = {},
) {
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const on = vi.fn((event: string, cb: (payload: unknown) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return () => {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== cb),
      );
    };
  });
  const emit = vi.fn((_event: string, _payload?: unknown) => {});
  const fire = (event: string, payload?: unknown) => {
    for (const cb of [...(handlers.get(event) ?? [])]) cb(payload);
  };
  const ctx = {
    id: "stt",
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: { on, emit },
    secrets: {
      get: vi.fn(() =>
        opts.get ? opts.get() : Promise.resolve(opts.secret !== undefined ? opts.secret : null),
      ),
      set: vi.fn(() => (opts.setFails ? Promise.reject(opts.setFails) : Promise.resolve())),
      remove: vi.fn(async () => {}),
    },
  };
  return {
    ctx: ctx as unknown as PluginContext,
    on,
    emit,
    fire,
    secrets: ctx.secrets,
    log: ctx.log,
  };
}

beforeEach(async () => {
  vi.stubGlobal("localStorage", makeLocalStorageFake());
  vi.resetModules();
  mod = await import("./stt-settings");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DEFAULT_STT_SETTINGS", () => {
  it("matches the shipped defaults", () => {
    expect(mod.DEFAULT_STT_SETTINGS).toEqual({
      sttProvider: "local",
      wakeWord: "",
      cloud: { url: "https://api.openai.com", model: "whisper-1" },
    });
  });

  it("uses the plugin-namespaced keychain account", () => {
    // SDK secrets prefix the plugin id; the store only ever sees "api-key".
    expect(mod.STT_KEY_NAME).toBe("api-key");
  });
});

describe("loadSttSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(mod.loadSttSettings()).toEqual(mod.DEFAULT_STT_SETTINGS);
  });

  it("merges a stored blob over defaults, filling a partial cloud endpoint", () => {
    localStorage.setItem(
      "companion:stt",
      JSON.stringify({ wakeWord: "hey computer", cloud: { url: "https://gw.example.com" } }),
    );
    expect(mod.loadSttSettings()).toEqual({
      sttProvider: "local",
      wakeWord: "hey computer",
      cloud: { url: "https://gw.example.com", model: "whisper-1" },
    });
  });

  it("falls back to the defaults on malformed JSON", () => {
    localStorage.setItem("companion:stt", "{oops");
    expect(mod.loadSttSettings()).toEqual(mod.DEFAULT_STT_SETTINGS);
  });
});

describe("settings store", () => {
  it("starts on defaults until initialized", () => {
    expect(mod.getSttSettings()).toEqual(mod.DEFAULT_STT_SETTINGS);
  });

  it("init adopts the stored blob as the first snapshot", () => {
    localStorage.setItem("companion:stt", JSON.stringify({ wakeWord: "stored" }));
    const { ctx } = makeCtx();
    mod.initSttSettings(ctx);
    expect(mod.getSttSettings()).toEqual({ ...mod.DEFAULT_STT_SETTINGS, wakeWord: "stored" });
  });

  it("save → get round-trips, persists to localStorage and emits the sync event", () => {
    const { ctx, emit } = makeCtx();
    mod.initSttSettings(ctx);
    const saved: SttSettings = {
      ...mod.DEFAULT_STT_SETTINGS,
      wakeWord: "hello",
      cloud: { url: "https://x.example.com", model: "m" },
    };
    mod.saveSttSettings(saved);
    expect(mod.getSttSettings()).toEqual({
      sttProvider: "local",
      wakeWord: "hello",
      cloud: { url: "https://x.example.com", model: "m" },
    });
    expect(JSON.parse(localStorage.getItem("companion:stt") as string)).toEqual(
      mod.getSttSettings(),
    );
    expect(emit).toHaveBeenCalledWith("stt-settings-changed", mod.getSttSettings());
  });

  it("normalizes partial saves back to full defaults", () => {
    const { ctx } = makeCtx();
    mod.initSttSettings(ctx);
    mod.saveSttSettings({ wakeWord: "yo" } as SttSettings);
    expect(mod.getSttSettings()).toEqual({ ...mod.DEFAULT_STT_SETTINGS, wakeWord: "yo" });
  });

  it("applies settings-changed events from the other window and notifies listeners", () => {
    const { ctx, fire } = makeCtx();
    mod.initSttSettings(ctx);
    const listener = vi.fn();
    mod.subscribeSttSettings(listener);
    fire("stt-settings-changed", {
      wakeWord: "synced",
      cloud: { url: "https://other.example.com" },
    });
    expect(mod.getSttSettings()).toEqual({
      sttProvider: "local",
      wakeWord: "synced",
      cloud: { url: "https://other.example.com", model: "whisper-1" },
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing stops notifications", () => {
    const { ctx } = makeCtx();
    mod.initSttSettings(ctx);
    const listener = vi.fn();
    const unsubscribe = mod.subscribeSttSettings(listener);
    mod.saveSttSettings({ ...mod.DEFAULT_STT_SETTINGS, wakeWord: "a" });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    mod.saveSttSettings({ ...mod.DEFAULT_STT_SETTINGS, wakeWord: "b" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("a throwing listener must not break the other listeners", () => {
    const { ctx } = makeCtx();
    mod.initSttSettings(ctx);
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    mod.subscribeSttSettings(bad);
    mod.subscribeSttSettings(good);
    mod.saveSttSettings({ ...mod.DEFAULT_STT_SETTINGS, wakeWord: "c" });
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it("ignores a second init (idempotent)", () => {
    const a = makeCtx();
    const b = makeCtx();
    mod.initSttSettings(a.ctx);
    mod.initSttSettings(b.ctx);
    expect(b.on).not.toHaveBeenCalled();
    mod.saveSttSettings({ ...mod.DEFAULT_STT_SETTINGS, wakeWord: "x" });
    expect(a.emit).toHaveBeenCalled();
    expect(b.emit).not.toHaveBeenCalled();
  });
});

describe("keychain handling", () => {
  it("warms the key from the keychain on init", async () => {
    const { ctx, secrets } = makeCtx({ secret: "sk-live-123" });
    mod.initSttSettings(ctx);
    await vi.waitFor(() => expect(mod.isSttKeyLoaded()).toBe(true));
    expect(mod.getSttKey()).toBe("sk-live-123");
    expect(mod.getSttKeyError()).toBeNull();
    expect(secrets.get).toHaveBeenCalledWith("api-key");
  });

  it("marks keys loaded with an error when the keychain read fails at init", async () => {
    const { ctx, log } = makeCtx({ get: () => Promise.reject(new Error("locked")) });
    mod.initSttSettings(ctx);
    await vi.waitFor(() => expect(mod.getSttKeyError()).not.toBeNull());
    expect(mod.isSttKeyLoaded()).toBe(true);
    expect(mod.getSttKey()).toBe("");
    expect(mod.getSttKeyError()).toBe(
      "Keychain unavailable — keys won't survive a restart: locked",
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("stt keychain load failed"));
  });

  it("an empty keychain read must not clobber a live key delivered meanwhile", async () => {
    // The warm-up read is still pending when the user saves a key in-band;
    // when the read later fails, refreshKey must leave the snapshot alone.
    let rejectGet!: (e: Error) => void;
    const { ctx } = makeCtx({
      get: () => new Promise<string | null>((_resolve, reject) => (rejectGet = reject)),
    });
    mod.initSttSettings(ctx);
    await mod.setSttKey("live-key");
    rejectGet(new Error("locked"));
    await vi.waitFor(() => expect(mod.getSttKeyError()).not.toBeNull());
    expect(mod.getSttKey()).toBe("live-key");
    expect(mod.getSttKeyError()).toContain("Keychain unavailable");
  });

  it("accepts in-band key delivery from the settings window", () => {
    const { ctx, fire } = makeCtx();
    mod.initSttSettings(ctx);
    fire("stt-keys-changed", { api: "delivered" });
    expect(mod.getSttKey()).toBe("delivered");
    expect(mod.isSttKeyLoaded()).toBe(true);
    expect(mod.getSttKeyError()).toBeNull();
  });

  it("ignores in-band payloads without a string api but still marks keys loaded", () => {
    const { ctx, fire } = makeCtx();
    mod.initSttSettings(ctx);
    fire("stt-keys-changed", { api: 42 });
    expect(mod.getSttKey()).toBe("");
    expect(mod.isSttKeyLoaded()).toBe(true);
  });

  it("setSttKey delivers in-band immediately and persists to the keychain", async () => {
    const { ctx, emit } = makeCtx();
    mod.initSttSettings(ctx);
    // Let the init warm-up settle so it cannot race the snapshot below.
    await vi.waitFor(() => expect(mod.isSttKeyLoaded()).toBe(true));
    await mod.setSttKey("sk-new");
    expect(mod.getSttKey()).toBe("sk-new");
    expect(emit).toHaveBeenCalledWith("stt-keys-changed", { api: "sk-new" });
    expect(ctx.secrets.set).toHaveBeenCalledWith("api-key", "sk-new");
    expect(mod.getSttKeyError()).toBeNull();
  });

  it("setSttKey('') writes the empty value (SDK secrets.set deletes it)", async () => {
    const { ctx } = makeCtx();
    mod.initSttSettings(ctx);
    await vi.waitFor(() => expect(mod.isSttKeyLoaded()).toBe(true));
    await mod.setSttKey("");
    expect(ctx.secrets.set).toHaveBeenCalledWith("api-key", "");
    expect(mod.getSttKey()).toBe("");
  });

  it("keeps the in-session key and records an error when the keychain write fails", async () => {
    const { ctx, emit } = makeCtx({ setFails: new Error("denied") });
    mod.initSttSettings(ctx);
    await vi.waitFor(() => expect(mod.isSttKeyLoaded()).toBe(true));
    await mod.setSttKey("sk-x");
    expect(mod.getSttKey()).toBe("sk-x");
    expect(mod.getSttKeyError()).toBe(
      "Keychain write failed — the key still works this session but won't survive a restart: denied",
    );
    // In-band delivery still happened before the write failed.
    expect(emit).toHaveBeenCalledWith("stt-keys-changed", { api: "sk-x" });
  });
});
