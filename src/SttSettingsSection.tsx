// Speech Recognition tab section — carved from the pre-split voice plugin's
// TtsSettingsSection (the engine switch + wake word cards; the synthesis/test
// cards moved to the tts plugin's Speech Synthesis section).
// - State comes from this plugin's STT settings store (localStorage
//   "companion:stt").
// - UI kit components come from ctx.ui (the host's shared kit).

import { useSyncExternalStore, type ChangeEvent } from "react";
import type { PluginContext } from "@companion-lab/plugin";
import {
  getSttSettings,
  saveSttSettings,
  subscribeSttSettings,
  type SttSettings,
} from "./stt-settings";

function EngineSwitch({ value, onPick }: {
  value: "local" | "cloud";
  onPick: (v: "local" | "cloud") => void;
}) {
  return (
    <div className="preset-bar">
      {(["local", "cloud"] as const).map((p) => (
        <button
          key={p}
          type="button"
          className={`preset-btn ${value === p ? "preset-btn-active" : ""}`}
          onClick={() => onPick(p)}
        >
          {p === "local" ? "Local" : "Cloud"}
        </button>
      ))}
    </div>
  );
}

export function SttSettingsSection({ ctx }: { ctx: PluginContext }) {
  const stt = useSyncExternalStore(subscribeSttSettings, getSttSettings);
  const sttProvider = stt.sttProvider ?? "local";

  const onChange = (next: SttSettings) => saveSttSettings(next);

  const { FormField, SectionCard, TextInput, Button } =
    ctx.ui as Record<string, any>;

  return (
    <>
      <SectionCard
        title="Speech Recognition"
        badge={sttProvider === "cloud" ? "cloud" : "local"}
      >
        <FormField
          label="Engine"
          hint={sttProvider === "cloud"
            ? "Cloud transcribes via the STT model in the Connection tab. Wake word behavior is unchanged."
            : "Local Moonshine runs fully on-device — no audio leaves your machine."}
        >
          <EngineSwitch value={sttProvider} onPick={(p: "local" | "cloud") => onChange({ ...stt, sttProvider: p })} />
        </FormField>
      </SectionCard>

      <SectionCard
        title="Wake Word"
        badge={stt.wakeWord?.trim() ? "gated" : "manual"}
      >
        <FormField
          label="Wake phrase"
          hint="Empty = manual mic button. Set = mic listens in background and only sends after hearing this phrase."
        >
          <div style={{ display: "flex", gap: 6 }}>
            <TextInput
              value={stt.wakeWord ?? ""}
              onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ ...stt, wakeWord: e.target.value })}
              placeholder="e.g. hey hime"
            />
            {stt.wakeWord?.trim() && (
              <Button variant="ghost" onClick={() => onChange({ ...stt, wakeWord: "" })}>
                Clear
              </Button>
            )}
          </div>
        </FormField>
      </SectionCard>
    </>
  );
}
