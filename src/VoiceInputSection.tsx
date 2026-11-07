// General tab, Voice Input section — moved out of the host's InterfaceSection
// (microphone shortcut) and the chat plugin's Chat Box section (voice
// interrupt): both configure voice INPUT, so they belong to the STT plugin.
// Registered under the stable id "general.voiceInput"; when the stt plugin is
// disabled the section disappears with the rest of its contributions.
//
// Both prefs stay in the host's localStorage "companion:ui" blob and saves
// emit the host-global "ui-prefs-changed" event, exactly like the host
// section did:
// - micShortcut: the main-window App applies it via the Rust
//   set_mic_shortcut command on startup and on every ui-prefs-changed
//   payload; apply() below also invokes the command directly for immediate
//   feedback and the error banner (the Rust side normalizes and no-ops when
//   unchanged, so the double application is harmless).
// - bargeIn: the chat plugin's ChatPanel applies it live from the event.
// The blob is read-merged (never overwritten) so the other owners' keys
// survive (hideChat — chat plugin), and the event payload carries the full
// blob because the host App re-applies the shortcut from every event.

import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { tauriEmit, tauriInvoke, tauriListen } from "./tauri";

// Host ui-prefs store (app/src/ui-prefs.ts, localStorage "companion:ui").
// Defaults mirrored here so a fresh blob still carries the micShortcut the
// host App re-applies from every ui-prefs-changed payload.
const UI_PREFS_KEY = "companion:ui";
const UI_PREFS_EVENT = "ui-prefs-changed";

type UiPrefsShape = {
  hideChat?: boolean;
  micShortcut?: string;
  bargeIn?: boolean;
};

const DEFAULTS: Required<UiPrefsShape> = {
  hideChat: false,
  micShortcut: "Ctrl+Shift+M",
  bargeIn: true,
};

function loadUiPrefs(): Required<UiPrefsShape> {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const stored = raw ? (JSON.parse(raw) as UiPrefsShape) : {};
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

// Ports of the host's app/src/ui-prefs.ts shortcut helpers (the plugin
// bundle cannot import host src).

function normalizeShortcut(s: string): string {
  const parts = s.split("+").map((p) => p.trim()).filter(Boolean);
  const mods: string[] = [];
  let key = "";
  for (const p of parts) {
    const l = p.toLowerCase();
    if (["ctrl", "control"].includes(l)) mods.push("Ctrl");
    else if (l === "shift") mods.push("Shift");
    else if (l === "alt") mods.push("Alt");
    else if (["meta", "cmd", "command", "super"].includes(l)) mods.push("Meta");
    else key = p.length === 1 ? p.toUpperCase() : p;
  }
  const order = ["Ctrl", "Shift", "Alt", "Meta"];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return key ? [...mods, key].join("+") : mods.join("+");
}

function shortcutFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Meta");
  const k = e.key;
  if (["Control", "Shift", "Alt", "Meta"].includes(k)) return null;
  const key = k.length === 1 ? k.toUpperCase() : k;
  if (!mods.length) return null;
  return [...mods, key].join("+");
}

export function VoiceInputSection({ ctx }: { ctx: PluginContext }) {
  const [prefs, setPrefs] = useState<Required<UiPrefsShape>>(loadUiPrefs);
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const { FormField, SectionCard, TextInput, Button } = ctx.ui as Record<string, any>;

  const apply = (patch: Partial<UiPrefsShape>) => {
    // Read-merge-write: the blob is shared with the host and other plugins.
    const next = { ...loadUiPrefs(), ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(UI_PREFS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    void tauriEmit(UI_PREFS_EVENT, next).catch(() => {});
    if (patch.micShortcut !== undefined) {
      void tauriInvoke<string>("set_mic_shortcut", { shortcut: next.micShortcut })
        .then(() => setShortcutError(null))
        .catch((e) =>
          setShortcutError(e instanceof Error ? e.message : String(e)),
        );
    }
  };

  const onRecorderKeyDown = (e: ReactKeyboardEvent) => {
    e.preventDefault();
    const combo = shortcutFromEvent(e.nativeEvent);
    if (!combo) return;
    setRecording(false);
    setShortcutError(null);
    apply({ micShortcut: normalizeShortcut(combo) });
  };

  // Live sync when the other window saves (the chat panel applies barge-in
  // and the host App re-applies the shortcut from the same event; the section
  // only reflects the new state).
  useEffect(() => {
    let off: (() => void) | null = null;
    tauriListen<UiPrefsShape>(UI_PREFS_EVENT, (p) => {
      setPrefs({ ...loadUiPrefs(), ...p });
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    return () => {
      off?.();
    };
  }, []);

  return (
    <SectionCard title="Voice Input">
      <FormField
        label="Microphone shortcut"
        hint="Global hotkey that toggles the mic even when the app is unfocused."
      >
        <div style={{ display: "flex", gap: 6 }}>
          <TextInput
            value={recording ? "Press keys…" : prefs.micShortcut}
            readOnly
            onKeyDown={onRecorderKeyDown}
            onFocus={() => setRecording(true)}
            onBlur={() => setRecording(false)}
            placeholder="e.g. Ctrl+Shift+M"
            style={{ flex: 1, fontSize: 12 }}
          />
          <Button
            variant="secondary"
            onClick={() => apply({ micShortcut: "Ctrl+Shift+M" })}
            style={{ padding: "5px 10px", fontSize: 11, flexShrink: 0 }}
          >
            Reset
          </Button>
        </div>
      </FormField>

      <FormField
        label="Voice interrupt"
        hint="Talk while the avatar speaks to cut it off. Your words become the next message."
      >
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant={prefs.bargeIn !== false ? "primary" : "secondary"} onClick={() => apply({ bargeIn: true })}>
            On
          </Button>
          <Button variant={prefs.bargeIn === false ? "primary" : "secondary"} onClick={() => apply({ bargeIn: false })}>
            Off
          </Button>
        </div>
      </FormField>

      {shortcutError && <div className="error-banner">{shortcutError}</div>}
    </SectionCard>
  );
}
