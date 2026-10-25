<#
.SYNOPSIS
  otomatik-baslat-kur.ps1 ile oluşturulan Görev Zamanlayıcı görevini durdurur ve kaldırır.

.DESCRIPTION
  YÖNETİCİ olarak çalıştır. Çalışan sunucu (bu klasördeki BabyMonitor.exe) da kapatılır.
  Program dosyalarına ve appsettings.Local.json'a dokunmaz.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\otomatik-baslat-kaldir.ps1
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'BabyMonitor'
)

$ErrorActionPreference = 'Stop'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $WhatIfPreference) {
    throw 'Bu script yönetici olarak çalıştırılmalı (PowerShell''e sağ tık > Yönetici olarak çalıştır).'
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    if ($PSCmdlet.ShouldProcess($TaskName, 'Görevi durdur ve kaldır')) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Görev kaldırıldı: '$TaskName'."
    }
} else {
    Write-Host "Görev bulunamadı: '$TaskName' (zaten kaldırılmış olabilir)."
}

# Görev dışında elle başlatılmış kopya da kalmasın (sadece bu klasördeki exe).
# Script klasörü: $PSScriptRoot boş kalabilir (ör. ISE'de seçimi çalıştırma); yedek olarak $MyInvocation.
$folder = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }
$exe = if ($folder) { Join-Path $folder 'BabyMonitor.exe' } else { $null }
$running = if ($exe) { Get-Process -Name BabyMonitor -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe } } else { @() }
foreach ($process in $running) {
    if ($PSCmdlet.ShouldProcess("PID $($process.Id)", 'Çalışan sunucuyu kapat')) {
        Stop-Process -Id $process.Id -Force
        Write-Host "Çalışan sunucu kapatıldı (PID $($process.Id))."
    }
}
