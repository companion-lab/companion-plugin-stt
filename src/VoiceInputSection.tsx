// General tab, Voice Input section — moved out of the host's InterfaceSection
// (microphone shortcut) and the chat plugin's Chat Box section (voice
// interrupt): both configure voice INPUT, so they belong to the STT plugin.
// Registered under the stable id "general.voiceInput"; when the stt plugin is
// disabled the section disappears with the rest of its contributions.
//
// Both prefs stay in the host's localStorage "companion:ui" blob and saves
// emit the host-global "ui-prefs-changed" event, exactly like the host
// section did:
// - micShortcut: this plugin's MicShortcutController (main window) owns the
//   OS registration and re-registers from every ui-prefs-changed payload;
//   its registration result comes back on "mic-shortcut-status" for the
//   error banner (this section window cannot register — there is exactly
//   one registrator).
// - bargeIn: the chat plugin's ChatPanel applies it live from the event.
// The blob is read-merged (never overwritten) so the other owners' keys
// survive (hideChat — chat plugin), and the event payload carries the full
// blob because the controller re-registers from every event.

import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { tauriEmit, tauriListen } from "./tauri";
import {
  loadUiPrefs,
  MIC_SHORTCUT_STATUS_EVENT,
  normalizeShortcut,
  shortcutFromEvent,
  UI_PREFS_EVENT,
  type MicShortcutStatus,
} from "./ui-prefs";

export function VoiceInputSection({ ctx }: { ctx: PluginContext }) {
  const [prefs, setPrefs] = useState<Required<ReturnType<typeof loadUiPrefs>>>(loadUiPrefs);
  const [recording, setRecording] = useState(false);
  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const { FormField, SectionCard, TextInput, Button } = ctx.ui as Record<string, any>;

  const apply = (patch: Partial<ReturnType<typeof loadUiPrefs>>) => {
    // Read-merge-write: the blob is shared with the host and other plugins.
    const next = { ...loadUiPrefs(), ...patch };
    setPrefs(next);
    try {
      localStorage.setItem("companion:ui", JSON.stringify(next));
    } catch {
      /* ignore */
    }
    void tauriEmit(UI_PREFS_EVENT, next).catch(() => {});
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
  // and the controller re-registers the shortcut from the same event; the
  // section only reflects the new state). Registration results (success
  // clears the banner, failure shows it) arrive on the status event.
  useEffect(() => {
    let off: (() => void) | null = null;
    let offStatus: (() => void) | null = null;
    tauriListen<Record<string, unknown>>(UI_PREFS_EVENT, (p) => {
      setPrefs({ ...loadUiPrefs(), ...p });
    })
      .then((f) => {
        off = f;
      })
      .catch(() => {});
    tauriListen<MicShortcutStatus>(MIC_SHORTCUT_STATUS_EVENT, (s) => {
      if (!s) return;
      // Success (no error field) clears the banner; failure shows it.
      setShortcutError(typeof s.error === "string" ? s.error : null);
    })
      .then((f) => {
        offStatus = f;
      })
      .catch(() => {});
    return () => {
      off?.();
      offStatus?.();
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
