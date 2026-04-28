$ErrorActionPreference = "Stop"

$hostName = "com.geforce_video_enhance.rtx_vsr_switch"
$paths = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"
)

foreach ($path in $paths) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
    Write-Host "Removed $path"
  }
}

Get-Process smooth-presenter,rtx-vsr-native-host -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "Native host registration removed. Remove the unpacked extension from chrome://extensions/ manually."
