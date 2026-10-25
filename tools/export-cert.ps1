<#
.SYNOPSIS
  Bu bilgisayardaki .NET geliştirme sertifikasını parolalı bir .pfx olarak dışa aktarır (laptop kurulumu için).

.DESCRIPTION
  Parolayı sen girersin; hiçbir dosyaya kaydedilmez. Aynı parolayı laptopta
  appsettings.Local.json > Kestrel:Endpoints:Https:Certificate:Password alanına yaz.
  .pfx özel anahtar içerir: repoya ekleme (.gitignore'da *.pfx var).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\tools\export-cert.ps1
#>
[CmdletBinding()]
param(
    # Varsayılan (boş): proje\publish\babymonitor.pfx (laptopa klasörle birlikte taşınır).
    [string]$OutputPath,
    [SecureString]$Password
)

$ErrorActionPreference = 'Stop'

# Script klasörü: $PSScriptRoot boş kalabilir (ör. ISE'de seçimi çalıştırma); yedek olarak $MyInvocation.
$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } elseif ($MyInvocation.MyCommand.Path) { Split-Path -Parent $MyInvocation.MyCommand.Path } else { $null }
if (-not $OutputPath) {
    if (-not $scriptDir) { throw 'Script klasörü bulunamadı; -OutputPath ile hedef .pfx yolunu ver.' }
    $OutputPath = Join-Path $scriptDir '..\publish\babymonitor.pfx'
}

function ConvertTo-PlainText([SecureString]$secure) {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

if (-not $Password) {
    $Password = Read-Host 'PFX parolası' -AsSecureString
    $confirm = Read-Host 'Parolayı tekrar gir' -AsSecureString
    if ((ConvertTo-PlainText $Password) -cne (ConvertTo-PlainText $confirm)) {
        throw 'Parolalar eşleşmiyor.'
    }
}

$plain = ConvertTo-PlainText $Password
if ([string]::IsNullOrEmpty($plain)) {
    throw 'Parola boş olamaz.'
}

$OutputPath = [IO.Path]::GetFullPath($OutputPath)
New-Item -ItemType Directory -Force (Split-Path $OutputPath) | Out-Null

# Dev sertifikası yoksa önce oluşturur (dotnet dev-certs https).
dotnet dev-certs https -ep $OutputPath -p $plain | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "dotnet dev-certs başarısız oldu (çıkış kodu $LASTEXITCODE)."
}

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($OutputPath, $plain)
Write-Host "Sertifika dışa aktarıldı: $OutputPath"
Write-Host "  Konu      : $($cert.Subject)"
Write-Host "  Geçerlilik: $($cert.NotAfter.ToString('yyyy-MM-dd')) tarihine kadar"
Write-Host 'Aynı parolayı laptopta appsettings.Local.json dosyasına yaz.'
