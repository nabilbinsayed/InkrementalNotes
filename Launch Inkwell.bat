@echo off
title Inkwell PDF Annotator
set "PATH=%~dp0bin;%PATH%"
start "" "%~dp0inkwell-app\src-tauri\target\debug\inkwell-app.exe"
