#!/usr/bin/env bash
# build_omarchy.sh — Build and install InkWell for Arch Linux / Omarchy
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

BOLD="\033[1m"
GREEN="\033[0;32m"
YELLOW="\033[1;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
RESET="\033[0m"

echo -e "${BOLD}${CYAN}======================================================${RESET}"
echo -e "${BOLD}${CYAN}   InkWell — Build & Setup for Arch Linux / Omarchy   ${RESET}"
echo -e "${BOLD}${CYAN}======================================================${RESET}"

# 1. Check system dependencies
echo -e "\n${BOLD}[1/6] Checking system dependencies...${RESET}"
REQUIRED_PACKAGES=(
    "base-devel"
    "webkit2gtk-4.1"
    "gtk3"
    "libsoup3"
    "openssl"
    "curl"
    "cairo"
    "pango"
    "python"
)

MISSING_PKGS=()
if command -v pacman >/dev/null 2>&1; then
    for pkg in "${REQUIRED_PACKAGES[@]}"; do
        if ! pacman -Q "$pkg" >/dev/null 2>&1; then
            MISSING_PKGS+=("$pkg")
        fi
    done
    if [ ${#MISSING_PKGS[@]} -gt 0 ]; then
        echo -e "${YELLOW}Missing packages detected: ${MISSING_PKGS[*]}${RESET}"
        echo -e "Install them with:"
        echo -e "  ${BOLD}sudo pacman -S --needed ${MISSING_PKGS[*]}${RESET}"
    else
        echo -e "${GREEN}✓ All required Arch system packages are installed.${RESET}"
    fi
else
    echo -e "${YELLOW}Notice: pacman not found; skipping package inspection.${RESET}"
fi

# 2. Check input group membership for tablet / evdev streaming
echo -e "\n${BOLD}[2/6] Checking hardware stylus input permissions...${RESET}"
if id -nG "$USER" | grep -qw "input"; then
    echo -e "${GREEN}✓ User '$USER' is a member of the 'input' group (evdev direct streaming active).${RESET}"
else
    echo -e "${YELLOW}Notice: User '$USER' is not in the 'input' group.${RESET}"
    echo -e "To enable direct evdev hardware streaming for Huion / Wacom / OpenTabletDriver tablets:"
    echo -e "  ${BOLD}sudo usermod -aG input $USER${RESET}"
    echo -e "(Requires logging out and back in. InkWell will use browser PointerEvents in the meantime.)"
fi

# 3. Check PDFium native shared library
echo -e "\n${BOLD}[3/6] Verifying PDFium native library...${RESET}"
PDFIUM_BIN="$SCRIPT_DIR/bin/libpdfium.so"
if [ -f "$PDFIUM_BIN" ]; then
    echo -e "${GREEN}✓ Native PDFium library found at $PDFIUM_BIN${RESET}"
else
    echo -e "${RED}✗ Error: bin/libpdfium.so not found! Please provide libpdfium.so in the bin/ directory.${RESET}"
    exit 1
fi

# 4. Build Tauri App
echo -e "\n${BOLD}[4/6] Building Tauri desktop application...${RESET}"
cd "$SCRIPT_DIR/inkwell-app/src-tauri"
cargo build --release
echo -e "${GREEN}✓ Tauri release binary compiled successfully.${RESET}"

# Also make sure debug target has updated libpdfium
mkdir -p "$SCRIPT_DIR/inkwell-app/src-tauri/target/release"
cp -u "$PDFIUM_BIN" "$SCRIPT_DIR/inkwell-app/src-tauri/target/release/libpdfium.so" 2>/dev/null || true

# 5. Install Desktop Entry and Icons
echo -e "\n${BOLD}[5/6] Installing desktop launcher & icons...${RESET}"
cd "$SCRIPT_DIR"
ICON_128="$SCRIPT_DIR/inkwell-app/src-tauri/icons/128x128.png"
ICON_32="$SCRIPT_DIR/inkwell-app/src-tauri/icons/32x32.png"
DESKTOP_SRC="$SCRIPT_DIR/dev.inkwell.app.desktop"

mkdir -p "$HOME/.local/share/icons/hicolor/128x128/apps"
mkdir -p "$HOME/.local/share/icons/hicolor/32x32/apps"
mkdir -p "$HOME/.local/share/applications"

if [ -f "$ICON_128" ]; then
    cp "$ICON_128" "$HOME/.local/share/icons/hicolor/128x128/apps/dev.inkwell.app.png"
fi
if [ -f "$ICON_32" ]; then
    cp "$ICON_32" "$HOME/.local/share/icons/hicolor/32x32/apps/dev.inkwell.app.png"
fi
if [ -f "$DESKTOP_SRC" ]; then
    cp "$DESKTOP_SRC" "$HOME/.local/share/applications/dev.inkwell.app.desktop"
    if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
    fi
    echo -e "${GREEN}✓ Desktop entry and icons installed to ~/.local/share/${RESET}"
fi

# 6. Hyprland configuration check
echo -e "\n${BOLD}[6/6] Checking Hyprland window rules...${RESET}"
HYPR_CONF="$HOME/.config/hypr/hyprland.lua"
if [ -f "$HYPR_CONF" ]; then
    if grep -q "dev\.inkwell\.app" "$HYPR_CONF" || grep -q "inkwell-app" "$HYPR_CONF"; then
        echo -e "${GREEN}✓ Hyprland opacity rule is already present in $HYPR_CONF.${RESET}"
    else
        echo -e "\n-- InkWell PDF-Native Ink Annotator\no.window(\"^(Inkwell|inkwell-app|dev\\\\.inkwell\\\\.app)$\", { tag = \"-default-opacity\", opacity = \"1.0 1.0\" })" >> "$HYPR_CONF"
        echo -e "${GREEN}✓ Added full-opacity window rule to $HYPR_CONF.${RESET}"
    fi
else
    echo -e "${CYAN}Hyprland Lua config not detected; skipping rule injection.${RESET}"
fi

echo -e "\n${BOLD}${GREEN}======================================================${RESET}"
echo -e "${BOLD}${GREEN}   InkWell Omarchy setup complete!                    ${RESET}"
echo -e "${BOLD}${GREEN}   Launch via application menu or:                    ${RESET}"
echo -e "     ${BOLD}\"$SCRIPT_DIR/Launch Inkwell.sh\"${RESET}"
echo -e "${BOLD}${GREEN}======================================================${RESET}"
