// Cloud speech transcription against OpenAI-compatible audio APIs — carved
// from the pre-split voice plugin's speech-cloud.ts (STT direction only; the
// tts plugin owns cloudSynthesize). The endpoint lives in this plugin's own
// settings store (`companion:stt` → `cloud`); the key lives in the
// plugin-namespaced keychain account (`stt:api-key`).

import { doFetch, throwIfHttpError } from "./fetch";
import { getSttKey, getSttSettings } from "./stt-settings";

/** "https://api.groq.com/openai/v1/" -> "https://api.groq.com" (host port). */
export function normalizeSpeechBase(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Transcribe device-rate mono f32 samples via /v1/audio/transcriptions. */
export async function cloudTranscribe(
  samples: Float32Array,
  sampleRate: number,
): Promise<string> {
  const stt = getSttSettings().cloud;
  const sttKey = getSttKey();
  const base = normalizeSpeechBase(stt.url);
  if (!stt.model) {
    throw new Error(
      "No cloud STT model set — configure the Cloud STT endpoint in Settings → Connection",
    );
  }
  const wav = encodeWavPcm16(samples, sampleRate);
  const boundary = `----companion${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const body = buildMultipart(
    boundary,
    {
      model: stt.model,
      response_format: "json",
    },
    { name: "file", filename: "audio.wav", mime: "audio/wav", bytes: wav },
  );
  const res = await doFetch(`${base}/v1/audio/transcriptions`, {
    method: "POST",
    headers: {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      ...(sttKey ? { Authorization: `Bearer ${sttKey}` } : {}),
    },
    // Runtime accepts Uint8Array bodies (native fetch + plugin-http); the
    // DOM types only list ArrayBuffer, hence the cast.
    body: body as unknown as BodyInit,
  });
  await throwIfHttpError(res);
  const json = (await res.json()) as { text?: string };
  return (json.text ?? "").trim();
}

/** Mono 16-bit PCM WAV container. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Uint8Array(buf);
}

export function buildMultipart(
  boundary: string,
  fields: Record<string, string>,
  file: { name: string; filename: string; mime: string; bytes: Uint8Array },
): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (b: Uint8Array) => {
    parts.push(b);
    size += b.length;
  };
  for (const [key, value] of Object.entries(fields)) {
    push(
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
      ),
    );
  }
  push(
    enc.encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`,
    ),
  );
  push(file.bytes);
  push(enc.encode(`\r\n--${boundary}--\r\n`));

  const body = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    body.set(p, off);
    off += p.length;
  }
  return body;
}
