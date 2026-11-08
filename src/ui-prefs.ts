// Port of the host's app/src/ui-prefs.ts (localStorage "companion:ui") — the
// plugin bundle cannot import host src. Shared by VoiceInputSection (reads/
// writes the blob in the settings window) and MicShortcutController (owns the
// OS global-shortcut registration from the ui-prefs micShortcut in the main
// window; the host App no longer applies it — hotkey.rs moved into this
// plugin).

export const UI_PREFS_KEY = "companion:ui";
export const UI_PREFS_EVENT = "ui-prefs-changed";

// Controller → settings-window feedback: the result of each global-shortcut
// registration attempt (the Voice Input section shows the error banner; the
// section window cannot register itself — there is exactly one registrator).
export const MIC_SHORTCUT_STATUS_EVENT = "mic-shortcut-status";

export type MicShortcutStatus = { shortcut: string; error?: string };

type UiPrefsShape = {
  hideChat?: boolean;
  micShortcut?: string;
  bargeIn?: boolean;
};

// Defaults mirrored from the host so a fresh blob still carries the shortcut
// the controller registers on mount.
const DEFAULTS: Required<UiPrefsShape> = {
  hideChat: false,
  micShortcut: "Ctrl+Shift+M",
  bargeIn: true,
};

export function loadUiPrefs(): Required<UiPrefsShape> {
  try {
    const raw = localStorage.getItem(UI_PREFS_KEY);
    const stored = raw ? (JSON.parse(raw) as UiPrefsShape) : {};
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function normalizeShortcut(s: string): string {
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

export function shortcutFromEvent(e: KeyboardEvent): string | null {
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
