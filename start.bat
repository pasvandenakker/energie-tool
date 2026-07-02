@echo off
title EnergieSim
echo EnergieSim wordt gestart...
echo.

:: Oude server op poort 3000 afsluiten
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000 "') do (
  taskkill /f /pid %%a >nul 2>&1
)

:: Server starten (achtergrond)
start /b node server.js

:: Tijd geven om op te starten
timeout /t 3 /nobreak >nul

:: Browser openen
start http://localhost:3000

echo.
echo EnergieSim draait op http://localhost:3000
echo.
echo Druk op een toets om de server te stoppen.
pause >nul
taskkill /f /im node.exe >nul 2>&1
