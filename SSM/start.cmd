@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    py -3.11 -m venv .venv
    if errorlevel 1 goto failed
)
".venv\Scripts\python.exe" -c "import anytree, mido, numpy, pandas, pretty_midi, scipy, matplotlib" >nul 2>&1
if errorlevel 1 (
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt
    if errorlevel 1 goto failed
)
echo Open http://127.0.0.1:8766 in your browser.
".venv\Scripts\python.exe" workbench.py
if errorlevel 1 goto failed
exit /b
:failed
pause
exit /b 1
