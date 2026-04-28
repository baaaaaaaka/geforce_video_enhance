[CmdletBinding()]
param(
  [string]$Version = "",
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$repoRootPath = $repoRoot.Path

function Invoke-Checked([scriptblock]$Command, [string]$Description) {
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Description failed with exit code $LASTEXITCODE."
  }
}

function Assert-UnderDirectory([string]$Path, [string]$Directory) {
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullDirectory = [System.IO.Path]::GetFullPath($Directory)
  if (!$fullDirectory.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $fullDirectory += [System.IO.Path]::DirectorySeparatorChar
  }

  if (!$fullPath.StartsWith($fullDirectory, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside expected directory: $fullPath"
  }
}

function Remove-PathIfExists([string]$Path, [string]$ExpectedParent) {
  Assert-UnderDirectory $Path $ExpectedParent
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Get-RelativePathCompat([string]$BasePath, [string]$FullPath) {
  $base = [System.IO.Path]::GetFullPath($BasePath)
  if (!$base.EndsWith([System.IO.Path]::DirectorySeparatorChar)) {
    $base += [System.IO.Path]::DirectorySeparatorChar
  }

  $target = [System.IO.Path]::GetFullPath($FullPath)
  $baseUri = New-Object System.Uri($base)
  $targetUri = New-Object System.Uri($target)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString())
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = (Get-Content -Raw -LiteralPath (Join-Path $repoRootPath "VERSION")).Trim()
}

if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
  throw "Version must be semver-like, got: $Version"
}

$manifestPath = Join-Path $repoRootPath "manifest.json"
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.version -ne $Version) {
  throw "manifest.json version ($($manifest.version)) does not match VERSION ($Version)."
}

Get-ChildItem -LiteralPath (Join-Path $repoRootPath "_locales") -Filter "messages.json" -Recurse |
  ForEach-Object {
    Get-Content -Raw -Encoding UTF8 -LiteralPath $_.FullName | ConvertFrom-Json | Out-Null
  }

$programText = Get-Content -Raw -LiteralPath (Join-Path $repoRootPath "native-host\Program.cs")
$hostVersionMatch = [regex]::Match($programText, 'HostVersion\s*=\s*"([^"]+)"')
if (!$hostVersionMatch.Success -or $hostVersionMatch.Groups[1].Value -ne $Version) {
  throw "native host HostVersion must match VERSION ($Version)."
}

$releaseName = "geforce-video-enhance-$Version-win-x64"
$releaseRoot = Join-Path $repoRootPath "artifacts\release"
$stageDir = Join-Path $releaseRoot $releaseName
$zipPath = Join-Path $releaseRoot "$releaseName.zip"
$extensionDir = Join-Path $stageDir "extension"
$nativeDir = Join-Path $stageDir "native-host"

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
Remove-PathIfExists $stageDir $releaseRoot
Remove-PathIfExists $zipPath $releaseRoot
New-Item -ItemType Directory -Force -Path $extensionDir, $nativeDir | Out-Null

$extensionFiles = @(
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "popup.css"
)

foreach ($file in $extensionFiles) {
  Copy-Item -LiteralPath (Join-Path $repoRootPath $file) -Destination (Join-Path $extensionDir $file) -Force
}
Copy-Item -LiteralPath (Join-Path $repoRootPath "_locales") -Destination (Join-Path $extensionDir "_locales") -Recurse -Force

if (!$SkipBuild) {
  $presenterSourceDir = Join-Path $repoRootPath "native-presenter"
  $presenterBuildDir = Join-Path $presenterSourceDir "build"
  $hostProjectPath = Join-Path $repoRootPath "native-host\RtxVsrNativeHost.csproj"

  Invoke-Checked { cmake -S $presenterSourceDir -B $presenterBuildDir -G "Visual Studio 17 2022" -A x64 } "Configuring native presenter"
  Invoke-Checked { cmake --build $presenterBuildDir --config Release } "Building native presenter"
  Invoke-Checked { dotnet publish $hostProjectPath -c Release -r win-x64 --self-contained true -o $nativeDir } "Publishing native host"
}
else {
  $publishDir = Join-Path $repoRootPath "native-host\bin\publish"
  if (!(Test-Path -LiteralPath $publishDir)) {
    throw "SkipBuild was set but native host publish directory does not exist: $publishDir"
  }

  Copy-Item -Path (Join-Path $publishDir "*") -Destination $nativeDir -Recurse -Force
}

$presenterExe = Join-Path $repoRootPath "native-presenter\build\Release\smooth-presenter.exe"
if (!(Test-Path -LiteralPath $presenterExe)) {
  throw "Smooth presenter executable was not found: $presenterExe"
}
Copy-Item -LiteralPath $presenterExe -Destination (Join-Path $nativeDir "smooth-presenter.exe") -Force

Copy-Item -LiteralPath (Join-Path $repoRootPath "release\install.ps1") -Destination (Join-Path $stageDir "install.ps1") -Force
Copy-Item -LiteralPath (Join-Path $repoRootPath "release\uninstall.ps1") -Destination (Join-Path $stageDir "uninstall.ps1") -Force
$releaseReadme = Get-Content -Raw -LiteralPath (Join-Path $repoRootPath "release\README_RELEASE.md")
$releaseReadme = $releaseReadme.Replace("@VERSION@", $Version)
Set-Content -LiteralPath (Join-Path $stageDir "README_RELEASE.md") -Value $releaseReadme -Encoding UTF8

$hashLines = Get-ChildItem -LiteralPath $stageDir -File -Recurse |
  Sort-Object FullName |
  ForEach-Object {
    $relative = (Get-RelativePathCompat $stageDir $_.FullName).Replace("\", "/")
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
    "$hash  $relative"
  }
$hashLines | Set-Content -LiteralPath (Join-Path $stageDir "SHA256SUMS.txt") -Encoding ASCII

Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
$zipHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash

Write-Host "Release package created:"
Write-Host "  Directory: $stageDir"
Write-Host "  Zip:       $zipPath"
Write-Host "  SHA256:    $zipHash"
