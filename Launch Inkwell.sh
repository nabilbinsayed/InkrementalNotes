#!/usr/bin/env bash
# Launch Inkwell on Linux
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export LD_LIBRARY_PATH="$DIR/bin:${LD_LIBRARY_PATH:-}"

RELEASE_BIN="$DIR/inkwell-app/src-tauri/target/release/inkwell-app"
DEBUG_BIN="$DIR/inkwell-app/src-tauri/target/debug/inkwell-app"

if [ -f "$DIR/inkwell-app" ]; then
    exec "$DIR/inkwell-app" "$@"
elif [ -f "$DIR/Inkwell" ]; then
    exec "$DIR/Inkwell" "$@"
elif [ -f "$RELEASE_BIN" ] && [ -f "$DEBUG_BIN" ]; then
    if [ "$RELEASE_BIN" -nt "$DEBUG_BIN" ]; then
        exec "$RELEASE_BIN" "$@"
    else
        exec "$DEBUG_BIN" "$@"
    fi
elif [ -f "$RELEASE_BIN" ]; then
    exec "$RELEASE_BIN" "$@"
elif [ -f "$DEBUG_BIN" ]; then
    exec "$DEBUG_BIN" "$@"
else
    echo "Inkwell binary not found. Build it with: cd inkwell-app/src-tauri && cargo build"
    exit 1
fi
