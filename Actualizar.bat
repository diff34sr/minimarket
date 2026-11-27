@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Actualizar Minimarket
echo Actualizando Minimarket. No cierres esta ventana...
echo.
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr LISTENING') do taskkill /PID %%p /F >nul 2>&1
timeout /t 1 /nobreak >nul
if not exist copias mkdir copias
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd_HHmm"') do set FECHA=%%d
if exist minimarket.db copy /y minimarket.db "copias\minimarket-%FECHA%.db" >nul
git pull --ff-only
if errorlevel 1 (
  echo.
  echo No se pudo actualizar. Revisa que haya internet y vuelve a intentar.
  echo Si sigue fallando, avisa a soporte. Minimarket sigue funcionando igual.
  call Iniciar.bat
  pause
  exit /b 1
)
echo.
echo Listo: Minimarket esta actualizado.
call Iniciar.bat
timeout /t 5 >nul
