import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const chromePath = process.env.CHROME_PATH || findChrome();
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const testUrl = process.env.YOUTUBE_TEST_URL || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const captureSeconds = Number(process.env.SMOOTH_DIAG_CAPTURE_SECONDS || 6);
const captureFps = Number(process.env.SMOOTH_DIAG_CAPTURE_FPS || 120);
const sourceMeasureMs = Number(process.env.SMOOTH_DIAG_SOURCE_MS || 4000);
const artifactRoot = path.join(repoRoot, "artifacts", `smooth-overlay-diagnostic-${timestampForPath(new Date())}`);
const nativeHostPath = path.join(repoRoot, "native-host", "bin", "publish", "rtx-vsr-native-host.exe");

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to chrome.exe and run again.");
}

if (!fs.existsSync(nativeHostPath)) {
  throw new Error("Native host was not found. Run scripts/install-native-host.ps1 first.");
}

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  throw new Error("This diagnostic requires Node.js 22+ with global WebSocket and fetch.");
}

function findChrome() {
  const candidates = [
    path.join(process.env["ProgramFiles(x86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.ProgramFiles || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LocalAppData || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe")
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
  let lastError = null;

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

class NativeHost {
  constructor(exePath) {
    this.child = spawn(exePath, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.stderr = "";

    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readInt32LE(0);
        if (this.buffer.length < 4 + length) {
          break;
        }

        const payload = this.buffer.slice(4, 4 + length).toString("utf8");
        this.buffer = this.buffer.slice(4 + length);
        const resolve = this.pending.shift();
        if (resolve) {
          resolve(JSON.parse(payload));
        }
      }
    });

    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
  }

  send(message, timeoutMs = 30000) {
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.alloc(4);
    header.writeInt32LE(payload.length, 0);
    this.child.stdin.write(Buffer.concat([header, payload]));

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Native host timed out.")), timeoutMs);
      this.pending.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  close() {
    try {
      this.child.stdin.end();
    } catch {
      // Ignore shutdown races.
    }
    this.child.kill();
  }
}

async function attachTarget(cdp, targetId) {
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  return sessionId;
}

async function evaluate(cdp, sessionId, expression, awaitPromise = false) {
  const started = Date.now();

  while (true) {
    try {
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
    } catch (error) {
      const message = error?.message || String(error);
      if (!/execution context|Cannot find context|Inspected target navigated/i.test(message) || Date.now() - started > 12000) {
        throw error;
      }

      await sleep(300);
    }
  }
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

  throw new Error("Timed out waiting for the YouTube page.");
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

      let style = document.querySelector("#smooth-overlay-diagnostic-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "smooth-overlay-diagnostic-style";
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
          z-index: 2147483640 !important;
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
        droppedVideoFrames: video.getVideoPlaybackQuality?.().droppedVideoFrames ?? null
      };
    })()`,
    true
  );
}

async function getPlayerState(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const video = document.querySelector("video");
      if (!video) {
        return { ok: false, reason: "no-video" };
      }

      const player = document.querySelector(".html5-video-player") || video.closest(".html5-video-container") || video;
      const rect = player.getBoundingClientRect();
      const borderX = Math.max(0, (outerWidth - innerWidth) / 2);
      const topChrome = Math.max(0, outerHeight - innerHeight - borderX);
      const scale = Math.max(devicePixelRatio || 1, 1);

      return {
        ok: rect.width >= 16 && rect.height >= 16,
        url: location.href,
        rect: {
          x: Math.round((screenX + borderX + rect.left) * scale),
          y: Math.round((screenY + topChrome + rect.top) * scale),
          width: Math.max(1, Math.round(rect.width * scale)),
          height: Math.max(1, Math.round(rect.height * scale))
        },
        cssRect: {
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height
        },
        screen: { screenX, screenY, innerWidth, innerHeight, outerWidth, outerHeight, devicePixelRatio },
        playback: {
          currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
          paused: Boolean(video.paused || video.ended),
          volume: Number.isFinite(video.volume) ? video.volume : 1,
          muted: Boolean(video.muted),
          playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
          seekSerial: 1,
          visible: true
        }
      };
    })()`
  );
}

async function measureSourceCadence(cdp, sessionId, durationMs) {
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const video = document.querySelector("video");
      if (!video) {
        return { ok: false, reason: "no-video" };
      }

      const qualityStart = video.getVideoPlaybackQuality?.() ?? null;
      const startedAt = performance.now();
      const startedTotal = qualityStart?.totalVideoFrames ?? null;
      const samples = [];

      if (typeof video.requestVideoFrameCallback === "function") {
        await new Promise((resolve) => {
          const deadline = startedAt + ${Number(durationMs)};
          const onFrame = (now, metadata) => {
            samples.push({
              now,
              mediaTime: metadata.mediaTime,
              presentedFrames: metadata.presentedFrames,
              expectedDisplayTime: metadata.expectedDisplayTime
            });

            if (performance.now() >= deadline) {
              resolve();
              return;
            }

            video.requestVideoFrameCallback(onFrame);
          };

          video.requestVideoFrameCallback(onFrame);
          setTimeout(resolve, ${Number(durationMs)} + 1000);
        });
      } else {
        await new Promise((resolve) => setTimeout(resolve, ${Number(durationMs)}));
      }

      const endedAt = performance.now();
      const qualityEnd = video.getVideoPlaybackQuality?.() ?? null;
      const elapsedSeconds = Math.max(0.001, (endedAt - startedAt) / 1000);
      const rvfcFirst = samples[0] || null;
      const rvfcLast = samples[samples.length - 1] || null;
      const rvfcFrames = rvfcFirst && rvfcLast
        ? Math.max(0, rvfcLast.presentedFrames - rvfcFirst.presentedFrames)
        : 0;
      const qualityFrames = startedTotal != null && qualityEnd?.totalVideoFrames != null
        ? Math.max(0, qualityEnd.totalVideoFrames - startedTotal)
        : null;

      return {
        ok: true,
        elapsedSeconds,
        rvfcSamples: samples.length,
        rvfcFrames,
        rvfcHz: rvfcFrames ? rvfcFrames / elapsedSeconds : null,
        qualityFrames,
        qualityHz: qualityFrames != null ? qualityFrames / elapsedSeconds : null,
        firstSamples: samples.slice(0, 6),
        lastSamples: samples.slice(-6)
      };
    })()`,
    true
  );
}

function verifyFfmpeg() {
  try {
    execFileSync(ffmpegPath, ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function moveCursorAway(rect) {
  const x = rect.x > 120 ? rect.x - 80 : rect.x + rect.width + 80;
  const y = rect.y > 120 ? rect.y - 80 : rect.y + rect.height + 80;
  const script = `
    Add-Type @"
using System.Runtime.InteropServices;
public static class CursorMover {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int x, int y);
}
"@
    [CursorMover]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null
  `;

  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  } catch {
    // Cursor movement is best-effort; diagnostics can still run.
  }
}

async function captureScreenRegion(label, rect) {
  const caseDir = path.join(artifactRoot, label);
  fs.mkdirSync(caseDir, { recursive: true });

  const width = Math.max(64, Math.round(rect.width) - (Math.round(rect.width) % 2));
  const height = Math.max(64, Math.round(rect.height) - (Math.round(rect.height) % 2));
  const cropWidth = Math.max(64, Math.floor(width * 0.56 / 2) * 2);
  const cropHeight = Math.max(64, Math.floor(height * 0.56 / 2) * 2);
  const cropX = Math.floor((width - cropWidth) / 2 / 2) * 2;
  const cropY = Math.floor((height - cropHeight) / 2 / 2) * 2;
  const rawPath = path.join(caseDir, "capture-160x90-gray.raw");
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
    String(Math.round(rect.x)),
    "-offset_y",
    String(Math.round(rect.y)),
    "-video_size",
    `${width}x${height}`,
    "-t",
    String(captureSeconds),
    "-i",
    "desktop",
    "-vf",
    `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=160:90,format=gray`,
    "-frames:v",
    String(Math.ceil(captureSeconds * captureFps)),
    "-fps_mode",
    "passthrough",
    "-f",
    "rawvideo",
    rawPath
  ];

  const startedAt = performance.now();
  const capture = await spawnText(ffmpegPath, args, (captureSeconds + 12) * 1000);
  const elapsedSeconds = Math.max(0.001, (performance.now() - startedAt) / 1000);
  const cadence = summarizeRawFrames(rawPath, elapsedSeconds);
  const result = {
    label,
    command: `${ffmpegPath} ${args.join(" ")}`,
    rectUsed: { x: Math.round(rect.x), y: Math.round(rect.y), width, height, cropWidth, cropHeight, cropX, cropY },
    rawPath,
    capture: {
      code: capture.code,
      stdoutTail: capture.stdout.slice(-4000),
      stderrTail: capture.stderr.slice(-4000)
    },
    cadence
  };

  fs.writeFileSync(path.join(caseDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

function spawnText(command, args, timeoutMs) {
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

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: "timeout", stdout, stderr });
    }, timeoutMs);

    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function summarizeRawFrames(filePath, elapsedSeconds) {
  const frameSize = 160 * 90;
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

  const durationSeconds = frameCount ? elapsedSeconds : 0;
  const exactRepeats = hashes.slice(1).filter((hash, index) => hash === hashes[index]).length;
  const sortedDiffs = [...diffs].sort((a, b) => a - b);
  const quantile = (q) => {
    if (!sortedDiffs.length) {
      return null;
    }
    const index = Math.min(sortedDiffs.length - 1, Math.max(0, Math.floor(q * (sortedDiffs.length - 1))));
    return sortedDiffs[index];
  };
  const thresholds = [0.25, 0.5, 1, 2, 4, 8].map((threshold) => {
    const changed = diffs.filter((diff) => diff > threshold).length;
    return {
      threshold,
      changed,
      changedRatio: diffs.length ? changed / diffs.length : null,
      changeHz: durationSeconds ? changed / durationSeconds : null
    };
  });
  const threshold1 = thresholds.find((entry) => entry.threshold === 1);

  return {
    frames: frameCount,
    durationSeconds,
    sampleFps: durationSeconds ? frameCount / durationSeconds : null,
    uniqueExactFrames: new Set(hashes).size,
    exactRepeats,
    exactRepeatRatio: frameCount > 1 ? exactRepeats / (frameCount - 1) : null,
    meanAbsDiff: diffs.length ? diffs.reduce((sum, diff) => sum + diff, 0) / diffs.length : null,
    diffP10: quantile(0.1),
    diffP50: quantile(0.5),
    diffP90: quantile(0.9),
    diffP99: quantile(0.99),
    thresholds,
    visualChangeHzAt1: threshold1?.changeHz ?? null,
    firstHashes: hashes.slice(0, 10)
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

function classify(source, baseline, overlay, nativeResponse, nvPresentLoaded) {
  const sourceHz = source.rvfcHz || source.qualityHz;
  const baselineHz = baseline?.cadence?.visualChangeHzAt1 ?? null;
  const overlayHz = overlay?.cadence?.visualChangeHzAt1 ?? null;
  const minUsefulCaptureHz = sourceHz ? sourceHz * 1.5 : 45;
  const captureOk = overlay?.cadence?.sampleFps == null || overlay.cadence.sampleFps >= minUsefulCaptureHz;

  const thresholdHz = sourceHz ? Math.max(sourceHz * 1.35, sourceHz + 8) : null;
  const chromeLikelyInterpolated = Boolean(sourceHz && baselineHz && baselineHz >= thresholdHz);
  const presenterLikelyInterpolated = Boolean(sourceHz && overlayHz && overlayHz >= thresholdHz);
  const presenterAddsCadence = Boolean(baselineHz && overlayHz && overlayHz >= baselineHz * 1.2 && overlayHz - baselineHz >= 8);

  let verdict = "unknown";
  if (!captureOk) {
    verdict = "capture_fps_too_low";
  } else if (!nativeResponse?.ok) {
    verdict = "presenter_failed_to_start";
  } else if (!nvPresentLoaded) {
    verdict = "nvpresent_not_loaded";
  } else if (presenterLikelyInterpolated) {
    verdict = chromeLikelyInterpolated && !presenterAddsCadence
      ? "smooth_motion_observed_but_chrome_baseline_already_interpolated"
      : "smooth_motion_observed_on_presenter";
  } else {
    verdict = "hook_loaded_but_interpolation_not_observed";
  }

  return {
    verdict,
    sourceHz,
    baselineHz,
    overlayHz,
    thresholdHz,
    captureOk,
    chromeLikelyInterpolated,
    presenterLikelyInterpolated,
    presenterAddsCadence
  };
}

function killChromeProcessTree(rootPid) {
  try {
    execFileSync("taskkill.exe", ["/PID", String(rootPid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // Chrome may already be gone.
  }
}

function killChromeByProfile(profile) {
  const escapedProfile = profile.replace(/'/g, "''");
  const script = `
    Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
      Where-Object { $_.CommandLine -like '*${escapedProfile}*' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  `;

  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  } catch {
    // Best-effort cleanup.
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

  if (!verifyFfmpeg()) {
    throw new Error("ffmpeg was not found. Set FFMPEG_PATH to ffmpeg.exe and run again.");
  }

  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "smooth-overlay-diagnostic-"));
  const chromeArgs = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1",
    "--window-position=80,80",
    "--window-size=1280,720",
    `--app=${withAutoplay(testUrl)}`
  ];
  const chrome = spawn(chromePath, chromeArgs, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false
  });

  let chromeStderr = "";
  chrome.stderr.on("data", (chunk) => {
    chromeStderr += chunk.toString();
  });

  let cdp = null;
  let nativeHost = null;
  const summary = {
    createdAt: new Date().toISOString(),
    artifactRoot,
    chromePath,
    ffmpegPath,
    testUrl,
    captureSeconds,
    captureFps,
    sourceMeasureMs,
    chromeArgs,
    chromePid: chrome.pid
  };

  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();

    const target = await findYoutubeTarget(port);
    const sessionId = await attachTarget(cdp, target.id);
    await cdp.send("Page.bringToFront", {}, sessionId);

    summary.player = await preparePlayer(cdp, sessionId);
    if (!summary.player.ok) {
      throw new Error(`Could not prepare YouTube player: ${JSON.stringify(summary.player)}`);
    }

    summary.playerState = await getPlayerState(cdp, sessionId);
    if (!summary.playerState.ok) {
      throw new Error(`Could not get player rect: ${JSON.stringify(summary.playerState)}`);
    }

    moveCursorAway(summary.playerState.rect);
    summary.sourceCadence = await measureSourceCadence(cdp, sessionId, sourceMeasureMs);

    moveCursorAway(summary.playerState.rect);
    summary.baselineCapture = await captureScreenRegion("baseline-chrome", summary.playerState.rect);

    nativeHost = new NativeHost(nativeHostPath);
    summary.overlayStart = await nativeHost.send({
      type: "smoothOverlayStart",
      url: summary.playerState.url,
      rect: summary.playerState.rect,
      playback: {
        ...summary.playerState.playback,
        visible: true
      }
    });

    await sleep(2000);
    moveCursorAway(summary.playerState.rect);

    summary.nvPresentLoaded = summary.overlayStart?.processId
      ? processLoadsModule(summary.overlayStart.processId, "NvPresent64.dll")
      : false;
    summary.overlayCapture = await captureScreenRegion("presenter-overlay", summary.playerState.rect);

    summary.overlayStop = await nativeHost.send({ type: "smoothOverlayStop", reason: "diagnostic" });
    summary.classification = classify(
      summary.sourceCadence,
      summary.baselineCapture,
      summary.overlayCapture,
      summary.overlayStart,
      summary.nvPresentLoaded
    );
  } catch (error) {
    summary.error = error.stack || error.message;
    if (nativeHost) {
      try {
        summary.overlayStopAfterError = await nativeHost.send({ type: "smoothOverlayStop", reason: "diagnostic-error" }, 5000);
      } catch (stopError) {
        summary.overlayStopAfterError = { ok: false, error: stopError.message };
      }
    }
  } finally {
    if (nativeHost) {
      nativeHost.close();
    }
    if (cdp) {
      cdp.close();
    }
    chrome.kill();
    await sleep(1000);
    killChromeProcessTree(chrome.pid);
    killChromeByProfile(profile);
    await sleep(500);
    summary.profileCleanup = await removeProfileWithRetry(profile);
    if (chromeStderr.trim()) {
      fs.writeFileSync(path.join(artifactRoot, "chrome-stderr.txt"), chromeStderr);
      summary.chromeStderrTail = chromeStderr.split(/\r?\n/).slice(-12);
    }

    fs.writeFileSync(path.join(artifactRoot, "summary.json"), JSON.stringify(summary, null, 2));
  }

  console.log(JSON.stringify(summary, null, 2));
  if (summary.error) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
