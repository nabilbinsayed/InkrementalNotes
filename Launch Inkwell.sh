#!/usr/bin/env bash
# Launch Inkwell on Linux
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="$DIR/bin:${LD_LIBRARY_PATH:-}"

if [ -f "$DIR/inkwell-app/src-tauri/target/release/inkwell-app" ]; then
    "$DIR/inkwell-app/src-tauri/target/release/inkwell-app" "$@"
elif [ -f "$DIR/inkwell-app/src-tauri/target/debug/inkwell-app" ]; then
    "$DIR/inkwell-app/src-tauri/target/debug/inkwell-app" "$@"
else
    echo "Inkwell binary not found. Build it with: cd inkwell-app/src-tauri && cargo build"
    exit 1
fi
