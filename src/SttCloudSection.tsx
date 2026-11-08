// Connection tab section for the stt plugin — carved from the pre-split
// voice plugin's SpeechSettingsSection (Cloud STT card only; the tts plugin
// owns the Cloud TTS card on the same tab). Edits persist through this
// plugin's settings store (localStorage "companion:stt" → cloud endpoint)
// and the key goes to the plugin-namespaced keychain account (stt:api-key),
// delivered in-band to the other window.

import { type ChangeEvent } from "react";
import { useSyncExternalStore } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import {
  getSttKey,
  getSttKeyError,
  getSttSettings,
  isSttKeyLoaded,
  saveSttSettings,
  setSttKey,
  subscribeSttSettings,
  type SpeechEndpoint,
  type SttSettings,
} from "./stt-settings";

type Preset = {
  id: string;
  label: string;
  url: string;
  model: string;
  keyPlaceholder?: string;
  note: string;
};

const STT_PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com",
    model: "whisper-1",
    note: "OpenAI's speech API serves Whisper for transcription.",
  },
  {
    id: "groq",
    label: "Groq",
    url: "https://api.groq.com",
    model: "whisper-large-v3-turbo",
    keyPlaceholder: "gsk_...",
    note: "Groq serves Whisper transcription with its own API key, independent of other speech endpoints.",
  },
];

type DirectionProps = {
  ui: Record<string, any>;
  endpoint: SpeechEndpoint;
  keyValue: string;
  loaded: boolean;
  onEndpoint: (next: SpeechEndpoint) => void;
  onKey: (value: string) => void;
};

function CloudSttDirectionSection({
  ui,
  endpoint,
  keyValue,
  loaded,
  onEndpoint,
  onKey,
}: DirectionProps) {
  const { FormField, SectionCard, TextInput, Button } = ui;
  const activePreset =
    STT_PRESETS.find((p) => endpoint.url === p.url && endpoint.model === p.model)?.id ?? "custom";
  const active = STT_PRESETS.find((p) => p.id === activePreset);

  return (
    <SectionCard title="Cloud STT" badge={keyValue ? "key secured" : "no key"}>
      <FormField
        label="Endpoint preset"
        hint="Used when the Speech Recognition tab's engine is switched to Cloud."
      >
        <div className="preset-bar">
          {[...STT_PRESETS.map((p) => ({ id: p.id, label: p.label })), { id: "custom", label: "Custom" }].map((p) => (
            <button
              key={p.id}
              type="button"
              className={`preset-btn ${activePreset === p.id ? "preset-btn-active" : ""}`}
              onClick={() => {
                if (p.id === "custom") return;
                const preset = STT_PRESETS.find((x) => x.id === p.id);
                if (preset) onEndpoint({ ...endpoint, url: preset.url, model: preset.model });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </FormField>

      {active && (
        <div className="st-field-hint" style={{ marginBottom: 14 }}>
          {active.note}
        </div>
      )}

      <FormField
        label="Endpoint URL"
        hint="OpenAI-compatible base; /v1/audio/transcriptions is appended automatically"
      >
        <TextInput
          value={endpoint.url}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onEndpoint({ ...endpoint, url: e.target.value })}
          placeholder="https://api.openai.com"
        />
      </FormField>

      <FormField
        label={`API Key ${keyValue ? "✓ Secured" : "Not set"}`}
        hint="Isolated in your OS keychain — never logged, never committed"
      >
        <div style={{ display: "flex", gap: 6 }}>
          <TextInput
            type="password"
            value={loaded ? keyValue : ""}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onKey(e.target.value)}
            placeholder={active?.keyPlaceholder ?? "sk-..."}
            disabled={!loaded}
          />
          <Button
            variant="ghost"
            onClick={() => onKey("")}
            disabled={!loaded || !keyValue}
          >
            Clear
          </Button>
        </div>
      </FormField>

      <FormField label="Model" hint="Model id for /v1/audio/transcriptions">
        <TextInput
          value={endpoint.model}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onEndpoint({ ...endpoint, model: e.target.value })}
          placeholder="whisper-1"
        />
      </FormField>
    </SectionCard>
  );
}

export function SttCloudSection({ ctx }: { ctx: PluginContext }) {
  // The store warms the keychain at activation; keys land here when the
  // async read completes.
  useSyncExternalStore(subscribeSttSettings, getSttSettings);
  const settings = getSttSettings();
  const key = getSttKey();
  const loaded = isSttKeyLoaded();
  const chainError = getSttKeyError();

  const { FormField, SectionCard, TextInput, Button } = ctx.ui as Record<string, any>;

  return (
    <>
      <CloudSttDirectionSection
        ui={ctx.ui}
        endpoint={settings.cloud}
        keyValue={key}
        loaded={loaded}
        onEndpoint={(cloud) => saveSttSettings({ ...settings, cloud })}
        onKey={(v) => void setSttKey(v)}
      />
      {chainError && <div className="error-banner">{chainError}</div>}
    </>
  );
}
