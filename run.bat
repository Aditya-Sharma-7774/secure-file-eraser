@echo off
title File Eraser X1 Runner
echo ===================================================
echo             FILE ERASER X1 STARTUP
echo ===================================================
echo.

set "ROOT_DIR=%~dp0"

:: Check for frontend build folder
if not exist "%ROOT_DIR%frontend\dist\index.html" (
    echo [INFO] Frontend build not found or outdated. Building React application...
    pushd "%ROOT_DIR%frontend"
    call npm run build
    popd
) else (
    echo [INFO] Frontend build found.
)
echo.

:: Launch default web browser after server starts
echo [INFO] Starting web client at http://127.0.0.1:8999/
start http://127.0.0.1:8999/

:: Run Python server
echo [INFO] Starting Python backend server...
if exist "%ROOT_DIR%.venv\Scripts\python.exe" (
    "%ROOT_DIR%.venv\Scripts\python.exe" "%ROOT_DIR%server.py"
) else (
    python "%ROOT_DIR%server.py"
)

pause
