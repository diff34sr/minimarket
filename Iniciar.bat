@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1 || (echo Falta instalar Node.js. Avisa a soporte. & pause & exit /b 1)
netstat -ano | findstr ":3000 " | findstr LISTENING >nul && goto abrir
start "Minimarket - NO CERRAR esta ventana" /min node server.js
timeout /t 2 /nobreak >nul
:abrir
start "" http://localhost:3000
