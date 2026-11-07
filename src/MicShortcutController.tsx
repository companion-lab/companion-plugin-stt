// Main-window controller: standalone owner of the host mic shortcut when the
// chat panel is not mounted. Renders nothing — it registers on "main.overlay"
// purely to get a main-window-only mount point with teardown cleanup (the
// chat panel is the visual surface for mic state).
//
// The Rust global shortcut and the main window's App.tsx keydown both emit
// the host-global "mic-toggle" — one physical keypress arrives TWICE whenever
// the window is focused (the global shortcut fires regardless of focus; the
// keydown is the fallback for when the global registration failed). This
// controller therefore:
//
// - Dedupes presses closer together than 300ms (one keypress, two events —
//   no human toggles twice that fast; without this, the pair reads as
//   on→on, then off→on, and the mic can never be turned off).
// - On every press it reads the chat panel's presence flag from localStorage
//   ("companion:chat-panel-present", set/cleared by ChatPanel on mount/
//   unmount). If the panel is mounted — even hidden via the Chat box toggle,
//   where voice and mic keep working — the panel owns the shortcut and this
//   controller hands off. A synchronous flag read means no listener/ordering
//   races between the two plugins.
// - Otherwise it toggles a standalone capture session through this plugin's
//   own engine (manual mode; the wake-word gate only makes sense with a chat
//   to send to) and announces "mic-active-changed" like the panel does (the
//   tts plugin pauses preview playback). Transcripts go nowhere here — there
//   is no chat to send them to.
// - Makes start/stop transition-safe: a stop during an in-flight start
//   cancels it instead of leaving a live capture behind, and if the chat
//   panel shows up mid-session the session is handed over (stopped).
// - Plugin teardown unmounts this controller, and the unmount cleanup stops
//   the capture so the mic never stays hot with the plugin gone.

import { useCallback, useEffect, useRef } from "react";
import type { PluginContext, SttEngine } from "../../../sdk/js/@companion/plugin";
import { loadSttSettings } from "./stt-settings";
import { tauriEmit, tauriListen } from "./tauri";

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

export function MicShortcutController({ ctx }: { ctx: PluginContext }) {
  const engineRef = useRef<SttEngine | null>(null);
  const activeRef = useRef(false);
  const startingRef = useRef(false);
  const lastToggleRef = useRef(0);

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

  const toggle = useCallback(() => {
    // The chat panel owns the shortcut while it is mounted (it hides with
    // the Chat box toggle but keeps handling the mic).
    if (chatPanelPresent()) return;
    const now = Date.now();
    if (now - lastToggleRef.current < TOGGLE_DEDUPE_MS) return;
    lastToggleRef.current = now;
    if (activeRef.current || startingRef.current) void stopSession();
    else void startSession();
  }, [stopSession, startSession]);

  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  useEffect(() => {
    let off: (() => void) | null = null;
    tauriListen("mic-toggle", () => toggleRef.current())
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    // If the chat panel shows up mid-session (chat plugin enabled while a
    // fallback session is running), hand the mic over: the flag is only read
    // at press time, and same-window writes fire no DOM storage event.
    const takeover = window.setInterval(() => {
      if ((activeRef.current || startingRef.current) && chatPanelPresent()) {
        void stopSession();
      }
    }, 1000);
    return () => {
      off?.();
      window.clearInterval(takeover);
      // Plugin teardown: stop the capture so the mic doesn't stay hot.
      const engine = engineRef.current;
      engineRef.current = null;
      startingRef.current = false;
      if (engine) void engine.stop().catch(() => {});
      if (activeRef.current) {
        activeRef.current = false;
        void tauriEmit("mic-active-changed", false).catch(() => {});
      }
    };
  }, [stopSession]);

  // Headless: no UI, just the shortcut ownership above.
  return null;
}
