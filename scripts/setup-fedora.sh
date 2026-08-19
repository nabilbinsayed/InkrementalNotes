#!/usr/bin/env bash
# Inkwell Fedora 44 (and modern Fedora) Environment Setup
set -euo pipefail

echo "==============================================="
echo " Installing Inkwell Dependencies for Fedora    "
echo "==============================================="

sudo dnf install -y \
    webkit2gtk4.1-devel \
    openssl-devel \
    curl \
    libappindicator-gtk3-devel \
    librsvg2-devel \
    gcc-c++ \
    glib2-devel \
    tar \
    gzip

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$ROOT_DIR/bin"
mkdir -p "$BIN_DIR"

if [ ! -f "$BIN_DIR/libpdfium.so" ]; then
    echo "==============================================="
    echo " Downloading prebuilt PDFium for Linux (x64)   "
    echo "==============================================="
    PDFIUM_URL="https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz"
    TEMP_TGZ="$(mktemp --suffix=.tgz)"
    curl -fsSL "$PDFIUM_URL" -o "$TEMP_TGZ"
    tar -xzf "$TEMP_TGZ" -C "$BIN_DIR" lib/libpdfium.so --strip-components=1
    rm -f "$TEMP_TGZ"
    echo "Successfully downloaded libpdfium.so to $BIN_DIR/libpdfium.so"
else
    echo "libpdfium.so already present in $BIN_DIR"
fi

echo "==============================================="
echo " Setup Complete! You can now run:              "
echo "   cd inkwell-app/src-tauri && cargo tauri dev "
echo "   or ./Launch\ Inkwell.sh                     "
echo "==============================================="
