@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Instalar Minimarket
net session >nul 2>&1 || (echo Clic derecho en Instalar.bat y elige "Ejecutar como administrador". & pause & exit /b 1)
where node >nul 2>&1 || (echo Falta Node.js 24: https://nodejs.org & pause & exit /b 1)
where git >nul 2>&1 || (echo Falta Git: https://git-scm.com & pause & exit /b 1)

echo Marcando esta red wifi como privada...
powershell -NoProfile -Command "Get-NetConnectionProfile | Set-NetConnectionProfile -NetworkCategory Private"

echo Abriendo el puerto 3000 para los telefonos...
netsh advfirewall firewall delete rule name="Minimarket" >nul 2>&1
netsh advfirewall firewall add rule name="Minimarket" dir=in action=allow protocol=TCP localport=3000 profile=private >nul

echo Evitando que la PC se duerma mientras esta enchufada...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT

echo Creando accesos directos (escritorio y arranque de Windows)...
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $d='%~dp0'; foreach($p in @(@([Environment]::GetFolderPath('Desktop')+'\Minimarket.lnk','Iniciar.bat'),@([Environment]::GetFolderPath('Desktop')+'\Actualizar Minimarket.lnk','Actualizar.bat'),@([Environment]::GetFolderPath('Startup')+'\Minimarket.lnk','Iniciar.bat'))){$s=$w.CreateShortcut($p[0]);$s.TargetPath=$d+$p[1];$s.WorkingDirectory=$d;$s.WindowStyle=7;$s.Save()}"

echo.
echo Listo. Minimarket se abrira solo al encender la PC.
call Iniciar.bat
pause
