// Main-window controller: standalone owner of the mic global shortcut when the
// chat panel is not mounted. Renders nothing — it registers on "main.overlay"
// purely to get a main-window-only mount point with teardown cleanup (the
// chat panel is the visual surface for mic state).
//
// This plugin owns the OS shortcut end-to-end (the host's hotkey.rs moved
// here): the controller registers the ui-prefs micShortcut through the
// global-shortcut JS API, re-registers on "ui-prefs-changed", unregisters on
// teardown, and reports each registration attempt on "mic-shortcut-status"
// (the settings window's Voice Input section shows the error banner — there
// is exactly one registrator, so the settings window cannot register too).
//
// Two deliveries of one keypress can land close together (the global shortcut
// fires regardless of focus; the window keydown below is the fallback for
// when the global registration failed). Both go through one press() whose
// dedupe (300ms — no human toggles twice that fast) collapses them into ONE
// "mic-toggle" emission, which is what the chat panel listens for. On each
// press:
//
// - The chat panel's presence flag from localStorage
//   ("companion:chat-panel-present", set/cleared by ChatPanel on mount/
//   unmount) decides ownership: if the panel is mounted — even hidden via the
//   Chat box toggle, where voice and mic keep working — the panel acts on the
//   emitted "mic-toggle" and this controller hands off. A synchronous flag
//   read means no listener/ordering races between the two plugins.
// - Otherwise it toggles a standalone capture session through this plugin's
//   own engine (manual mode; the wake-word gate only makes sense with a chat
//   to send to) and announces "mic-active-changed" like the panel does (the
//   tts plugin pauses preview playback). Transcripts go nowhere here — there
//   is no chat to send them to.
// - Makes start/stop transition-safe: a stop during an in-flight start
//   cancels it instead of leaving a live capture behind, and if the chat
//   panel shows up mid-session the session is handed over (stopped).
// - Plugin teardown unmounts this controller, and the unmount cleanup stops
//   the capture and unregisters the shortcut so the mic never stays hot and
//   no dead hotkey survives the plugin.

import { useCallback, useEffect, useRef } from "react";
import type { PluginContext, SttEngine } from "../../../sdk/js/@companion/plugin";
import { loadSttSettings } from "./stt-settings";
import {
  globalShortcutRegister,
  globalShortcutUnregister,
  tauriEmit,
  tauriListen,
  type ShortcutEvent,
} from "./tauri";
import {
  loadUiPrefs,
  MIC_SHORTCUT_STATUS_EVENT,
  normalizeShortcut,
  shortcutFromEvent,
  UI_PREFS_EVENT,
  type MicShortcutStatus,
} from "./ui-prefs";

// MUST match ChatPanel (companion-plugin-chat/src/ChatPanel.tsx).
const CHAT_PANEL_FLAG = "companion:chat-panel-present";

// Two deliveries of one keypress (global shortcut + focused-window keydown)
// land within milliseconds of each other; ignore the second.
const TOGGLE_DEDUPE_MS = 300;

function chatPanelPresent(): boolean {
  try {
    return localStorage.getItem(CHAT_PANEL_FLAG) === "1";
  } catch {
    return false;
  }
}

function announceStatus(status: MicShortcutStatus): void {
  void tauriEmit(MIC_SHORTCUT_STATUS_EVENT, status).catch(() => {});
}

export function MicShortcutController({ ctx }: { ctx: PluginContext }) {
  const engineRef = useRef<SttEngine | null>(null);
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const lastToggleRef = useRef(0);
  // Last attempted combo (keydown fallback matches against it even when the
  // global registration failed) and the combo actually registered with the OS.
  const attemptedRef = useRef<string | null>(null);
  const registeredRef = useRef<string | null>(null);

  const stopSession = useCallback(async () => {
    startingRef.current = false; // cancels an in-flight start
    const engine = engineRef.current;
    engineRef.current = null;
    if (activeRef.current) {
      activeRef.current = false;
      void tauriEmit("mic-active-changed", false).catch(() => {});
    }
    if (engine) {
      try {
        await engine.stop();
      } catch {
        /* engine already gone */
      }
    }
  }, []);

  const startSession = useCallback(async () => {
    const service = ctx.services.stt();
    if (!service) {
      // This plugin registers the provider, so this only happens before
      // activation completes — still, don't fail silently.
      ctx.log.warn("mic shortcut pressed before the stt provider was ready — ignored");
      return;
    }
    startingRef.current = true;
    // Engine kind chosen at start time (local Moonshine / cloud) so a
    // Speech-Recognition tab switch applies on the next session.
    const engine = service.createEngine(
      loadSttSettings().sttProvider === "cloud" ? "cloud" : "local",
      () => {},
      () => {},
      (err) => {
        ctx.log.warn(`mic session error: ${err}`);
        void stopSession();
      },
    );
    engineRef.current = engine;
    try {
      await engine.start();
      if (!startingRef.current) {
        // A stop was requested while starting — finish stopping for real.
        try {
          await engine.stop();
        } catch {
          /* ignore */
        }
        return;
      }
      activeRef.current = true;
      void tauriEmit("mic-active-changed", true).catch(() => {});
    } catch (e) {
      if (startingRef.current) {
        ctx.log.warn(
          `mic session start failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    } finally {
      startingRef.current = false;
      if (engineRef.current === engine && !activeRef.current) engineRef.current = null;
    }
  }, [ctx, stopSession]);

  const press = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleRef.current < TOGGLE_DEDUPE_MS) return;
    lastToggleRef.current = now;
    // One emission per physical press — the chat panel toggles on this event.
    void tauriEmit("mic-toggle").catch(() => {});
    if (chatPanelPresent()) return;
    if (activeRef.current || startingRef.current) void stopSession();
    else void startSession();
  }, [stopSession, startSession]);

  const pressRef = useRef(press);
  pressRef.current = press;

  /** Register the given combo with the OS (unregistering the previous one).
   *  No-op when the combo is unchanged. The result is announced for the
   *  settings section's error banner. */
  const applyShortcut = useCallback(async (raw: string) => {
    const shortcut = normalizeShortcut(raw);
    if (!shortcut || attemptedRef.current === shortcut) return;
    const prev = registeredRef.current;
    registeredRef.current = null;
    if (prev && prev !== shortcut) {
      void globalShortcutUnregister(prev).catch(() => {});
    }
    attemptedRef.current = shortcut;
    try {
      await globalShortcutRegister(shortcut, (e: ShortcutEvent) => {
        if (e.state === "Pressed") pressRef.current();
      });
      registeredRef.current = shortcut;
      announceStatus({ shortcut });
    } catch (e) {
      announceStatus({
        shortcut,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    void applyShortcut(loadUiPrefs().micShortcut);

    // Re-register whenever the setting changes (saved from this plugin's
    // Voice Input section in the settings window).
    let offPrefs: (() => void) | null = null;
    tauriListen<Record<string, unknown>>(UI_PREFS_EVENT, () => {
      void applyShortcut(loadUiPrefs().micShortcut);
    })
      .then((f) => {
        offPrefs = f;
      })
      .catch(() => {});

    // Fallback for when the global registration failed: while the main window
    // is focused, a matching keydown takes the same press() path (the dedupe
    // collapses the pair when both deliveries land).
    const onKey = (e: KeyboardEvent) => {
      const combo = shortcutFromEvent(e);
      if (combo && combo === attemptedRef.current) {
        e.preventDefault();
        pressRef.current();
      }
    };
    window.addEventListener("keydown", onKey);

    // If the chat panel shows up mid-session (chat plugin enabled while a
    // fallback session is running), hand the mic over: the flag is only read
    // at press time, and same-window writes fire no DOM storage event.
    const takeover = window.setInterval(() => {
      if ((activeRef.current || startingRef.current) && chatPanelPresent()) {
        void stopSession();
      }
    }, 1000);

    return () => {
      offPrefs?.();
      window.removeEventListener("keydown", onKey);
      window.clearInterval(takeover);
      // Plugin teardown: stop the capture so the mic doesn't stay hot, and
      // release the OS shortcut so no dead hotkey survives the plugin.
      const engine = engineRef.current;
      engineRef.current = null;
      startingRef.current = false;
      if (engine) void engine.stop().catch(() => {});
      if (activeRef.current) {
        activeRef.current = false;
        void tauriEmit("mic-active-changed", false).catch(() => {});
      }
      const registered = registeredRef.current;
      registeredRef.current = null;
      attemptedRef.current = null;
      if (registered) void globalShortcutUnregister(registered).catch(() => {});
    };
  }, [applyShortcut, stopSession]);

  // Headless: no UI, just the shortcut ownership above.
  return null;
}
