import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const chromePath = process.env.CHROME_PATH || findChrome();
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const testUrl = process.env.YOUTUBE_TEST_URL || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const captureSeconds = Number(process.env.SMOOTH_MOTION_CAPTURE_SECONDS || 6);
const captureFps = Number(process.env.SMOOTH_MOTION_CAPTURE_FPS || 120);
const artifactRoot = path.resolve("artifacts", `smooth-motion-cadence-${timestampForPath(new Date())}`);

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to chrome.exe and run again.");
}

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  throw new Error("This cadence test requires Node.js 22+ with global WebSocket and fetch.");
}

const chromeCases = [
  {
    name: "baseline",
    args: []
  },
  {
    name: "dcomp-off-d3d11",
    args: ["--disable-direct-composition", "--use-angle=d3d11"]
  },
  {
    name: "dcomp-off-vulkan",
    args: [
      "--disable-direct-composition",
      "--use-angle=vulkan",
      "--enable-features=Vulkan,DefaultANGLEVulkan,VulkanFromANGLE"
    ]
  }
];

const selectedCaseNames = (process.env.SMOOTH_MOTION_CASES || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const selectedChromeCases = selectedCaseNames.length
  ? chromeCases.filter((testCase) => selectedCaseNames.includes(testCase.name))
  : chromeCases;

function findChrome() {
  const candidates = [
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LocalAppData || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LocalAppData || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForJson(url, timeoutMs = 20000) {
  const started = Date.now();
  let lastError;

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return await response.json();
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    await sleep(250);
  }

  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();

    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }

      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || JSON.stringify(message.error)));
      } else {
        resolve(message.result || {});
      }
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId;
    this.nextId += 1;

    const payload = { id, method, params };
    if (sessionId) {
      payload.sessionId = sessionId;
    }

    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.ws.send(JSON.stringify(payload));
    return promise;
  }

  close() {
    this.ws.close();
  }
}

async function attachTarget(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise,
      returnByValue: true
    },
    sessionId
  );

  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }

  return result.result.value;
}

function withAutoplay(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("autoplay", "1");
  parsed.searchParams.set("mute", "1");
  return parsed.toString();
}

async function findYoutubeTarget(port) {
  const started = Date.now();
  while (Date.now() - started < 30000) {
    const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, 5000);
    const found = targets.find((target) => target.type === "page" && /youtube\.com\/watch/.test(target.url));
    if (found) {
      return found;
    }
    await sleep(500);
  }

  throw new Error("Timed out waiting for the YouTube app target.");
}

async function preparePlayer(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const started = Date.now();
      let video = null;
      while (Date.now() - started < 45000) {
        video = document.querySelector("video");
        if (video && video.readyState >= 2 && video.videoWidth > 0) {
          break;
        }
        await wait(500);
      }

      if (!video) {
        return { ok: false, reason: "no-video" };
      }

      let style = document.querySelector("#sm-cadence-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "sm-cadence-style";
        document.documentElement.append(style);
      }

      style.textContent = \`
        html, body, ytd-app {
          margin: 0 !important;
          overflow: hidden !important;
          background: #000 !important;
        }
        #masthead-container,
        #secondary,
        #below,
        #comments,
        ytd-miniplayer,
        .ytp-chrome-top,
        .ytp-chrome-bottom,
        .ytp-gradient-top,
        .ytp-gradient-bottom,
        .ytp-spinner,
        .ytp-pause-overlay,
        .ytp-cards-teaser,
        .ytp-ce-element,
        .ytp-title,
        .ytp-ad-overlay-container,
        .ytp-paid-content-overlay {
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
        ytd-watch-flexy,
        #page-manager,
        #columns,
        #primary,
        #primary-inner,
        #player,
        #player-container-outer,
        #player-container-inner,
        #player-container,
        #movie_player {
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          min-width: 0 !important;
          min-height: 0 !important;
          max-width: none !important;
          max-height: none !important;
          margin: 0 !important;
          padding: 0 !important;
          background: #000 !important;
          transform: none !important;
          z-index: 2147483647 !important;
        }
        video {
          position: fixed !important;
          inset: 0 !important;
          width: 100vw !important;
          height: 100vh !important;
          object-fit: contain !important;
          background: #000 !important;
        }
      \`;

      video.muted = true;
      video.volume = 0;
      if (video.readyState < 2) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 8000);
          video.addEventListener("loadeddata", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }

      if (Number.isFinite(video.duration) && video.duration > 20) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 5000);
          video.addEventListener("seeked", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
          video.currentTime = 20;
        });
      }

      try {
        await video.play();
      } catch {
        document.querySelector("#movie_player")?.click?.();
        await wait(500);
        await video.play().catch(() => {});
      }

      await wait(3000);
      return {
        ok: !video.paused,
        paused: video.paused,
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        playbackQuality: document.querySelector("#movie_player")?.getPlaybackQuality?.() ?? null,
        totalVideoFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
        droppedVideoFrames: video.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
        innerWidth,
        innerHeight,
        outerWidth,
        outerHeight,
        devicePixelRatio,
        screenX,
        screenY
      };
    })()`,
    true
  );
}

function getChromeProcessTree(rootPid) {
  const script = `
    $root = ${rootPid};
    $seen = @{};
    $queue = New-Object System.Collections.Generic.Queue[int];
    $queue.Enqueue([int]$root)
    while ($queue.Count -gt 0) {
      $currentPid = $queue.Dequeue();
      if ($seen.ContainsKey($currentPid)) { continue }
      $seen[$currentPid] = $true;
      Get-CimInstance Win32_Process -Filter "ParentProcessId = $currentPid" |
        Where-Object { $_.Name -eq 'chrome.exe' } |
        ForEach-Object { $queue.Enqueue([int]$_.ProcessId) };
    }
    Get-Process chrome -ErrorAction SilentlyContinue |
      Where-Object { $seen.ContainsKey([int]$_.Id) } |
      Select-Object Id, MainWindowHandle, MainWindowTitle |
      ConvertTo-Json -Compress
  `;

  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8"
    }).trim();
    if (!output) {
      return [];
    }
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function getWindowRect(pid, candidatePids) {
  const pidList = candidatePids.map((candidatePid) => Number(candidatePid)).filter(Boolean).join(",");
  const script = `
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Cadence {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
}
"@
    $candidatePids = @(${pidList || pid})
    $p = $null
    foreach ($candidatePid in $candidatePids) {
      $candidate = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
      if ($candidate -and $candidate.MainWindowHandle -ne [IntPtr]::Zero) {
        $p = $candidate
        break
      }
    }
    if ($null -eq $p) {
      Start-Sleep -Milliseconds 500
      foreach ($candidatePid in $candidatePids) {
        $candidate = Get-Process -Id $candidatePid -ErrorAction SilentlyContinue
        if ($candidate) {
          $candidate.Refresh()
          if ($candidate.MainWindowHandle -ne [IntPtr]::Zero) {
            $p = $candidate
            break
          }
        }
      }
    }
    if ($null -eq $p) {
      $p = Get-Process -Id ${pid} -ErrorAction Stop
    }
    $handle = $p.MainWindowHandle
    $rect = New-Object Win32Cadence+RECT
    [Win32Cadence]::GetWindowRect($handle, [ref]$rect) | Out-Null
    $dwm = New-Object Win32Cadence+RECT
    $dwmCode = [Win32Cadence]::DwmGetWindowAttribute($handle, 9, [ref]$dwm, [Runtime.InteropServices.Marshal]::SizeOf([type][Win32Cadence+RECT]))
    [pscustomobject]@{
      Pid = $p.Id
      Handle = $handle.ToInt64()
      Left = $rect.Left
      Top = $rect.Top
      Right = $rect.Right
      Bottom = $rect.Bottom
      Width = $rect.Right - $rect.Left
      Height = $rect.Bottom - $rect.Top
      DwmCode = $dwmCode
      DwmLeft = $dwm.Left
      DwmTop = $dwm.Top
      DwmRight = $dwm.Right
      DwmBottom = $dwm.Bottom
      DwmWidth = $dwm.Right - $dwm.Left
      DwmHeight = $dwm.Bottom - $dwm.Top
    } | ConvertTo-Json -Compress
  `;

  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8"
  }).trim();
  return JSON.parse(output);
}

function processLoadsModule(pid, moduleName) {
  try {
    const output = execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/M", moduleName], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.toLowerCase().includes(moduleName.toLowerCase());
  } catch {
    return false;
  }
}

function processesLoadingModule(pids, moduleName) {
  return pids
    .map((pid) => ({ pid: Number(pid), loaded: processLoadsModule(pid, moduleName) }))
    .filter((entry) => entry.loaded);
}

const analysisWidth = 160;
const analysisHeight = 90;

async function captureFrameData(rect, outputPath) {
  const left = Math.max(0, Math.round(rect.DwmCode === 0 ? rect.DwmLeft : rect.Left));
  const top = Math.max(0, Math.round(rect.DwmCode === 0 ? rect.DwmTop : rect.Top));
  const width = Math.max(64, Math.round(rect.DwmCode === 0 ? rect.DwmWidth : rect.Width));
  const height = Math.max(64, Math.round(rect.DwmCode === 0 ? rect.DwmHeight : rect.Height));
  const evenWidth = width - (width % 2);
  const evenHeight = height - (height % 2);
  const cropWidth = Math.max(64, Math.floor(evenWidth * 0.55 / 2) * 2);
  const cropHeight = Math.max(64, Math.floor(evenHeight * 0.55 / 2) * 2);
  const cropX = Math.floor((evenWidth - cropWidth) / 2 / 2) * 2;
  const cropY = Math.floor((evenHeight - cropHeight) / 2 / 2) * 2;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-y",
    "-f",
    "gdigrab",
    "-draw_mouse",
    "0",
    "-framerate",
    String(captureFps),
    "-offset_x",
    String(left),
    "-offset_y",
    String(top),
    "-video_size",
    `${evenWidth}x${evenHeight}`,
    "-t",
    String(captureSeconds),
    "-i",
    "desktop",
    "-vf",
    `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=${analysisWidth}:${analysisHeight},format=gray`,
    "-frames:v",
    String(Math.ceil(captureSeconds * captureFps)),
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    outputPath
  ];

  const result = await spawnSyncText(ffmpegPath, args, (captureSeconds + 12) * 1000);
  return {
    command: `${ffmpegPath} ${args.join(" ")}`,
    rectUsed: { left, top, width: evenWidth, height: evenHeight, cropWidth, cropHeight, cropX, cropY },
    code: result.code,
    stdout: result.stdout.slice(-4000),
    stderr: result.stderr.slice(-4000)
  };
}

function spawnSyncText(command, args, timeoutMs) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  return waitForExitWithTimeout(child, timeoutMs).then((code) => ({ code, stdout, stderr }));
}

function waitForExitWithTimeout(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve("timeout");
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function summarizeRawFrames(filePath) {
  const frameSize = analysisWidth * analysisHeight;
  const buffer = fs.existsSync(filePath) ? fs.readFileSync(filePath) : Buffer.alloc(0);
  const frameCount = Math.floor(buffer.length / frameSize);
  const hashes = [];
  const diffs = [];

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const frameStart = frameIndex * frameSize;
    const frame = buffer.subarray(frameStart, frameStart + frameSize);
    hashes.push(fnv1aHex(frame));

    if (frameIndex > 0) {
      const previousStart = (frameIndex - 1) * frameSize;
      let sumAbs = 0;
      for (let offset = 0; offset < frameSize; offset += 1) {
        sumAbs += Math.abs(buffer[previousStart + offset] - buffer[frameStart + offset]);
      }
      diffs.push(sumAbs / frameSize);
    }
  }

  let adjacentRepeats = 0;
  const runs = [];
  let currentRun = 0;
  let previous = null;

  for (const hash of hashes) {
    if (hash === previous) {
      adjacentRepeats += 1;
      currentRun += 1;
    } else {
      if (currentRun > 0) {
        runs.push(currentRun + 1);
      }
      currentRun = 0;
    }
    previous = hash;
  }

  if (currentRun > 0) {
    runs.push(currentRun + 1);
  }

  const uniqueCount = new Set(hashes).size;
  const maxRun = runs.length ? Math.max(...runs) : 1;
  const averageRepeatedRun = runs.length
    ? runs.reduce((sum, run) => sum + run, 0) / runs.length
    : 1;
  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const quantile = (q) => {
    if (!sortedDiffs.length) {
      return null;
    }
    const index = Math.min(sortedDiffs.length - 1, Math.max(0, Math.floor(q * (sortedDiffs.length - 1))));
    return sortedDiffs[index];
  };
  const nearRepeatThresholds = [0.1, 0.25, 0.5, 1, 2, 4].map((threshold) => {
    const count = diffs.filter((diff) => diff <= threshold).length;
    return {
      threshold,
      count,
      ratio: diffs.length ? count / diffs.length : null
    };
  });

  return {
    frames: hashes.length,
    uniqueFrames: uniqueCount,
    adjacentRepeats,
    adjacentRepeatRatio: hashes.length > 1 ? adjacentRepeats / (hashes.length - 1) : null,
    repeatedRuns: runs.length,
    maxRepeatedRun: maxRun,
    averageRepeatedRun,
    meanAbsDiff: diffs.length ? diffs.reduce((sum, diff) => sum + diff, 0) / diffs.length : null,
    diffP10: quantile(0.1),
    diffP50: quantile(0.5),
    diffP90: quantile(0.9),
    diffP99: quantile(0.99),
    nearRepeatThresholds,
    firstHashes: hashes.slice(0, 12)
  };
}

function fnv1aHex(buffer) {
  let hash = 0x811c9dc5;
  for (const byte of buffer) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

async function runCase(testCase) {
  const caseDir = path.join(artifactRoot, testCase.name);
  fs.mkdirSync(caseDir, { recursive: true });

  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `sm-cadence-${testCase.name}-`));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1",
    "--window-position=0,0",
    "--window-size=1280,720",
    ...testCase.args,
    `--app=${withAutoplay(testUrl)}`
  ];

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = {
    name: testCase.name,
    args: testCase.args,
    profile,
    chromePid: chrome.pid
  };

  let cdp = null;
  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();

    const target = await findYoutubeTarget(port);
    const sessionId = await attachTarget(cdp, target.id);
    await cdp.send("Page.bringToFront", {}, sessionId);
    await sleep(3000);
    result.player = await preparePlayer(cdp, sessionId);
    await sleep(1000);

    result.processTree = getChromeProcessTree(chrome.pid);
    const candidatePids = result.processTree.map((processInfo) => processInfo.Id || processInfo.id || processInfo.ProcessId);
    result.windowRect = getWindowRect(chrome.pid, candidatePids);
    result.nvPresentLoaded = processesLoadingModule(candidatePids, "NvPresent64.dll");

    const rawFramePath = path.join(caseDir, "capture-160x90-gray.raw");
    result.capture = await captureFrameData(result.windowRect, rawFramePath);
    result.cadence = summarizeRawFrames(rawFramePath);
    result.rawFramePath = rawFramePath;
  } catch (error) {
    result.error = error.stack || error.message;
  } finally {
    if (cdp) {
      cdp.close();
    }
    chrome.kill();
    await sleep(1000);
    killChromeProcessTree(chrome.pid);
    await sleep(500);
    result.profileCleanup = await removeProfileWithRetry(profile);
    if (stderr.trim()) {
      fs.writeFileSync(path.join(caseDir, "chrome-stderr.txt"), stderr);
      result.chromeStderrTail = stderr.split(/\r?\n/).slice(-12);
    }
  }

  return result;
}

function killChromeProcessTree(rootPid) {
  for (const processInfo of getChromeProcessTree(rootPid).sort((a, b) => Number(b.Id || b.id) - Number(a.Id || a.id))) {
    const pid = Number(processInfo.Id || processInfo.id);
    if (!pid) {
      continue;
    }

    try {
      execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Chrome may already be gone.
    }
  }
}

async function removeProfileWithRetry(profile) {
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
      return { removed: true, attempt };
    } catch (error) {
      if (attempt === 6) {
        return { removed: false, reason: error.code || error.message, profile };
      }

      await sleep(500 * attempt);
    }
  }

  return { removed: false, reason: "unknown", profile };
}

async function main() {
  fs.mkdirSync(artifactRoot, { recursive: true });

  const results = [];
  for (const testCase of selectedChromeCases) {
    console.error(`Running cadence case: ${testCase.name}`);
    results.push(await runCase(testCase));
  }

  const summary = {
    createdAt: new Date().toISOString(),
    chromePath,
    ffmpegPath,
    testUrl,
    captureSeconds,
    captureFps,
    artifactRoot,
    results
  };
  const summaryPath = path.join(artifactRoot, "summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
