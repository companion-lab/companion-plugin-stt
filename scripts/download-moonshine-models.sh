#!/usr/bin/env bash
set -euo pipefail

MODEL_DIR="$(cd "$(dirname "$0")/.." && pwd)/assets/moonshine/stt"
BASE_URL="https://download.moonshine.ai/model/medium-streaming-en/quantized_26_08_21"

echo "Downloading medium-streaming-en STT model..."

mkdir -p "$MODEL_DIR"

for f in adapter.ort cross_kv.ort decoder_kv.ort encoder.ort frontend.model.ort frontend.weights.ort streaming_config.json tokenizer.bin; do
    dest="$MODEL_DIR/$f"
    if [ -f "$dest" ] && [ "$(stat -f%z "$dest" 2>/dev/null || stat -c%s "$dest" 2>/dev/null)" -gt 100 ]; then
        echo "  skip $f (already exists)"
        continue
    fi
    echo "  get $f"
    curl -f -o "$dest" -L "$BASE_URL/$f"
done

echo "Done. Model files at $MODEL_DIR/"
ls -lh "$MODEL_DIR/"
