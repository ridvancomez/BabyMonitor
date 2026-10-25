<#
.SYNOPSIS
  Bebek Monitörü sunucusunu Windows oturumu açılınca otomatik başlatır (Görev Zamanlayıcı).

.DESCRIPTION
  BabyMonitor.exe ile aynı klasörden, YÖNETİCİ olarak çalıştır.
  Görev, oturum açan kullanıcı adına çalışır; konsol penceresi açık kalır (kapatırsan sunucu durur).
  Kaldırmak için: otomatik-baslat-kaldir.ps1

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\otomatik-baslat-kur.ps1
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\otomatik-baslat-kur.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'BabyMonitor'
)

$ErrorActionPreference = 'Stop'

# Script klasörü: $PSScriptRoot boş kalabilir (ör. ISE'de seçimi çalıştırma); yedek olarak $MyInvocation.
$folder = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }
if (-not $folder) {
    throw 'Script klasörü bulunamadı. Scripti dosya olarak çalıştır: powershell -ExecutionPolicy Bypass -File .\otomatik-baslat-kur.ps1'
}
$exe = Join-Path $folder 'BabyMonitor.exe'
if (-not (Test-Path $exe)) {
    throw "BabyMonitor.exe bulunamadı: $exe`nBu scripti exe ile aynı klasörden çalıştır."
}
if (-not (Test-Path (Join-Path $folder 'appsettings.Local.json'))) {
    Write-Warning 'appsettings.Local.json yok. Sunucu PIN ve sertifika olmadan başlayamaz; önce KURULUM.md adım 3''ü yap.'
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
    throw 'Bu script yönetici olarak çalıştırılmalı (PowerShell''e sağ tık > Yönetici olarak çalıştır).'
}

$user = $identity.Name

# İnternetten/zip'ten gelen dosyalardaki engeli kaldır (SmartScreen sorusu görev başlatmayı bekletmesin).
if ($PSCmdlet.ShouldProcess($folder, 'Dosya engellerini kaldır (Unblock-File)')) {
    Get-ChildItem $folder -File | Unblock-File
}

$action = New-ScheduledTaskAction -Execute $exe -WorkingDirectory $folder
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

if ($PSCmdlet.ShouldProcess($TaskName, "Görev Zamanlayıcı görevi oluştur ($user oturum açınca $exe)")) {
    Register-ScheduledTask -TaskName $TaskName `
        -Description 'Bebek Monitörü sunucusu (oturum açılınca başlar).' `
        -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

    Write-Host "Görev oluşturuldu: '$TaskName'. Bir sonraki oturum açılışında sunucu kendiliğinden başlar."
    Write-Host "Şimdi başlatmak için: Start-ScheduledTask -TaskName '$TaskName'"
}
