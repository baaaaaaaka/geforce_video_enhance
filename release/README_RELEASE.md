# GeForce Video Enhance @VERSION@

Experimental Chrome/Edge extension for YouTube RTX Video Super Resolution and Smooth Motion controls.

## Included

- `extension/`: unpacked Chrome extension.
- `native-host/`: prebuilt Windows x64 native host and Smooth Motion presenter.
- `install.ps1`: registers the native messaging host for Chrome and Edge.
- `uninstall.ps1`: removes the native messaging host registration.

## Requirements

- Windows 10/11 x64.
- Google Chrome or Microsoft Edge.
- NVIDIA GPU and driver support for the feature you want to test.
- NVIDIA App/driver settings configured for RTX Video Super Resolution and/or Smooth Motion.

## Install

1. Extract the zip to a stable folder. Do not delete or move the folder after installing.
2. Open PowerShell in this folder.
3. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

4. Open `chrome://extensions/`.
5. Enable Developer mode.
6. Click `Load unpacked` and select the `extension` folder from this release.
7. Open or reload a YouTube video page.

## Update

1. Extract the new release.
2. Run `install.ps1` from the new release folder.
3. In `chrome://extensions/`, remove or reload the old unpacked extension and load the new `extension` folder.

## Uninstall

1. Remove the unpacked extension from `chrome://extensions/`.
2. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

## Notes

- Smooth Motion overlay is experimental. The overlay hides during player interaction so YouTube controls stay usable.
- Windows Graphics Capture may show a capture border depending on system policy.
- If Smooth Motion is not enabled in NVIDIA App/driver settings, the extension cannot force interpolation by itself.
- This release is unsigned and not published through Chrome Web Store.
