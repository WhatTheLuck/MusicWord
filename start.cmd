@echo off
cd /d "%~dp0"
call npm start -- --open
if errorlevel 1 (
    pause
    exit /b 1
)
