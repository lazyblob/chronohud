@echo off
title iRaceHUD (LIVE in-game overlay)
cd /d "%~dp0"
echo.
echo  iRaceHUD LIVE in-game overlay is starting...
echo  The HUD widgets will float on top of iRacing.
echo.
echo  IMPORTANT: set iRacing to BORDERLESS WINDOWED mode
echo  (iRacing graphics settings), or the overlay stays hidden behind it.
echo.
echo  Hotkeys:   Ctrl+Shift+Q     =  quit the overlay
echo             Ctrl+Shift+M     =  edit layout: drag widgets to move them,
echo                                 drag the yellow corner to resize,
echo                                 click X to hide, DONE to lock it in
echo             Ctrl+Shift+ +/-  =  zoom the whole HUD
echo.
echo  KEEP THIS BLACK WINDOW OPEN while racing. Close it to stop everything.
echo.
call npx electron overlay-window.js
echo.
echo  iRaceHUD stopped. If there was an error above, take a screenshot of it.
pause
