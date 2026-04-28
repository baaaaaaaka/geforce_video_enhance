# GeForce Video Enhance

[English README](README.md)

`geforce_video_enhance` 是一个实验性的 Chrome/Edge 扩展，用来在 YouTube 播放器里调试和切换 NVIDIA RTX 视频增强相关路径。当前版本是 `0.1.1`。

它包含三部分：

- Manifest V3 扩展：向 YouTube 播放器注入 VSR、对比模式和 Smooth Motion 控制按钮。
- Windows native messaging host：让扩展可以启动、同步、关闭本机 presenter。
- WGC + D3D11 presenter：实验性承接 NVIDIA Smooth Motion 的 overlay 路线。

## 功能状态

- `VSR`：显示 YouTube 原生 `<video>`，让 Chrome/NVIDIA 默认视频处理路径接管。
- `non-VSR`：同页 canvas bypass 路径，用于把可见输出从原生 video layer 切到 canvas。该模式仍需要原 `<video>` 解码，不会停止 YouTube 播放链。
- 对比模式：播放器中间显示可拖动竖线，一侧走原生 video layer，一侧走 canvas bypass，方便观察输出差异。
- Smooth Motion overlay：由 native host 启动内置 `smooth-presenter.exe`，使用 Windows Graphics Capture 捕获 Chrome 播放器区域，再由独立 D3D11 flip-model 窗口重放到同一位置。
- 本地化：扩展 UI 使用 Chrome `_locales`。默认语言是英文；Chrome UI 语言为中文时使用中文。

Chrome 扩展不能直接修改 NVIDIA App、驱动或控制面板里的全局开关。要让 VSR 或 Smooth Motion 真正生效，必须先在 NVIDIA App/驱动里为浏览器或 presenter 所走的程序路径打开对应功能。

## 已知限制

- Smooth Motion overlay 是实验性功能。为了保留 YouTube 原生控件体验，用户与播放器交互时 overlay 会短暂隐藏，交互结束后再恢复。
- Windows Graphics Capture 可能显示系统级捕获边框；是否能隐藏取决于系统权限和 Windows 策略。
- DevTools 截图不一定能捕获最终显示链路中的 GPU 后处理。判断 Smooth Motion 是否真的生效时，应优先使用 cadence 诊断或外部屏幕采集。
- 当前 release 是未签名、未上架 Chrome Web Store 的 unpacked extension。

## 从 GitHub Release 安装

1. 打开 GitHub Release 页面：`https://github.com/baaaaaaaka/geforce_video_enhance/releases`
2. 下载 `geforce-video-enhance-<version>-win-x64.zip`。
3. 解压到稳定目录。安装后不要移动或删除该目录。
4. 在解压目录打开 PowerShell，执行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

5. 打开 `chrome://extensions/` 或 `edge://extensions/`。
6. 开启开发者模式。
7. 点击 `加载已解压的扩展程序` / `Load unpacked`，选择 release 里的 `extension` 目录。
8. 打开或刷新 YouTube 视频页，播放器控制栏会出现扩展按钮。

卸载：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\uninstall.ps1
```

然后在 `chrome://extensions/` 中移除 unpacked extension。

## 从源码开发安装

### 环境要求

- Windows 10/11 x64。
- Google Chrome 或 Microsoft Edge。
- NVIDIA GPU、驱动和 NVIDIA App，并在驱动侧启用需要测试的 VSR/Smooth Motion 功能。
- .NET SDK 5.0。
- Visual Studio 2022 Build Tools，包含 C++ 桌面开发工具链。
- CMake。
- Node.js 22 或更新版本，用于运行诊断脚本。
- GitHub CLI 仅在发布到 GitHub 时需要。

### 构建并注册 native host

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-native-host.ps1
```

该脚本会：

- 构建 `native-presenter/smooth-presenter.exe`。
- 发布 `native-host/rtx-vsr-native-host.exe`。
- 写入 native messaging host manifest。
- 在 HKCU 下注册 Chrome/Edge native messaging host。
- 根据 `manifest.json` 的固定 key 计算扩展 ID。

然后在 `chrome://extensions/` 里加载本仓库根目录作为 unpacked extension。

源码开发卸载：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall-native-host.ps1
```

## 使用说明

- YouTube 播放器右下角的 `VSR` 按钮用于在原生 video layer 和 non-VSR canvas bypass 之间切换。
- 分割线按钮用于打开对比模式；拖动竖线可以调整左右两侧比例。
- Smooth Motion 按钮用于启动或关闭 native overlay。
- overlay 开启后，扩展会同步播放器位置、可见性、窗口移动、暂停/播放状态和 seek 状态。
- 鼠标、键盘、触摸或滚轮交互时，overlay 会短暂隐藏以让 YouTube 原生控件可用；交互结束后恢复 overlay。

## 本地化

扩展使用 Chrome 标准 `_locales` 机制：

- `_locales/en/messages.json`：默认英文 UI。
- `_locales/zh_CN/messages.json`：简体中文 UI。
- `_locales/zh_TW/messages.json`：繁体中文 UI。

Chrome 根据浏览器 UI 语言选择 locale。Chrome 通常跟随系统语言；如果用户手动改过 Chrome 语言，则以 Chrome 设置为准。

## 测试和诊断

语法检查和 manifest/locale JSON 校验：

```powershell
node --check background.js
node --check content.js
node --check popup.js
```

扩展 smoke test：

```powershell
node scripts/smoke-test.mjs
```

如果当前 Chrome 版本或企业策略屏蔽命令行 `--load-extension`，这个 smoke test 不能代表手动加载 unpacked extension 的结果。

同页视觉回归：

```powershell
node scripts/in-page-bypass-visual-test.mjs
```

VSR/non-VSR 输出对比：

```powershell
node scripts/output-compare-test.mjs
```

Smooth Motion cadence 诊断：

```powershell
node scripts/smooth-overlay-diagnostic.mjs
```

常用环境变量：

```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$env:YOUTUBE_TEST_URL = "https://www.youtube.com/watch?v=VIDEO_ID"
$env:SMOOTH_DIAG_CAPTURE_SECONDS = "8"
$env:SMOOTH_DIAG_CAPTURE_FPS = "120"
```

## 版本管理

版本号集中在这些位置，发布前必须保持一致：

- `VERSION`
- `manifest.json` 的 `version`
- `native-host/Program.cs` 的 `HostVersion`
- Git tag，例如 `v0.1.1`

打包脚本会检查这些版本是否一致，不一致会直接失败。

## 打包 release

本地生成 Windows x64 release 包：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1
```

输出位于：

- `artifacts/release/geforce-video-enhance-<version>-win-x64/`
- `artifacts/release/geforce-video-enhance-<version>-win-x64.zip`

`artifacts/` 是生成物，不进入 git。

## GitHub CI 和 Release

仓库包含两个 GitHub Actions workflow：

- `.github/workflows/ci.yml`：在 `main` push 和 PR 上运行 JSON/JS 语法检查、native host build、native presenter build、release packaging 验证，并上传 zip artifact。
- `.github/workflows/release.yml`：在推送 `v*` tag 时构建 release zip，并创建 GitHub Release。

标准发布流程：

```powershell
git checkout main
git pull
# 修改 VERSION、manifest.json、native-host/Program.cs，并更新 CHANGELOG.md
powershell -ExecutionPolicy Bypass -File scripts\package-release.ps1
git add .
git commit -m "Release v0.1.1"
git tag -a v0.1.1 -m "v0.1.1"
git push origin main --follow-tags
```

tag push 后 GitHub Actions 会自动创建 release。也可以手动运行 release workflow。

## 文件结构

- `manifest.json`：扩展清单。
- `_locales/`：扩展本地化资源。
- `background.js`：native messaging 和 overlay 生命周期管理。
- `content.js`：注入 YouTube 播放器按钮、状态机和 overlay 同步逻辑。
- `content.css`：播放器按钮、提示和对比模式样式。
- `popup.html` / `popup.css` / `popup.js`：扩展弹窗。
- `native-host/`：Windows native messaging host。
- `native-presenter/`：WGC + D3D11 presenter。
- `scripts/`：安装、打包、诊断和回归测试脚本。
- `release/`：发布包内安装脚本和 release README 模板。
- `poc/`：历史实验代码，仅保留源码，构建输出被忽略。
