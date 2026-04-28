$ErrorActionPreference = "Stop"

$hostName = "com.geforce_video_enhance.rtx_vsr_switch"
$releaseRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$extensionDir = Join-Path $releaseRoot "extension"
$nativeDir = Join-Path $releaseRoot "native-host"
$hostExe = Join-Path $nativeDir "rtx-vsr-native-host.exe"
$presenterExe = Join-Path $nativeDir "smooth-presenter.exe"
$hostManifest = Join-Path $nativeDir "$hostName.json"
$configPath = Join-Path $nativeDir "config.json"

function Get-ChromePath {
  $candidates = @(
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }

  return ""
}

function Get-ExtensionIdFromManifestKey([string]$manifestKey) {
  $bytes = [Convert]::FromBase64String($manifestKey)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hash = $sha.ComputeHash($bytes)
  $chars = New-Object System.Collections.Generic.List[string]

  for ($i = 0; $i -lt 16; $i++) {
    $high = ($hash[$i] -shr 4) -band 0x0f
    $low = $hash[$i] -band 0x0f
    $chars.Add([char]([int][char]'a' + $high))
    $chars.Add([char]([int][char]'a' + $low))
  }

  return -join $chars
}

if (!(Test-Path -LiteralPath (Join-Path $extensionDir "manifest.json"))) {
  throw "Extension manifest was not found: $extensionDir"
}

if (!(Test-Path -LiteralPath $hostExe)) {
  throw "Native host executable was not found: $hostExe"
}

if (!(Test-Path -LiteralPath $presenterExe)) {
  throw "Smooth presenter executable was not found: $presenterExe"
}

$extensionManifest = Get-Content -Raw -LiteralPath (Join-Path $extensionDir "manifest.json") | ConvertFrom-Json
$extensionId = Get-ExtensionIdFromManifestKey $extensionManifest.key
$chromePath = Get-ChromePath
$profilesRoot = Join-Path $env:LocalAppData "GeForceVideoEnhance\ChromeProfiles"

$config = [ordered]@{
  chromePath = $chromePath
  extensionRoot = (Resolve-Path -LiteralPath $extensionDir).Path
  profilesRoot = $profilesRoot
  presenterPath = (Resolve-Path -LiteralPath $presenterExe).Path
}
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8

$nativeManifest = [ordered]@{
  name = $hostName
  description = "Native host for GeForce Video Enhance."
  path = (Resolve-Path -LiteralPath $hostExe).Path
  type = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
}
$nativeManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $hostManifest -Encoding ASCII

$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $chromeRegPath -Force | Out-Null
Set-Item -Path $chromeRegPath -Value $hostManifest

$edgeExeCandidates = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LocalAppData\Microsoft\Edge\Application\msedge.exe"
)
if ($edgeExeCandidates | Where-Object { Test-Path -LiteralPath $_ }) {
  $edgeRegPath = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
  New-Item -Path $edgeRegPath -Force | Out-Null
  Set-Item -Path $edgeRegPath -Value $hostManifest
}

Write-Host "Native host installed."
Write-Host "Extension ID: $extensionId"
Write-Host "Extension directory: $extensionDir"
Write-Host "Native host manifest: $hostManifest"
Write-Host "Chrome path: $chromePath"
Write-Host ""
Write-Host "Next steps:"
Write-Host "1. Open chrome://extensions/"
Write-Host "2. Enable Developer mode."
Write-Host "3. Click Load unpacked and select: $extensionDir"
Write-Host "4. Open or reload a YouTube video page."
