@echo off
chcp 65001 >nul
title Cloud Play - автозапуск
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Cloud Play.lnk" >nul 2>nul
echo.
echo  Автозапуск Cloud Play выключен.
echo.
pause
