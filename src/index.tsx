// Speech Recognition feature plugin frontend (the `stt` plugin — carved from
// the pre-split voice plugin): the Speech Recognition settings tab, its
// cloud STT endpoint card on the Connection tab (the tab itself is owned by
// the chat plugin), the General tab's Voice Input section (microphone
// shortcut + voice interrupt, moved from the host InterfaceSection), the
// SttProvider (local Moonshine + cloud), and the main-window
// MicShortcutController that owns the host mic shortcut when the chat panel
// is absent. The mic lifecycle reaction and preview playback that spanned
// both halves live in the tts plugin; chat drives this plugin's engine
// through ctx.services.
//
// Runs in BOTH windows — each gets its own provider instance kept in sync
// via localStorage + plugin events.

import { definePlugin, type PluginContext } from "@companion-lab/plugin";
import { initSttSettings } from "./stt-settings";
import { createSttProvider } from "./stt-provider";
import { SttSettingsSection } from "./SttSettingsSection";
import { SttCloudSection } from "./SttCloudSection";
import { VoiceInputSection } from "./VoiceInputSection";
import { MicShortcutController } from "./MicShortcutController";

export default definePlugin((ctx: PluginContext) => {
  ctx.log.info("activating stt plugin");

  // Settings store first: provider + sections read it (localStorage
  // "companion:stt", keychain via ctx.secrets → stt:api-key).
  initSttSettings(ctx);

  // Settings: the Speech Recognition tab is here; the Connection tab is
  // registered by the chat plugin (the AI backend is its primary card) and
  // this plugin's cloud STT card renders on it (sections are keyed by
  // tabId, not tab owner).
  ctx.settings.registerTab({
    id: "stt",
    label: "Speech Recognition",
    group: "Companion",
    order: 12,
    desc: "Speech recognition engine, wake word, and mic behavior.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
    ),
  });
  ctx.settings.registerSection({
    id: "stt.settings",
    tabId: "stt",
    slot: "top",
    order: 100,
    component: function SttSharedSection() {
      return <SttSettingsSection ctx={ctx} />;
    },
  });
  ctx.settings.registerSection({
    id: "stt.cloud",
    tabId: "connection",
    slot: "top",
    order: 100,
    component: function SttCloudSectionEntry() {
      return <SttCloudSection ctx={ctx} />;
    },
  });
  // General tab: voice input prefs (mic shortcut + barge-in), order 105 to
  // sit deterministically below the chat plugin's General cards (order 100).
  ctx.settings.registerSection({
    id: "general.voiceInput",
    tabId: "general",
    slot: "top",
    order: 105,
    component: function VoiceInputViaCtx() {
      return <VoiceInputSection ctx={ctx} />;
    },
  });

  // Capability provider (both windows register — each window's services
  // registry needs the engine available there; consumers null-check).
  ctx.services.registerStt(createSttProvider(ctx));
  ctx.log.info("stt provider registered");

  // Main window: owner of the mic global shortcut (this plugin registers it
  // with the OS via the global-shortcut JS API and emits "mic-toggle" per
  // press). The chat panel handles it while mounted; this headless controller
  // covers the chat-plugin-disabled case with a standalone capture session
  // (see MicShortcutController).
  ctx.main.registerWidget({
    slot: "main.overlay",
    order: 50,
    component: function MicShortcutControllerViaCtx() {
      return <MicShortcutController ctx={ctx} />;
    },
  });
});
