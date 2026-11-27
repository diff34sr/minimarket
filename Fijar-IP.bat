@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Fijar IP de la PC
net session >nul 2>&1 || (echo Clic derecho en Fijar-IP.bat y elige "Ejecutar como administrador". & pause & exit /b 1)
echo Usar SOLO si no se puede fijar la IP en el router.
echo Esta PC quedara siempre con la IP que tiene ahora en este wifi.
echo Si la PC se lleva a otro wifi, no tendra internet: ejecutar Fijar-IP.bat quitar
echo.
if /i "%~1"=="quitar" (powershell -NoProfile -ExecutionPolicy Bypass -File fijar-ip.ps1 -Quitar & pause & exit /b)
choice /m "Fijar la IP ahora"
if errorlevel 2 exit /b
powershell -NoProfile -ExecutionPolicy Bypass -File fijar-ip.ps1
pause
