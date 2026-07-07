@echo off
title iRaceHUD Agent (DEMO mode)
cd /d "%~dp0"
echo.
echo  iRaceHUD is starting in DEMO mode (fake car, no iRacing needed).
echo  Your browser will open with the HUD in a moment.
echo.
echo  KEEP THIS BLACK WINDOW OPEN while using the HUD.
echo  Close this window to quit iRaceHUD.
echo.
start "" "%~dp0overlay.html"
node agent.js --demo
echo.
echo  iRaceHUD stopped. If there was an error above, take a screenshot of it.
pause
