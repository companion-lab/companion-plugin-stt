import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MIC_SHORTCUT_STATUS_EVENT,
  UI_PREFS_EVENT,
  UI_PREFS_KEY,
  loadUiPrefs,
  normalizeShortcut,
  shortcutFromEvent,
} from "./ui-prefs";

// The module talks to the real localStorage global; node has none, so every
// test gets a fresh Map-backed fake via stubGlobal (restored in afterEach so
// nothing leaks between tests).
function makeLocalStorageFake() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string): string | null => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string): void => void store.set(key, String(value)),
    removeItem: (key: string): void => void store.delete(key),
    clear: (): void => void store.clear(),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", makeLocalStorageFake());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Node has no KeyboardEvent constructor; the controller only reads the
// modifier flags plus `key`, so a plain object cast is enough.
type KeyEventInit = {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};
const keyEvent = (init: KeyEventInit): KeyboardEvent => ({ ...init }) as unknown as KeyboardEvent;

describe("constants", () => {
  it("uses the shared host blob key and event names", () => {
    expect(UI_PREFS_KEY).toBe("companion:ui");
    expect(UI_PREFS_EVENT).toBe("ui-prefs-changed");
    expect(MIC_SHORTCUT_STATUS_EVENT).toBe("mic-shortcut-status");
  });
});

describe("loadUiPrefs", () => {
  it("returns the mirrored host defaults on an empty blob", () => {
    expect(loadUiPrefs()).toEqual({ hideChat: false, micShortcut: "Ctrl+Shift+M", bargeIn: true });
  });

  it("reads the 'companion:ui' key specifically", () => {
    localStorage.setItem("some:other:key", JSON.stringify({ hideChat: true }));
    expect(loadUiPrefs().hideChat).toBe(false);
  });

  it("merges stored fields over defaults", () => {
    localStorage.setItem(
      UI_PREFS_KEY,
      JSON.stringify({ hideChat: true, micShortcut: "Alt+P" }),
    );
    expect(loadUiPrefs()).toEqual({ hideChat: true, micShortcut: "Alt+P", bargeIn: true });
  });

  it("falls back to defaults on malformed JSON", () => {
    localStorage.setItem(UI_PREFS_KEY, "{not json");
    expect(loadUiPrefs()).toEqual({ hideChat: false, micShortcut: "Ctrl+Shift+M", bargeIn: true });
  });
});

describe("normalizeShortcut", () => {
  it("canonicalizes casing and whitespace", () => {
    expect(normalizeShortcut("ctrl+shift+m")).toBe("Ctrl+Shift+M");
    expect(normalizeShortcut("  ctrl  +  shift  +  m  ")).toBe("Ctrl+Shift+M");
  });

  it("reorders modifiers into the Ctrl, Shift, Alt, Meta order", () => {
    expect(normalizeShortcut("shift+ctrl+alt+meta+m")).toBe("Ctrl+Shift+Alt+Meta+M");
    expect(normalizeShortcut("meta + ctrl")).toBe("Ctrl+Meta");
  });

  it("maps modifier aliases (control/cmd/command/super)", () => {
    expect(normalizeShortcut("control+cmd+f")).toBe("Ctrl+Meta+F");
    expect(normalizeShortcut("super+M")).toBe("Meta+M");
  });

  it("uppercases single-character keys but leaves multi-char keys alone", () => {
    expect(normalizeShortcut("m")).toBe("M");
    expect(normalizeShortcut("f5")).toBe("f5");
  });

  it("returns bare modifiers without a trailing separator when no key is present", () => {
    expect(normalizeShortcut("ctrl+alt")).toBe("Ctrl+Alt");
  });

  it("collapses an empty string to the empty shortcut", () => {
    expect(normalizeShortcut("")).toBe("");
    expect(normalizeShortcut("+")).toBe("");
  });
});

describe("shortcutFromEvent", () => {
  it("returns null when no modifier is held", () => {
    expect(shortcutFromEvent(keyEvent({ key: "m" }))).toBeNull();
  });

  it("returns null for the modifier keys themselves", () => {
    expect(shortcutFromEvent(keyEvent({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(shortcutFromEvent(keyEvent({ key: "Shift", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shortcutFromEvent(keyEvent({ key: "Alt", altKey: true }))).toBeNull();
    expect(shortcutFromEvent(keyEvent({ key: "Meta", metaKey: true }))).toBeNull();
  });

  it("builds the Ctrl+Shift+M default and uppercases single chars", () => {
    expect(shortcutFromEvent(keyEvent({ key: "m", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+M",
    );
  });

  it("keeps multi-char key names unchanged and orders modifiers", () => {
    expect(shortcutFromEvent(keyEvent({ key: "F5", ctrlKey: true }))).toBe("Ctrl+F5");
    expect(shortcutFromEvent(keyEvent({ key: "ArrowUp", altKey: true, metaKey: true }))).toBe(
      "Alt+Meta+ArrowUp",
    );
  });
});
