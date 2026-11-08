// Speech Recognition tab section — carved from the pre-split voice plugin's
// TtsSettingsSection (the engine switch + wake word cards; the synthesis/test
// cards moved to the tts plugin's Speech Synthesis section).
// - State comes from this plugin's STT settings store (localStorage
//   "companion:stt").
// - The "Unload mic model when idle" field moved here from the vrm plugin's
//   Graphics section: it configures this plugin's engine memory, and
//   reads/writes the shared perf state through the SDK's useSettingsState
//   bridge (persistence lives in the vrm plugin backend).
// - UI kit components come from ctx.ui (the host's shared kit).

import { useSyncExternalStore, type ChangeEvent } from "react";
import type { PluginContext } from "../../../sdk/js/@companion/plugin";
import { useSettingsState } from "../../../sdk/js/@companion/plugin";
import {
  getSttSettings,
  saveSttSettings,
  subscribeSttSettings,
  type SttSettings,
} from "./stt-settings";

type PerfConfig = {
  unload_stt_when_idle: boolean;
};

function Presets<T extends string>({
  options,
  active,
  onPick,
  format,
}: {
  options: readonly T[];
  active: T;
  onPick: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div className="preset-bar">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          onClick={() => onPick(o)}
          className={`preset-btn ${o === active ? "preset-btn-active" : ""}`}
        >
          {format ? format(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

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
  const { perf, setPerf } = useSettingsState();
  const onPerfChange = (next: PerfConfig) => setPerf(next);

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

        <FormField
          label="Unload mic model when idle"
          hint="Drop the speech model from RAM after the mic stops. Next mic tap reloads it (a few seconds)."
        >
          <Presets
            options={["on", "off"] as const}
            active={perf.unload_stt_when_idle ? "on" : "off"}
            onPick={(v) => onPerfChange({ ...perf, unload_stt_when_idle: v === "on" })}
            format={(v) => (v === "on" ? "On" : "Off")}
          />
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
