# companion-plugin-stt

On-device speech recognition (Moonshine) + cloud transcription, with a Speech Recognition settings tab and the cloud STT endpoint card.

One of the official feature plugins for **Companion**, a plugin-based desktop
companion app (Tauri + React). A plugin is a `manifest.json` plus an optional
bundled React frontend and an optional Rust cdylib backend; see the
companion-tauri repository (`app/PLUGINS.md`) for the full plugin format and
host API documentation.

## Layout

| Path | Contents |
|---|---|
| `manifest.json` | Plugin metadata: id, ABI version, permissions, entry points |
| `src/` | React frontend source (bundled with esbuild at build time) |
| `backend/` | Rust cdylib backend (Moonshine FFI + mic capture) |
| `moonshine-sys/` | FFI bindings crate for the Moonshine Voice C API |
| `scripts/` | `download-moonshine-models.sh` — fetches the ONNX models |

React is never bundled into the plugin: `react` / `react-dom` are aliased to
the host's copies at build time, so plugin frontends always match the app.

## Building

Install dependencies first (pulls `@companion-lab/plugin` from npm and `companion-plugin-sdk` from crates.io):

```bash
npm install
```


The `companion-cli` CLI ([npm](https://www.npmjs.com/package/companion-cli),
install with `npm install -g companion-cli`) bundles the frontend
(and builds the Rust backend when present) into a zip importable via the app's
**Settings → Plugins → Import plugin…**:

```bash
companion-cli build /path/to/companion-plugin-stt --backend
```

Install dependencies first if you use a package manager lockfile
(`pnpm install` / `npm install`).

## Models & native library

The Moonshine ONNX models (`assets/moonshine/`) and the prebuilt Moonshine
dylib (`moonshine-sys/lib/`) are not stored in git — download them before
building the backend:

```bash
pnpm install
pnpm run download:models   # STT models + platform dylib
```

## Downloading releases

CI builds installable zips on every push to `main` (the "Build plugin"
workflow). To publish a release, push a tag matching the version in
`manifest.json`:

```bash
git tag v0.1.1 && git push origin v0.1.1
```

The release gets one zip per platform — download the one for your machine
and import it in the Companion app via **Settings → Plugins → Import
plugin…**:

| File | Platform |
|---|---|
| `stt-0.1.1-macos-arm64.zip` | macOS (Apple Silicon) |

Only Apple Silicon is packaged: the Moonshine native library the backend
links is published as a static library for macOS arm64 only — the
Linux/Windows artifacts are shared/import libraries that a self-contained
plugin zip cannot carry.

Non-tag runs of the workflow publish the same zips as run artifacts for
testing. CI never touches the zips committed under `dist/`.
