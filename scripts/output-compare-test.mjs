import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const extensionPath = path.resolve(".");
const testUrl = process.env.YOUTUBE_TEST_URL || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const targetSeconds = Number(process.env.YOUTUBE_TEST_SECONDS || 12);
const chromePath = process.env.CHROME_PATH || findChrome();
const artifactDir = path.join(extensionPath, "artifacts");
const strictPixelDiff = process.env.STRICT_PIXEL_DIFF === "1";

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to chrome.exe and run again.");
}

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  throw new Error("This output comparison requires Node.js 22+ with global WebSocket and fetch.");
}

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

async function attachPage(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });

  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);

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

async function prepareStableFrame(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const video = document.querySelector("video");
      if (!video) {
        return { ok: false, reason: "No video element found" };
      }

      let style = document.querySelector("#rtx-vsr-output-test-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "rtx-vsr-output-test-style";
        document.documentElement.append(style);
      }

      style.textContent = \`
        .html5-video-player .ytp-chrome-bottom,
        .html5-video-player .ytp-chrome-top,
        .html5-video-player .ytp-gradient-bottom,
        .html5-video-player .ytp-gradient-top,
        .html5-video-player .ytp-spinner,
        .html5-video-player .ytp-pause-overlay,
        .html5-video-player .ytp-cards-teaser,
        .html5-video-player .ytp-ce-element,
        .html5-video-player .ytp-title,
        .html5-video-player .ytp-ad-overlay-container,
        .html5-video-player .ytp-paid-content-overlay,
        .rtx-vsr-toggle,
        .rtx-vsr-toast {
          opacity: 0 !important;
          visibility: hidden !important;
          pointer-events: none !important;
        }
      \`;

      const player = document.querySelector("#movie_player");
      let availableQualityLevels = [];
      let playbackQuality = null;

      try {
        availableQualityLevels = typeof player?.getAvailableQualityLevels === "function"
          ? player.getAvailableQualityLevels()
          : [];
        if (typeof player?.setPlaybackQualityRange === "function") {
          player.setPlaybackQualityRange("small", "small");
        }
        if (typeof player?.setPlaybackQuality === "function") {
          player.setPlaybackQuality("small");
        }
        playbackQuality = typeof player?.getPlaybackQuality === "function"
          ? player.getPlaybackQuality()
          : null;
      } catch {
        availableQualityLevels = [];
      }

      video.muted = true;
      video.pause();

      if (video.readyState < 2) {
        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, 8000);
          video.addEventListener("loadeddata", () => {
            clearTimeout(timeout);
            resolve();
          }, { once: true });
        });
      }

      const requestedTime = ${JSON.stringify(targetSeconds)};
      const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : requestedTime + 5;
      const seekTime = Math.min(Math.max(requestedTime, 0), Math.max(duration - 1, 0));

      await new Promise((resolve) => {
        const finish = () => {
          video.pause();
          resolve();
        };

        const timeout = setTimeout(finish, 8000);
        video.addEventListener("seeked", () => {
          clearTimeout(timeout);
          finish();
        }, { once: true });

        video.currentTime = seekTime;
      });

      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

      const rect = video.getBoundingClientRect();
      const crop = {
        x: Math.max(0, rect.x + rect.width * 0.16),
        y: Math.max(0, rect.y + rect.height * 0.16),
        width: Math.max(1, rect.width * 0.68),
        height: Math.max(1, rect.height * 0.56)
      };

      return {
        ok: true,
        currentTime: video.currentTime,
        readyState: video.readyState,
        paused: video.paused,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
        availableQualityLevels,
        playbackQuality,
        crop
      };
    })()`,
    true
  );
}

async function waitForStableFrame(cdp, sessionId) {
  const started = Date.now();
  let frame = null;

  while (Date.now() - started < 60000) {
    frame = await prepareStableFrame(cdp, sessionId);
    if (frame.ok) {
      return frame;
    }
    await sleep(1000);
  }

  throw new Error(`Could not prepare a stable video frame. Last state: ${JSON.stringify(frame)}`);
}

async function captureFrame(cdp, sessionId, crop) {
  const screenshot = await cdp.send(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: crop.x,
        y: crop.y,
        width: crop.width,
        height: crop.height,
        scale: 1
      }
    },
    sessionId
  );

  return screenshot.data;
}

async function comparePngPixels(cdp, beforePng, afterPng) {
  const sessionId = await attachPage(cdp, "about:blank");
  const expression = `(${async function compare(beforeBase64, afterBase64) {
    const loadImage = (base64) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not decode screenshot"));
      image.src = `data:image/png;base64,${base64}`;
    });

    const [beforeImage, afterImage] = await Promise.all([
      loadImage(beforeBase64),
      loadImage(afterBase64)
    ]);

    if (beforeImage.width !== afterImage.width || beforeImage.height !== afterImage.height) {
      return {
        identical: false,
        reason: "dimension-mismatch",
        before: { width: beforeImage.width, height: beforeImage.height },
        after: { width: afterImage.width, height: afterImage.height }
      };
    }

    const canvas = document.createElement("canvas");
    canvas.width = beforeImage.width;
    canvas.height = beforeImage.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });

    context.drawImage(beforeImage, 0, 0);
    const before = context.getImageData(0, 0, canvas.width, canvas.height).data;

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(afterImage, 0, 0);
    const after = context.getImageData(0, 0, canvas.width, canvas.height).data;

    let diffPixels = 0;
    let totalChannelDelta = 0;
    let maxChannelDelta = 0;

    for (let index = 0; index < before.length; index += 4) {
      const dr = Math.abs(before[index] - after[index]);
      const dg = Math.abs(before[index + 1] - after[index + 1]);
      const db = Math.abs(before[index + 2] - after[index + 2]);
      const da = Math.abs(before[index + 3] - after[index + 3]);

      if (dr !== 0 || dg !== 0 || db !== 0 || da !== 0) {
        diffPixels += 1;
      }

      totalChannelDelta += dr + dg + db + da;
      maxChannelDelta = Math.max(maxChannelDelta, dr, dg, db, da);
    }

    const totalPixels = canvas.width * canvas.height;

    return {
      identical: diffPixels === 0,
      width: canvas.width,
      height: canvas.height,
      totalPixels,
      diffPixels,
      differentRatio: diffPixels / totalPixels,
      totalChannelDelta,
      meanChannelDelta: totalChannelDelta / (totalPixels * 4),
      maxChannelDelta
    };
  }.toString()})(${JSON.stringify(beforePng)}, ${JSON.stringify(afterPng)})`;

  return evaluate(cdp, sessionId, expression, true);
}

async function readRouteState(cdp) {
  const sessionId = await attachPage(cdp, "chrome://gpu");
  await sleep(1200);

  const gpuState = await evaluate(
    cdp,
    sessionId,
    `(() => {
      const text = document.body ? document.body.innerText : "";
      return {
        hasDisableVpSuperResolution: text.includes("disable_vp_super_resolution"),
        mentionsVpSuperResolution: /vp[_\\s-]*super[_\\s-]*resolution/i.test(text)
      };
    })()`
  );

  let commandLineArgs = [];
  try {
    const commandLine = await cdp.send("Browser.getBrowserCommandLine");
    commandLineArgs = commandLine.arguments || [];
  } catch {
    commandLineArgs = [];
  }

  return {
    ...gpuState,
    commandLineAvailable: commandLineArgs.length > 0,
    commandLineHasDisableVpSuperResolution: commandLineArgs.some((arg) => (
      arg === "--disable_vp_super_resolution" ||
      arg.startsWith("--disable_vp_super_resolution=")
    ))
  };
}

async function openBrowser(mode) {
  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), `rtx-vsr-output-${mode}-`));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--autoplay-policy=no-user-gesture-required",
    "--enable-automation",
    "--force-device-scale-factor=1",
    "--window-position=80,80",
    "--window-size=1280,900",
    "about:blank"
  ];

  if (mode === "non_vsr") {
    args.splice(args.length - 1, 0, "--disable_vp_super_resolution");
  }

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  const cdp = new CDP(version.webSocketDebuggerUrl);
  await cdp.open();

  return {
    mode,
    version,
    cdp,
    async close() {
      cdp.close();
      chrome.kill();
      await sleep(800);
      fs.rmSync(profile, { recursive: true, force: true });

      if (stderr.trim()) {
        console.error(stderr.split("\n").slice(0, 10).join("\n"));
      }
    }
  };
}

async function captureMode(mode) {
  const browser = await openBrowser(mode);

  try {
    const routeState = await readRouteState(browser.cdp);
    const youtubeSessionId = await attachPage(browser.cdp, testUrl);
    const frame = await waitForStableFrame(browser.cdp, youtubeSessionId);
    const png = await captureFrame(browser.cdp, youtubeSessionId, frame.crop);
    const hash = crypto.createHash("sha256").update(Buffer.from(png, "base64")).digest("hex");

    return {
      browser,
      result: {
        mode,
        browser: browser.version.Browser,
        routeState,
        frame,
        png,
        hash
      }
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function main() {
  let nonVsr = null;
  let vsr = null;

  try {
    nonVsr = await captureMode("non_vsr");
    vsr = await captureMode("vsr");

    const comparison = await comparePngPixels(vsr.browser.cdp, nonVsr.result.png, vsr.result.png);
    const nonVsrPath = path.join(artifactDir, "output-non-vsr.png");
    const vsrPath = path.join(artifactDir, "output-vsr.png");

    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(nonVsrPath, Buffer.from(nonVsr.result.png, "base64"));
    fs.writeFileSync(vsrPath, Buffer.from(vsr.result.png, "base64"));

    const routePassed =
      nonVsr.result.routeState.commandLineHasDisableVpSuperResolution === true &&
      vsr.result.routeState.commandLineHasDisableVpSuperResolution === false;
    const pixelDifferent = comparison.identical === false;
    const passed = routePassed && (pixelDifferent || !strictPixelDiff);

    console.log(JSON.stringify({
      passed,
      routePassed,
      pixelDifferent,
      strictPixelDiff,
      expected: "default VSR path should differ from --disable_vp_super_resolution path",
      url: testUrl,
      targetSeconds,
      nonVsr: {
        browser: nonVsr.result.browser,
        routeState: nonVsr.result.routeState,
        frame: nonVsr.result.frame,
        hash: nonVsr.result.hash
      },
      vsr: {
        browser: vsr.result.browser,
        routeState: vsr.result.routeState,
        frame: vsr.result.frame,
        hash: vsr.result.hash
      },
      comparison,
      artifacts: {
        nonVsr: nonVsrPath,
        vsr: vsrPath
      }
    }, null, 2));

    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    if (nonVsr) {
      await nonVsr.browser.close();
    }
    if (vsr) {
      await vsr.browser.close();
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
