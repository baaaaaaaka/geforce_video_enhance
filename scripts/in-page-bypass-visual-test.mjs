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

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to chrome.exe and run again.");
}

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  throw new Error("This visual test requires Node.js 22+ with global WebSocket and fetch.");
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

async function waitForPlayer(cdp, sessionId) {
  const started = Date.now();
  let state = null;

  while (Date.now() - started < 60000) {
    state = await getVisualState(cdp, sessionId);
    if (state.hasToggle && state.hasVideo && state.playerRect.width > 200 && state.playerRect.height > 120) {
      return state;
    }
    await sleep(1000);
  }

  throw new Error(`YouTube player was not ready. Last state: ${JSON.stringify(state)}`);
}

async function prepareStableFrame(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const video = document.querySelector("video");
      if (!video) {
        return { ok: false, reason: "no-video" };
      }

      let style = document.querySelector("#rtx-vsr-visual-test-style");
      if (!style) {
        style = document.createElement("style");
        style.id = "rtx-vsr-visual-test-style";
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

      return {
        ok: true,
        currentTime: video.currentTime,
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight
      };
    })()`,
    true
  );
}

async function getVisualState(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const player = document.querySelector(".html5-video-player");
      const video = document.querySelector("video");
      const canvas = document.querySelector(".rtx-vsr-bypass-canvas");
      const toggle = document.querySelector(".rtx-vsr-toggle");
      const compareToggle = document.querySelector(".rtx-vsr-compare-toggle");
      const divider = document.querySelector(".rtx-vsr-compare-divider");

      const rect = (element) => {
        if (!element) {
          return null;
        }
        const value = element.getBoundingClientRect();
        return {
          x: value.x,
          y: value.y,
          width: value.width,
          height: value.height
        };
      };

      const videoStyle = video ? getComputedStyle(video) : null;
      const canvasStyle = canvas ? getComputedStyle(canvas) : null;
      const dividerStyle = divider ? getComputedStyle(divider) : null;
      const playerRect = rect(player) || { x: 0, y: 0, width: 0, height: 0 };
      const splitText = player ? getComputedStyle(player).getPropertyValue("--rtx-vsr-split").trim() : "";
      const splitRatio = splitText.endsWith("%") ? Number.parseFloat(splitText) / 100 : 0.5;
      const dividerRect = rect(divider);
      const pointX = dividerRect
        ? dividerRect.x + dividerRect.width * 0.5
        : player
        ? Math.min(playerRect.x + playerRect.width - 1, Math.max(playerRect.x + 1, playerRect.x + playerRect.width * splitRatio))
        : 0;
      const pointY = dividerRect
        ? dividerRect.y + dividerRect.height * 0.5
        : player
        ? playerRect.y + playerRect.height * 0.5
        : 0;
      const topAtDivider = player
        ? document.elementFromPoint(
            pointX,
            pointY
          )
        : null;

      return {
        hasPlayer: !!player,
        hasVideo: !!video,
        hasCanvas: !!canvas,
        hasToggle: !!toggle,
        hasCompareToggle: !!compareToggle,
        comparePressed: compareToggle ? compareToggle.getAttribute("aria-pressed") : null,
        hasDivider: !!divider,
        topAtDividerClass: topAtDivider ? topAtDivider.className : null,
        topAtDividerTag: topAtDivider ? topAtDivider.tagName : null,
        pressed: toggle ? toggle.getAttribute("aria-pressed") : null,
        playerRect,
        videoRect: rect(video),
        canvasRect: rect(canvas),
        dividerRect: rect(divider),
        canvasWidth: canvas ? canvas.width : 0,
        canvasHeight: canvas ? canvas.height : 0,
        sourceHidden: video ? video.classList.contains("rtx-vsr-bypass-source") : false,
        videoDisplay: videoStyle ? videoStyle.display : null,
        videoPosition: videoStyle ? videoStyle.position : null,
        videoOpacity: videoStyle ? videoStyle.opacity : null,
        splitValue: splitText,
        canvasDisplay: canvasStyle ? canvasStyle.display : null,
        canvasVisibility: canvasStyle ? canvasStyle.visibility : null,
        canvasZIndex: canvasStyle ? canvasStyle.zIndex : null,
        canvasClipPath: canvasStyle ? canvasStyle.clipPath : null,
        dividerDisplay: dividerStyle ? dividerStyle.display : null,
        dividerZIndex: dividerStyle ? dividerStyle.zIndex : null
      };
    })()`
  );
}

function centerCrop(rect) {
  return {
    x: Math.max(0, rect.x + rect.width * 0.2),
    y: Math.max(0, rect.y + rect.height * 0.18),
    width: Math.max(1, rect.width * 0.6),
    height: Math.max(1, rect.height * 0.52),
    scale: 1
  };
}

async function captureCrop(cdp, sessionId, rect) {
  const screenshot = await cdp.send(
    "Page.captureScreenshot",
    {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: centerCrop(rect)
    },
    sessionId
  );

  return screenshot.data;
}

async function imageStats(cdp, pngBase64) {
  const sessionId = await attachPage(cdp, "about:blank");
  return evaluate(
    cdp,
    sessionId,
    `(${async function stats(base64) {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("Could not decode screenshot"));
        element.src = `data:image/png;base64,${base64}`;
      });

      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;

      let nonBlackPixels = 0;
      let totalLuma = 0;

      for (let index = 0; index < data.length; index += 4) {
        const r = data[index];
        const g = data[index + 1];
        const b = data[index + 2];
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        totalLuma += luma;
        if (luma > 8) {
          nonBlackPixels += 1;
        }
      }

      const totalPixels = canvas.width * canvas.height;
      return {
        width: canvas.width,
        height: canvas.height,
        totalPixels,
        nonBlackPixels,
        nonBlackRatio: nonBlackPixels / totalPixels,
        meanLuma: totalLuma / totalPixels
      };
    }.toString()})(${JSON.stringify(pngBase64)})`,
    true
  );
}

async function clickToggle(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector(".rtx-vsr-toggle").click()`);
  await sleep(1000);
}

async function clickCompare(cdp, sessionId) {
  await evaluate(cdp, sessionId, `document.querySelector(".rtx-vsr-compare-toggle").click()`);
  await sleep(1000);
}

async function dragCompareDivider(cdp, sessionId, ratio) {
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const player = document.querySelector(".html5-video-player");
      const divider = document.querySelector(".rtx-vsr-compare-divider");
      if (!player || !divider) {
        return false;
      }

      const rect = player.getBoundingClientRect();
      const clientX = rect.left + rect.width * ${JSON.stringify(ratio)};
      const clientY = rect.top + rect.height * 0.5;
      const eventInit = {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        pointerType: "mouse",
        clientX,
        clientY,
        buttons: 1
      };

      divider.dispatchEvent(new PointerEvent("pointerdown", eventInit));
      divider.dispatchEvent(new PointerEvent("pointermove", eventInit));
      divider.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, buttons: 0 }));
      return true;
    })()`
  );
  await sleep(300);
}

async function main() {
  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rtx-vsr-visual-"));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--autoplay-policy=no-user-gesture-required",
    "--force-device-scale-factor=1",
    "--window-position=80,80",
    "--window-size=1280,900",
    "about:blank"
  ];

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false
  });

  let stderr = "";
  chrome.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();

    const youtubeSessionId = await attachPage(cdp, testUrl);
    await waitForPlayer(cdp, youtubeSessionId);

    const prepared = await prepareStableFrame(cdp, youtubeSessionId);
    if (!prepared.ok) {
      throw new Error(prepared.reason);
    }

    const onBefore = await getVisualState(cdp, youtubeSessionId);
    const onBeforePng = await captureCrop(cdp, youtubeSessionId, onBefore.playerRect);
    const onBeforeStats = await imageStats(cdp, onBeforePng);

    await clickToggle(cdp, youtubeSessionId);
    const offState = await getVisualState(cdp, youtubeSessionId);
    const offPng = await captureCrop(cdp, youtubeSessionId, offState.playerRect);
    const offStats = await imageStats(cdp, offPng);

    await clickToggle(cdp, youtubeSessionId);
    const onAfter = await getVisualState(cdp, youtubeSessionId);
    const onAfterPng = await captureCrop(cdp, youtubeSessionId, onAfter.playerRect);
    const onAfterStats = await imageStats(cdp, onAfterPng);

    await clickCompare(cdp, youtubeSessionId);
    const compareInitial = await getVisualState(cdp, youtubeSessionId);
    const compareInitialPng = await captureCrop(cdp, youtubeSessionId, compareInitial.playerRect);
    const compareInitialStats = await imageStats(cdp, compareInitialPng);

    await dragCompareDivider(cdp, youtubeSessionId, 0.72);
    const compareDragged = await getVisualState(cdp, youtubeSessionId);
    const compareDraggedPng = await captureCrop(cdp, youtubeSessionId, compareDragged.playerRect);
    const compareDraggedStats = await imageStats(cdp, compareDraggedPng);

    await dragCompareDivider(cdp, youtubeSessionId, 1);
    const compareRightEdge = await getVisualState(cdp, youtubeSessionId);

    await dragCompareDivider(cdp, youtubeSessionId, 0);
    const compareLeftEdge = await getVisualState(cdp, youtubeSessionId);

    await clickCompare(cdp, youtubeSessionId);
    const compareExited = await getVisualState(cdp, youtubeSessionId);

    fs.mkdirSync(artifactDir, { recursive: true });
    const onBeforePath = path.join(artifactDir, "in-page-on-before.png");
    const offPath = path.join(artifactDir, "in-page-off-canvas.png");
    const onAfterPath = path.join(artifactDir, "in-page-on-after.png");
    const compareInitialPath = path.join(artifactDir, "in-page-compare-initial.png");
    const compareDraggedPath = path.join(artifactDir, "in-page-compare-dragged.png");
    fs.writeFileSync(onBeforePath, Buffer.from(onBeforePng, "base64"));
    fs.writeFileSync(offPath, Buffer.from(offPng, "base64"));
    fs.writeFileSync(onAfterPath, Buffer.from(onAfterPng, "base64"));
    fs.writeFileSync(compareInitialPath, Buffer.from(compareInitialPng, "base64"));
    fs.writeFileSync(compareDraggedPath, Buffer.from(compareDraggedPng, "base64"));

    const onBeforeHash = crypto.createHash("sha256").update(Buffer.from(onBeforePng, "base64")).digest("hex");
    const offHash = crypto.createHash("sha256").update(Buffer.from(offPng, "base64")).digest("hex");
    const onAfterHash = crypto.createHash("sha256").update(Buffer.from(onAfterPng, "base64")).digest("hex");
    const compareInitialHash = crypto.createHash("sha256").update(Buffer.from(compareInitialPng, "base64")).digest("hex");
    const compareDraggedHash = crypto.createHash("sha256").update(Buffer.from(compareDraggedPng, "base64")).digest("hex");

    const passed =
      onBefore.pressed === "true" &&
      onBefore.hasCompareToggle === true &&
      onBefore.hasCanvas === false &&
      onBeforeStats.nonBlackRatio > 0.05 &&
      offState.pressed === "false" &&
      offState.hasCanvas === true &&
      offState.sourceHidden === true &&
      offState.videoDisplay !== "none" &&
      offState.videoPosition === "fixed" &&
      offState.canvasWidth > 200 &&
      offState.canvasHeight > 120 &&
      offStats.nonBlackRatio > 0.05 &&
      onAfter.pressed === "true" &&
      onAfter.hasCanvas === false &&
      onAfter.sourceHidden === false &&
      onAfterStats.nonBlackRatio > 0.05 &&
      compareInitial.pressed === "true" &&
      compareInitial.comparePressed === "true" &&
      compareInitial.hasCanvas === true &&
      compareInitial.hasDivider === true &&
      String(compareInitial.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      compareInitial.sourceHidden === false &&
      compareInitial.videoPosition !== "fixed" &&
      compareInitialStats.nonBlackRatio > 0.05 &&
      compareInitialHash !== onBeforeHash &&
      compareDragged.hasDivider === true &&
      String(compareDragged.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      compareDragged.splitValue.startsWith("72") &&
      compareDraggedStats.nonBlackRatio > 0.05 &&
      compareDraggedHash !== onBeforeHash &&
      compareDraggedHash !== compareInitialHash &&
      compareRightEdge.hasDivider === true &&
      compareRightEdge.splitValue === "100%" &&
      String(compareRightEdge.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      compareLeftEdge.hasDivider === true &&
      compareLeftEdge.splitValue === "0%" &&
      String(compareLeftEdge.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      compareExited.comparePressed === "false" &&
      compareExited.hasCanvas === false &&
      compareExited.hasDivider === false &&
      compareExited.sourceHidden === false;

    console.log(JSON.stringify({
      passed,
      browser: version.Browser,
      url: testUrl,
      targetSeconds,
      prepared,
      onBefore: {
        state: onBefore,
        stats: onBeforeStats,
        hash: onBeforeHash
      },
      off: {
        state: offState,
        stats: offStats,
        hash: offHash
      },
      onAfter: {
        state: onAfter,
        stats: onAfterStats,
        hash: onAfterHash
      },
      compareInitial: {
        state: compareInitial,
        stats: compareInitialStats,
        hash: compareInitialHash
      },
      compareDragged: {
        state: compareDragged,
        stats: compareDraggedStats,
        hash: compareDraggedHash
      },
      compareRightEdge: {
        state: compareRightEdge
      },
      compareLeftEdge: {
        state: compareLeftEdge
      },
      compareExited: {
        state: compareExited
      },
      artifacts: {
        onBefore: onBeforePath,
        off: offPath,
        onAfter: onAfterPath,
        compareInitial: compareInitialPath,
        compareDragged: compareDraggedPath
      }
    }, null, 2));

    cdp.close();

    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    chrome.kill();
    await sleep(800);
    fs.rmSync(profile, { recursive: true, force: true });

    if (stderr.trim()) {
      console.error(stderr.split("\n").slice(0, 10).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
