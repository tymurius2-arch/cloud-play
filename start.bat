@echo off
chcp 65001 >nul
title Cloud Play
cd /d "%~dp0host"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Нужна программа Node.js. Сейчас откроется сайт nodejs.org.
  echo  Скачай версию LTS, установи её и снова запусти start.bat
  echo.
  start "" https://nodejs.org/
  pause
  exit /b 1
)

if not exist node_modules (
  echo  Первый запуск: скачиваю нужные компоненты, это займёт минуту...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo  Не получилось скачать компоненты. Проверь интернет и запусти снова.
    pause
    exit /b 1
  )
)

node server.js
pause
