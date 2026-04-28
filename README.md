# GeForce Video Enhance

[Chinese README](README.zh-CN.md)

`geforce_video_enhance` is an experimental Chrome/Edge extension for debugging and switching NVIDIA RTX video-enhancement paths inside the YouTube player. The current version is `0.1.1`.

The project has three parts:

- A Manifest V3 extension that injects VSR, comparison, and Smooth Motion controls into the YouTube player.
- A Windows native messaging host that lets the extension start, sync, and stop a local presenter process.
- A Windows Graphics Capture + D3D11 presenter that experiments with the NVIDIA Smooth Motion overlay route.

## Feature Status

- `VSR`: shows YouTube's native `<video>` layer and lets Chrome/NVIDIA's normal video-processing path handle output.
- `non-VSR`: uses an in-page canvas bypass path that draws video frames into a canvas. It still needs the original `<video>` as the decode source and does not stop YouTube playback or decoding.
- Comparison mode: shows a draggable vertical split in the player. One side uses the native video layer; the other uses the canvas bypass path.
- Smooth Motion overlay: starts the bundled `smooth-presenter.exe` through the native host. The presenter captures the Chrome player region through Windows Graphics Capture, then re-presents it in an aligned D3D11 flip-model window.
- Localization: extension UI strings use Chrome `_locales`. English is the default locale; Chinese is used when Chrome's UI language is Chinese.

Chrome extensions cannot directly change NVIDIA App, driver, or NVIDIA Control Panel global settings. To make VSR or Smooth Motion actually take effect, first enable the relevant NVIDIA feature for the browser or presenter route in NVIDIA App/driver settings.

## Known Limits

- Smooth Motion overlay is experimental. To preserve native YouTube controls, the overlay temporarily hides while the user interacts with the player, then restores itself when the player becomes idle.
- Windows Graphics Capture may show a system capture border. Whether that border can be hidden depends on Windows policy and permissions.
- DevTools screenshots do not always include every GPU post-processing stage in the final display path. Prefer cadence diagnostics or external screen capture when validating Smooth Motion.
- The current release is unsigned and is not published through Chrome Web Store.

## Install From GitHub Release

1. Open the release page: `https://github.com/baaaaaaaka/geforce_video_enhance/releases`
2. Download `geforce-video-enhance-<version>-win-x64.zip`.
3. Extract it to a stable folder. Do not delete or move the folder after installation.
4. Open PowerShell in the extracted folder and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

5. Open `chrome://extensions/` or `edge://extensions/`.
6. Enable Developer mode.
7. Click `Load unpacked` and select the release's `extension` folder.
8. Open or reload a YouTube video page. The extension buttons should appear in the player controls.

To uninstall:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

Then remove the unpacked extension from `chrome://extensions/`.

## Development Setup

### Requirements

- Windows 10/11 x64.
- Google Chrome or Microsoft Edge.
- NVIDIA GPU, driver, and NVIDIA App configured for the VSR/Smooth Motion feature you want to test.
- .NET SDK 5.0.
- Visual Studio 2022 Build Tools with the C++ desktop toolchain.
- CMake.
- Node.js 22 or newer for diagnostics.
- GitHub CLI only if you need to publish to GitHub.

### Build And Register The Native Host

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1
```

The script will:

- Build `native-presenter/smooth-presenter.exe`.
- Publish `native-host/rtx-vsr-native-host.exe`.
- Write the native messaging host manifest.
- Register the native messaging host under HKCU for Chrome/Edge.
- Compute the extension ID from the fixed `manifest.json` key.

Then load this repository root as an unpacked extension in `chrome://extensions/`.

Development uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-native-host.ps1
```

## Usage

- The `VSR` button in the YouTube player switches between the native video layer and the non-VSR canvas bypass.
- The split button enables comparison mode; drag the vertical divider to change the split ratio.
- The Smooth Motion button starts or stops the native overlay.
- When the overlay is enabled, the extension syncs player position, visibility, window movement, play/pause state, and seek state.
- During mouse, keyboard, touch, or wheel interaction, the overlay temporarily hides so native YouTube controls remain usable.

## Localization

The extension uses Chrome's standard `_locales` mechanism:

- `_locales/en/messages.json`: default English UI.
- `_locales/zh_CN/messages.json`: Simplified Chinese UI.
- `_locales/zh_TW/messages.json`: Traditional Chinese UI.

Chrome selects the locale from the browser UI language. Chrome usually follows the OS language unless the user overrides Chrome's language settings.

## Tests And Diagnostics

Syntax and manifest/locale JSON validation:

```powershell
node --check background.js
node --check content.js
node --check popup.js
```

Extension smoke test:

```powershell
node scripts/smoke-test.mjs
```

If the installed Chrome build or enterprise policy blocks command-line `--load-extension`, this smoke test cannot represent manual unpacked-extension loading.

In-page visual regression:

```powershell
node scripts/in-page-bypass-visual-test.mjs
```

VSR/non-VSR output comparison:

```powershell
node scripts/output-compare-test.mjs
```

Smooth Motion cadence diagnostic:

```powershell
node scripts/smooth-overlay-diagnostic.mjs
```

Common environment variables:

```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:YOUTUBE_TEST_URL = "https://www.youtube.com/watch?v=VIDEO_ID"
$env:SMOOTH_DIAG_CAPTURE_SECONDS = "8"
$env:SMOOTH_DIAG_CAPTURE_FPS = "120"
```

## Versioning

Release versions must stay consistent across:

- `VERSION`
- `manifest.json` `version`
- `native-host/Program.cs` `HostVersion`
- Git tag, for example `v0.1.1`

The packaging script checks these values and fails if they do not match.

## Build A Release Package

Generate a local Windows x64 release package:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1
```

Outputs:

- `artifacts/release/geforce-video-enhance-<version>-win-x64/`
- `artifacts/release/geforce-video-enhance-<version>-win-x64.zip`

`artifacts/` is generated output and is intentionally ignored by git.

## GitHub CI And Release

The repository includes two GitHub Actions workflows:

- `.github/workflows/ci.yml`: runs on `main` pushes and pull requests. It validates JSON/JS syntax, builds the native host, builds the native presenter, verifies release packaging, and uploads the zip as a CI artifact.
- `.github/workflows/release.yml`: runs on `v*` tags and creates a GitHub Release with the Windows x64 zip.

Standard release flow:

```powershell
git checkout main
git pull
# Update VERSION, manifest.json, native-host/Program.cs, and CHANGELOG.md
powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1
git add .
git commit -m "Release v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push origin main --follow-tags
```

Pushing the tag triggers GitHub Actions release publishing. The release workflow can also be run manually.

## Repository Layout

- `manifest.json`: extension manifest.
- `_locales/`: extension localization resources.
- `background.js`: native messaging and overlay lifecycle management.
- `content.js`: YouTube player controls, state machine, and overlay sync logic.
- `content.css`: player button, toast, and comparison-mode styles.
- `popup.html` / `popup.css` / `popup.js`: extension popup.
- `native-host/`: Windows native messaging host.
- `native-presenter/`: WGC + D3D11 presenter.
- `scripts/`: install, package, diagnostic, and regression scripts.
- `release/`: release package installer and README templates.
- `poc/`: historical experiment source; build output is ignored.
