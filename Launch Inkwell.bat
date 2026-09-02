@echo off
title Inkwell PDF Annotator
set "PATH=%~dp0bin;%PATH%"
set "RELEASE_BIN=%~dp0inkwell-app\src-tauri\target\release\inkwell-app.exe"
set "DEBUG_BIN=%~dp0inkwell-app\src-tauri\target\debug\inkwell-app.exe"

if exist "%RELEASE_BIN%" (
    start "" "%RELEASE_BIN%" %*
) else if exist "%DEBUG_BIN%" (
    start "" "%DEBUG_BIN%" %*
) else (
    echo [InkWell] No compiled binary found.
    echo Please build the application with:
    echo   cd inkwell-app\src-tauri ^&^& cargo build --release
    echo or
    echo   cd inkwell-app ^&^& npm run build
    pause
)
