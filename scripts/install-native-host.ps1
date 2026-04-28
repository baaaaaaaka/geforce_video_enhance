$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$hostName = "com.geforce_video_enhance.rtx_vsr_switch"
$projectPath = Join-Path $repoRoot "native-host\RtxVsrNativeHost.csproj"
$presenterSourceDir = Join-Path $repoRoot "native-presenter"
$presenterBuildDir = Join-Path $presenterSourceDir "build"
$presenterBuildExe = Join-Path $presenterBuildDir "Release\smooth-presenter.exe"
$publishDir = Join-Path $repoRoot "native-host\bin\publish"
$hostExe = Join-Path $publishDir "rtx-vsr-native-host.exe"
$presenterExe = Join-Path $publishDir "smooth-presenter.exe"
$hostManifest = Join-Path $repoRoot "native-host\$hostName.json"
$configPath = Join-Path $publishDir "config.json"

function Invoke-Checked([scriptblock]$Command, [string]$Description) {
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

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

  throw "Chrome was not found. Install Chrome or edit native-host\\bin\\publish\\config.json after install."
}

function Get-CMakePath {
  $fromPath = Get-Command cmake -ErrorAction SilentlyContinue
  if ($fromPath) {
    return $fromPath.Source
  }

  $candidate = "$([Environment]::GetFolderPath('MyDocuments'))\Program\cmake\bin\cmake.exe"
  if (Test-Path -LiteralPath $candidate) {
    return (Resolve-Path -LiteralPath $candidate).Path
  }

  throw "cmake was not found. Install CMake or add it to PATH."
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

$manifest = Get-Content -Raw -LiteralPath (Join-Path $repoRoot "manifest.json") | ConvertFrom-Json
$extensionId = Get-ExtensionIdFromManifestKey $manifest.key
$chromePath = Get-ChromePath
$cmakePath = Get-CMakePath
$profilesRoot = Join-Path $env:LocalAppData "GeForceVideoEnhance\ChromeProfiles"

Invoke-Checked { & $cmakePath -S $presenterSourceDir -B $presenterBuildDir -G "Visual Studio 17 2022" -A x64 } "Configuring native presenter"
Invoke-Checked { & $cmakePath --build $presenterBuildDir --config Release } "Building native presenter"

Invoke-Checked { dotnet publish $projectPath -c Release -r win-x64 --self-contained false -o $publishDir } "Publishing native host"
Copy-Item -LiteralPath $presenterBuildExe -Destination $presenterExe -Force

$config = [ordered]@{
  chromePath = $chromePath
  extensionRoot = $repoRoot.Path
  profilesRoot = $profilesRoot
  presenterPath = $presenterExe
}
$config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $configPath -Encoding UTF8

$nativeManifest = [ordered]@{
  name = $hostName
  description = "Launches Chrome in RTX VSR or non-VSR video path mode."
  path = $hostExe
  type = "stdio"
  allowed_origins = @("chrome-extension://$extensionId/")
}
$nativeManifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $hostManifest -Encoding ASCII

$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $chromeRegPath -Force | Out-Null
Set-Item -Path $chromeRegPath -Value $hostManifest

$edgeRegRoot = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts"
if (Test-Path -LiteralPath "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe") {
  $edgeRegPath = Join-Path $edgeRegRoot $hostName
  New-Item -Path $edgeRegPath -Force | Out-Null
  Set-Item -Path $edgeRegPath -Value $hostManifest
}

Write-Host "Native host installed."
Write-Host "Extension ID: $extensionId"
Write-Host "Host manifest: $hostManifest"
Write-Host "Chrome path: $chromePath"
Write-Host "Presenter path: $presenterExe"
Write-Host "Profiles root: $profilesRoot"
Write-Host "Reload the unpacked extension in chrome://extensions/ after manifest changes."
