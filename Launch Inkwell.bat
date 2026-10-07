@echo off
title Inkwell PDF Annotator
set "PATH=%~dp0;%~dp0bin;%PATH%"
if exist "%~dp0pdfium.dll" (
    set "PDFIUM_DLL_DIR=%~dp0"
) else if exist "%~dp0bin\pdfium.dll" (
    set "PDFIUM_DLL_DIR=%~dp0bin"
)
set "BIN="
if exist "%~dp0inkwell-app.exe" (
    set "BIN=%~dp0inkwell-app.exe"
) else if exist "%~dp0Inkwell.exe" (
    set "BIN=%~dp0Inkwell.exe"
) else if exist "%~dp0inkwell-app\src-tauri\target\x86_64-pc-windows-msvc\release\inkwell-app.exe" (
    set "BIN=%~dp0inkwell-app\src-tauri\target\x86_64-pc-windows-msvc\release\inkwell-app.exe"
) else if exist "%~dp0inkwell-app\src-tauri\target\release\inkwell-app.exe" (
    set "BIN=%~dp0inkwell-app\src-tauri\target\release\inkwell-app.exe"
) else if exist "%~dp0inkwell-app\src-tauri\target\release\Inkwell.exe" (
    set "BIN=%~dp0inkwell-app\src-tauri\target\release\Inkwell.exe"
) else if exist "%~dp0inkwell-app\src-tauri\target\debug\inkwell-app.exe" (
    set "BIN=%~dp0inkwell-app\src-tauri\target\debug\inkwell-app.exe"
) else if exist "%~dp0inkwell-app\src-tauri\target\debug\Inkwell.exe" (
    set "BIN=%~dp0inkwell-app\src-tauri\target\debug\Inkwell.exe"
)

if defined BIN (
    start "" "%BIN%" %*
) else (
    echo [InkWell] No compiled binary found.
    echo Please build the application with:
    echo   cd inkwell-app\src-tauri ^&^& cargo build --release
    echo or
    echo   cd inkwell-app ^&^& npm run build
    pause
)
