@echo off
title iRaceHUD (DEMO in-game overlay)
cd /d "%~dp0"
echo.
echo  iRaceHUD DEMO in-game overlay is starting (fake car, no iRacing needed).
echo  The HUD widgets will float on top of EVERYTHING on your screen.
echo  This is exactly how it will look over iRacing.
echo.
echo  Hotkeys:   Ctrl+Shift+Q     =  quit the overlay
echo             Ctrl+Shift+M     =  edit layout: drag widgets to move them,
echo                                 drag the yellow corner to resize,
echo                                 click X to hide, DONE to lock it in
echo             Ctrl+Shift+ +/-  =  zoom the whole HUD
echo.
echo  KEEP THIS BLACK WINDOW OPEN. Close it to stop everything.
echo.
call npx electron overlay-window.js --demo
echo.
echo  iRaceHUD stopped. If there was an error above, take a screenshot of it.
pause
