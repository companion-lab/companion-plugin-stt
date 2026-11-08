// Minimal vendored Tauri bridge. The plugin bundle cannot resolve
// @tauri-apps/api (features/ has no node_modules chain to the app's), so the
// three primitives we need are read straight off window.__TAURI_INTERNALS__,
// mirroring @tauri-apps/api v2 core.js/event.js:
// - invoke  → internals.invoke(cmd, args)
// - listen  → invoke("plugin:event|listen", { event, target, handler })
// - emit    → invoke("plugin:event|emit", { event, payload })
//
// Used ONLY for host-global surfaces the plugin context cannot reach: the
// legacy global keychain accounts (one-time migration), the chat panel's
// global "mic-active-changed" event, the shared ui-prefs blob (localStorage
// "companion:ui" + the host-global "ui-prefs-changed" event), and the OS
// global-shortcut registration for the mic toggle (plugin:global-shortcut|*
// commands — capabilities already grant register/unregister/is-registered).
// Everything else goes through ctx.*

interface TauriInternals {
  invoke: (cmd: string, args?: Record<string, unknown>, options?: unknown) => Promise<unknown>;
  transformCallback: (callback?: (response: unknown) => void, once?: boolean) => number;
  metadata?: { currentWindow?: { label?: string }; currentWebview?: { label?: string } };
}

function internals(): TauriInternals | undefined {
  return typeof window !== "undefined"
    ? (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
    : undefined;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Label of the webview this bundle runs in ("main" | "settings"), when known. */
export function currentWindowLabel(): string {
  return internals()?.metadata?.currentWindow?.label ?? "";
}

/** Raw Tauri command invocation (escape hatch — prefer ctx.backend.call). */
export function tauriInvoke<T = unknown>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const t = internals();
  if (!t || typeof t.invoke !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  return t.invoke(cmd, args) as Promise<T>;
}

/** Listen to a host-global (non-plugin-namespaced) Tauri event. */
export function tauriListen<T = unknown>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  const t = internals();
  if (!t || typeof t.invoke !== "function" || typeof t.transformCallback !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  const handlerId = t.transformCallback((e: unknown) => {
    handler((e as { payload?: T })?.payload as T);
  });
    return t
      .invoke("plugin:event|listen", { event, target: { kind: "Any" }, handler: handlerId })
      .then((eventId) => {
        return () => {
          void t
            .invoke("plugin:event|unlisten", { event, eventId })
            .catch(() => {});
        };
      });
}

/** Emit a host-global (non-plugin-namespaced) Tauri event. */
export function tauriEmit(event: string, payload?: unknown): Promise<void> {
  const t = internals();
  if (!t || typeof t.invoke !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  return t
    .invoke("plugin:event|emit", { event, payload: payload ?? null })
    .then(() => undefined);
}

/** Shape of a global-shortcut press event (Rust `ShortcutJsEvent`). */
export type ShortcutEvent = { shortcut: string; id: number; state: string };

/**
 * Register an OS-global shortcut and deliver press events to `onEvent`.
 * Mirrors @tauri-apps/plugin-global-shortcut's JS guest: the handler rides an
 * IPC channel, which serializes as the string `__CHANNEL__:<callbackId>` where
 * the callback receives `{ index, message }` envelopes (order-preserving in
 * @tauri-apps/api; presses carry no ordering concern, so `index` is ignored).
 */
export function globalShortcutRegister(
  shortcut: string,
  onEvent: (event: ShortcutEvent) => void,
): Promise<void> {
  const t = internals();
  if (!t || typeof t.invoke !== "function" || typeof t.transformCallback !== "function") {
    return Promise.reject(new Error("Tauri IPC unavailable (not running inside companion)"));
  }
  const callbackId = t.transformCallback((raw: unknown) => {
    const message = (raw as { message?: ShortcutEvent } | null)?.message;
    if (message) onEvent(message);
  });
  return t
    .invoke("plugin:global-shortcut|register", {
      shortcuts: [shortcut],
      handler: `__CHANNEL__:${callbackId}`,
    })
    .then(() => undefined);
}

/** Unregister a previously registered OS-global shortcut. */
export function globalShortcutUnregister(shortcut: string): Promise<void> {
  return tauriInvoke<void>("plugin:global-shortcut|unregister", { shortcuts: [shortcut] });
}
