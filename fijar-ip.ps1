param([switch]$Quitar)
$ErrorActionPreference = 'Stop'
$r = Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1
if (-not $r) { Write-Host 'No hay conexion de red. Conecta la PC al wifi del local y vuelve a intentar.'; exit 1 }
$i = $r.InterfaceIndex
$nombre = (Get-NetAdapter -InterfaceIndex $i).Name

if ($Quitar) {
  Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Enabled
  Set-DnsClientServerAddress -InterfaceIndex $i -ResetServerAddresses
  Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
  ipconfig /renew "$nombre" | Out-Null
  Write-Host "Listo: '$nombre' vuelve a recibir la IP automaticamente."
  exit 0
}

$ip = Get-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -ne 'WellKnown' } | Select-Object -First 1
$dns = (Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4).ServerAddresses
if (-not $dns) { $dns = @($r.NextHop) }
Write-Host "Red: $nombre  IP: $($ip.IPAddress)/$($ip.PrefixLength)  Router: $($r.NextHop)  DNS: $($dns -join ', ')"
Set-NetIPInterface -InterfaceIndex $i -AddressFamily IPv4 -Dhcp Disabled
Remove-NetIPAddress -InterfaceIndex $i -AddressFamily IPv4 -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetRoute -InterfaceIndex $i -DestinationPrefix '0.0.0.0/0' -Confirm:$false -ErrorAction SilentlyContinue
New-NetIPAddress -InterfaceIndex $i -IPAddress $ip.IPAddress -PrefixLength $ip.PrefixLength -DefaultGateway $r.NextHop | Out-Null
Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses $dns
Write-Host "Listo: esta PC queda siempre en $($ip.IPAddress)."
