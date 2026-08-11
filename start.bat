@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Creating virtual environment...
    python -m venv .venv
)

call ".venv\Scripts\activate.bat"

echo Installing dependencies...
python -m pip install --quiet --disable-pip-version-check -r requirements.txt

echo Starting Health Monitor...
python app.py

pause
