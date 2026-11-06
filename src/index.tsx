// Speech Recognition feature plugin frontend (the `stt` plugin — carved from
// the pre-split voice plugin): the Speech Recognition + Connection settings
// sections and the SttProvider (local Moonshine + cloud). The mic lifecycle
// reaction and preview playback that spanned both halves live in the tts
// plugin; chat drives this plugin's engine through ctx.services.
//
// Runs in BOTH windows — each gets its own provider instance kept in sync
// via localStorage + plugin events.

import { definePlugin, type PluginContext } from "../../sdk/js/@companion/plugin";
import { initSttSettings } from "./stt-settings";
import { createSttProvider } from "./stt-provider";
import { SttSettingsSection } from "./SttSettingsSection";
import { SttCloudSection } from "./SttCloudSection";

export default definePlugin((ctx: PluginContext) => {
  ctx.log.info("activating stt plugin");

  // Settings store first: provider + sections read it (localStorage
  // "companion:stt", keychain via ctx.secrets → stt:api-key).
  initSttSettings(ctx);

  // Settings: the Speech Recognition tab is here; the shared Connection tab
  // is registered by this plugin AND the tts plugin with the same id — the
  // host's registry takes whichever registers first and both cloud cards
  // render (sections are keyed by section id, not tab owner).
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
  ctx.settings.registerTab({
    id: "connection",
    label: "Connection",
    group: "Companion",
    order: 15,
    desc: "Speech endpoints and API keys.",
    icon: ({ className }: { className?: string }) => (
      <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0" /><path d="M1.42 9a16 16 0 0 1 21.16 0" /><path d="M8.53 16.11a6 6 0 0 1 6.95 0" /><line x1="12" y1="20" x2="12.01" y2="20" /></svg>
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

  // Capability provider (both windows register — each window's services
  // registry needs the engine available there; consumers null-check).
  ctx.services.registerStt(createSttProvider(ctx));
  ctx.log.info("stt provider registered");
});
