#!/usr/bin/env bash
set -euo pipefail

MOONSHINE_VERSION="v0.1.5"
LIB_DIR="$(cd "$(dirname "$0")/.." && pwd)/lib"

detect_platform() {
    local os arch
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64)  arch="x86_64" ;;
        arm64|aarch64) arch="arm64" ;;
        *) echo "Unsupported architecture: $arch"; exit 1 ;;
    esac
    case "$os" in
        Linux*)  echo "linux-${arch}" ;;
        Darwin*) echo "macos-${arch}" ;;
        MINGW*|MSYS*|CYGWIN*) echo "windows-x86_64" ;;
        *) echo "Unsupported OS: $os"; exit 1 ;;
    esac
}

PLATFORM="$(detect_platform)"
DEST="${LIB_DIR}/${PLATFORM}"

if [ -f "$DEST/libmoonshine.so" ] || [ -f "$DEST/libmoonshine.a" ] || [ -f "$DEST/libmoonshine.dylib" ] || [ -f "$DEST/moonshine.dll" ]; then
    echo "Library already present at $DEST"
    exit 0
fi

echo "Downloading moonshine-voice ${MOONSHINE_VERSION} for ${PLATFORM}..."
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

curl -f -L "https://github.com/moonshine-ai/moonshine/releases/download/${MOONSHINE_VERSION}/moonshine-voice-${PLATFORM}.tar.gz" -o "$TMP/moonshine.tar.gz"
tar xzf "$TMP/moonshine.tar.gz" -C "$TMP" --strip-components=1

mkdir -p "$DEST"
# Normalize hyphens to underscores in lib filenames: rustc -l names must be
# identifier-safe and MSVC's linker lookup is verbatim, so the build script
# links them as moonshine_utils etc.
for f in "$TMP"/lib/*; do
    base="$(basename "$f")"
    cp -v "$f" "$DEST/${base//-/_}"
done
cp -v "$TMP"/include/moonshine-c-api.h "$(dirname "$DEST")/"

echo "Done. Library at $DEST"
