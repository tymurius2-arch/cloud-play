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

rem Разрешаем телефону подключаться к Cloud Play через брандмауэр Windows.
rem Делается один раз: Windows спросит разрешение администратора.
netsh advfirewall firewall show rule name="Cloud Play" >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Разрешаю Cloud Play в брандмауэре Windows, чтобы телефон мог подключиться.
  echo  Сейчас Windows спросит разрешение - нажми "Да".
  echo.
  powershell -NoProfile -Command "try { Start-Process netsh -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList 'advfirewall firewall add rule name=\"Cloud Play\" dir=in action=allow protocol=TCP localport=8080-8100,8443-8463 profile=private,public' } catch { exit 1 }"
  netsh advfirewall firewall show rule name="Cloud Play" >nul 2>nul
  if errorlevel 1 (
    echo  Брандмауэр не настроен: без этого телефон может не подключиться.
    echo  Запусти start.bat ещё раз и нажми "Да".
    echo.
  ) else (
    echo  Готово, брандмауэр настроен.
  )
)

node server.js
pause
