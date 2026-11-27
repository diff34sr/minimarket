@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1 || (echo Falta instalar Node.js. Avisa a soporte. & pause & exit /b 1)
netstat -ano | findstr ":3000 " | findstr LISTENING >nul && goto abrir
if not exist copias mkdir copias
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd"') do set HOY=%%d
if exist minimarket.db if not exist "copias\minimarket-%HOY%.db" copy /y minimarket.db "copias\minimarket-%HOY%.db" >nul
rem Actualiza solo si hay internet; si no, sigue con la version que tiene.
git pull --ff-only -q >nul 2>&1
start "Minimarket - NO CERRAR esta ventana" /min node server.js
timeout /t 2 /nobreak >nul
:abrir
start "" http://localhost:3000
