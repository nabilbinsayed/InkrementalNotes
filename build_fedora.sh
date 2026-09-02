#!/usr/bin/env bash
# ==============================================================================
# build_fedora.sh — Automated Build Script for Fedora KDE Plasma (Linux)
# ==============================================================================
set -euo pipefail

echo "==> [1/4] Installing Fedora Development Dependencies..."
sudo dnf install -y \
  webkit2gtk4.1-devel \
  gtk3-devel \
  libayatana-appindicator-gtk3-devel \
  librsvg2-devel \
  openssl-devel \
  libevdev-devel \
  libxdo-devel \
  file-devel \
  gcc gcc-c++ make curl wget tar

# Ensure user belongs to input group for direct evdev stylus streaming
if ! groups "$USER" | grep -q "\binput\b"; then
  echo "==> Adding $USER to 'input' group for native hardware stylus access..."
  sudo usermod -aG input "$USER"
  echo "    (Note: You may need to log out and log back in to activate group membership)"
fi

echo "==> [2/4] Fetching prebuilt Linux PDFium shared library..."
PDFIUM_DIR="inkwell-app/src-tauri/target/release"
mkdir -p "$PDFIUM_DIR"
if [ ! -f "$PDFIUM_DIR/libpdfium.so" ]; then
  TEMP_DL=$(mktemp -d)
  wget -q --show-progress -O "$TEMP_DL/pdfium.tgz" https://github.com/bblanchon/pdfium-binaries/releases/latest/download/pdfium-linux-x64.tgz
  tar -xzf "$TEMP_DL/pdfium.tgz" -C "$TEMP_DL"
  cp "$TEMP_DL/lib/libpdfium.so" "$PDFIUM_DIR/"
  sudo cp "$TEMP_DL/lib/libpdfium.so" /usr/lib64/ || true
  rm -rf "$TEMP_DL"
fi

echo "==> [3/4] Building InkWell Core Engine..."
cd inkwell
cargo test
cd ..

echo "==> [4/4] Bundling Fedora Native Packages (.rpm & .AppImage)..."
cd inkwell-app
npm install
npx @tauri-apps/cli build

echo "=============================================================================="
echo "Build Complete! Built Linux packages are located in:"
echo "  - RPM Package:      inkwell-app/src-tauri/target/release/bundle/rpm/"
echo "  - AppImage Bundle:  inkwell-app/src-tauri/target/release/bundle/appimage/"
echo "  - Direct Binary:    inkwell-app/src-tauri/target/release/inkwell-app"
echo "=============================================================================="
