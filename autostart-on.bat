@echo off
chcp 65001 >nul
title Cloud Play - автозапуск
rem Кладёт ярлык start.bat в папку «Автозагрузка» текущего пользователя.
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Startup')+'\Cloud Play.lnk'); $s.TargetPath='%~dp0start.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Save()"
if errorlevel 1 (
  echo  Не получилось включить автозапуск.
) else (
  echo.
  echo  Готово! Cloud Play будет запускаться сам при входе в Windows.
  echo  Выключить: autostart-off.bat
)
echo.
pause
