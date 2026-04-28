import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const extensionPath = path.resolve(".");
const extensionId = "nleneifgnjpfhkfppelojoeggalbjjfc";
const testUrl = process.env.YOUTUBE_TEST_URL || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const chromePath = process.env.CHROME_PATH || findChrome();

if (!chromePath) {
  throw new Error("Chrome was not found. Set CHROME_PATH to chrome.exe and run again.");
}

if (typeof WebSocket !== "function" || typeof fetch !== "function") {
  throw new Error("This smoke test requires Node.js 22+ with global WebSocket and fetch.");
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

function killProcessTree(pid) {
  if (!pid) {
    return;
  }

  try {
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    // The process may already have exited.
  }
}

function killChromeProcessesForProfile(profilePath) {
  const profileName = path.basename(profilePath);
  const script = `
$profileName = ${JSON.stringify(profileName)}
Get-CimInstance Win32_Process -Filter "name='chrome.exe'" |
  Where-Object { $_.CommandLine -like "*$profileName*" } |
  ForEach-Object { & taskkill.exe /PID $_.ProcessId /T /F | Out-Null }
`;

  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  } catch {
    // Matching Chrome processes may already have exited.
  }
}

async function removeDirectoryWithRetry(target) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 5) {
        throw error;
      }

      await sleep(500);
    }
  }
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

async function readYoutubeState(cdp, sessionId) {
  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
        const player = document.querySelector(".html5-video-player");
        const toggle = document.querySelector(".rtx-vsr-toggle");
        const compareToggle = document.querySelector(".rtx-vsr-compare-toggle");
        const divider = document.querySelector(".rtx-vsr-compare-divider");
        const toast = document.querySelector(".rtx-vsr-toast");
        const splitText = player ? getComputedStyle(player).getPropertyValue("--rtx-vsr-split").trim() : "";
        const splitRatio = splitText.endsWith("%") ? Number.parseFloat(splitText) / 100 : 0.5;
        const rect = player ? player.getBoundingClientRect() : null;
        const dividerRect = divider ? divider.getBoundingClientRect() : null;
        const pointX = dividerRect
          ? dividerRect.left + dividerRect.width * 0.5
          : rect
          ? Math.min(rect.right - 1, Math.max(rect.left + 1, rect.left + rect.width * splitRatio))
          : 0;
        const pointY = dividerRect
          ? dividerRect.top + dividerRect.height * 0.5
          : rect
          ? rect.top + rect.height * 0.5
          : 0;
        const topAtDivider = rect
          ? document.elementFromPoint(pointX, pointY)
          : null;
        return {
          href: location.href,
          title: document.title,
          hasPlayer: !!document.querySelector(".html5-video-player"),
          hasControls: !!document.querySelector(".ytp-right-controls"),
          hasToggle: !!toggle,
          toggleCount: document.querySelectorAll(".rtx-vsr-toggle").length,
          compareCount: document.querySelectorAll(".rtx-vsr-compare-toggle").length,
          comparePressed: compareToggle ? compareToggle.getAttribute("aria-pressed") : null,
          hasDivider: !!divider,
          splitValue: splitText,
          topAtDividerClass: topAtDivider ? String(topAtDivider.className) : null,
          topAtDividerTag: topAtDivider ? topAtDivider.tagName : null,
          label: toggle ? toggle.getAttribute("aria-label") : null,
          pressed: toggle ? toggle.getAttribute("aria-pressed") : null,
          enabledClass: toggle ? toggle.classList.contains("is-enabled") : false,
          disabledClass: toggle ? toggle.classList.contains("is-disabled") : false,
          toast: toast ? toast.textContent : null,
          toastVisible: toast ? toast.classList.contains("is-visible") : false,
          hasBypassCanvas: !!document.querySelector(".rtx-vsr-bypass-canvas"),
          sourceHidden: document.querySelector("video")?.classList.contains("rtx-vsr-bypass-source") || false,
          videoDisplay: document.querySelector("video") ? getComputedStyle(document.querySelector("video")).display : null,
          videoPosition: document.querySelector("video") ? getComputedStyle(document.querySelector("video")).position : null,
          videoWidthCss: document.querySelector("video") ? getComputedStyle(document.querySelector("video")).width : null,
          videoHeightCss: document.querySelector("video") ? getComputedStyle(document.querySelector("video")).height : null,
          videoOpacity: document.querySelector("video")?.style.opacity || ""
        };
      })()`,
      returnByValue: true
    },
    sessionId
  );

  return result.result.value;
}

async function readExtensionInfo(cdp) {
  const sessionId = await attachPage(cdp, "chrome://extensions/");
  await sleep(1000);

  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `new Promise((resolve) => {
        chrome.developerPrivate.getExtensionsInfo((info) => {
          resolve(info.map((extension) => ({
            name: extension.name,
            id: extension.id,
            manifestErrors: extension.manifestErrors,
            runtimeErrors: extension.runtimeErrors,
            path: extension.path
          })));
        });
      })`,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  );

  return result.result.value;
}

async function sendDryRunSwitch(cdp, enabled) {
  const sessionId = await attachPage(cdp, `chrome-extension://${extensionId}/popup.html`);
  await sleep(800);

  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "switchMode",
          enabled: ${JSON.stringify(enabled)},
          url: ${JSON.stringify(testUrl)},
          dryRun: true
        }, (response) => {
          resolve({
            response,
            lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
          });
        });
      })`,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  );

  return result.result.value;
}

async function sendLocalSwitch(cdp, enabled) {
  const sessionId = await attachPage(cdp, `chrome-extension://${extensionId}/popup.html`);
  await sleep(800);

  const result = await cdp.send(
    "Runtime.evaluate",
    {
      expression: `new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: "switchMode",
          enabled: ${JSON.stringify(enabled)}
        }, (response) => {
          resolve({
            response,
            lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null
          });
        });
      })`,
      awaitPromise: true,
      returnByValue: true
    },
    sessionId
  );

  return result.result.value;
}

async function clickCompareButton(cdp, sessionId) {
  await cdp.send(
    "Runtime.evaluate",
    { expression: `document.querySelector(".rtx-vsr-compare-toggle").click()` },
    sessionId
  );
  await sleep(800);
}

async function dragCompareDivider(cdp, sessionId, ratio) {
  await cdp.send(
    "Runtime.evaluate",
    {
      expression: `(() => {
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
    },
    sessionId
  );
  await sleep(300);
}

async function main() {
  const port = await getFreePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rtx-vsr-chrome-"));
  const args = [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    "--autoplay-policy=no-user-gesture-required",
    "--window-position=-32000,-32000",
    "--window-size=1280,900",
    "about:blank"
  ];

  const chrome = spawn(chromePath, args, {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true
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

    let beforeClick = null;
    const started = Date.now();

    while (Date.now() - started < 60000) {
      beforeClick = await readYoutubeState(cdp, youtubeSessionId);
      if (beforeClick.hasToggle) {
        break;
      }
      await sleep(1000);
    }

    if (!beforeClick?.hasToggle) {
      throw new Error(`RTX VSR toggle was not injected. Last state: ${JSON.stringify(beforeClick)}`);
    }

    const extensionInfo = await readExtensionInfo(cdp);
    const nativeDryRun = await sendDryRunSwitch(cdp, false);
    const localSwitch = await sendLocalSwitch(cdp, false);
    await sleep(1000);
    const afterLocalSwitch = await readYoutubeState(cdp, youtubeSessionId);
    const localRestore = await sendLocalSwitch(cdp, true);
    await sleep(800);
    const afterRestore = await readYoutubeState(cdp, youtubeSessionId);
    await clickCompareButton(cdp, youtubeSessionId);
    const afterCompare = await readYoutubeState(cdp, youtubeSessionId);
    await dragCompareDivider(cdp, youtubeSessionId, 0.72);
    const afterCompareDrag = await readYoutubeState(cdp, youtubeSessionId);
    await dragCompareDivider(cdp, youtubeSessionId, 1);
    const afterCompareRightEdge = await readYoutubeState(cdp, youtubeSessionId);
    await dragCompareDivider(cdp, youtubeSessionId, 0);
    const afterCompareLeftEdge = await readYoutubeState(cdp, youtubeSessionId);

    const thisExtension = extensionInfo.find((extension) => extension.path === extensionPath || extension.id === extensionId);
    const passed =
      beforeClick.toggleCount === 1 &&
      beforeClick.compareCount === 1 &&
      beforeClick.pressed === "true" &&
      thisExtension &&
      thisExtension.id === extensionId &&
      thisExtension.manifestErrors.length === 0 &&
      thisExtension.runtimeErrors.length === 0 &&
      nativeDryRun.lastError === null &&
      nativeDryRun.response?.ok === true &&
      nativeDryRun.response?.mode === "non_vsr" &&
      nativeDryRun.response?.native?.dryRun === true &&
      localSwitch.lastError === null &&
      localSwitch.response?.ok === true &&
      localSwitch.response?.strategy === "in_page_canvas" &&
      localSwitch.response?.native === undefined &&
      afterLocalSwitch.toggleCount === 1 &&
      afterLocalSwitch.compareCount === 1 &&
      afterLocalSwitch.pressed === "false" &&
      afterLocalSwitch.hasBypassCanvas === true &&
      afterLocalSwitch.sourceHidden === true &&
      afterLocalSwitch.videoDisplay !== "none" &&
      afterLocalSwitch.videoPosition === "fixed" &&
      localRestore.lastError === null &&
      localRestore.response?.ok === true &&
      afterRestore.pressed === "true" &&
      afterRestore.hasBypassCanvas === false &&
      afterCompare.comparePressed === "true" &&
      afterCompare.hasDivider === true &&
      String(afterCompare.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      afterCompareDrag.splitValue.startsWith("72") &&
      String(afterCompareDrag.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      afterCompareRightEdge.splitValue === "100%" &&
      String(afterCompareRightEdge.topAtDividerClass).includes("rtx-vsr-compare-divider") &&
      afterCompareLeftEdge.splitValue === "0%" &&
      String(afterCompareLeftEdge.topAtDividerClass).includes("rtx-vsr-compare-divider");

    console.log(JSON.stringify({
      passed,
      browser: version.Browser,
      injection: beforeClick,
      nativeDryRun,
      localSwitch,
      afterLocalSwitch,
      localRestore,
      afterRestore,
      afterCompare,
      afterCompareDrag,
      afterCompareRightEdge,
      afterCompareLeftEdge,
      extensionInfo
    }, null, 2));

    cdp.close();

    if (!passed) {
      process.exitCode = 1;
    }
  } finally {
    chrome.kill();
    await sleep(800);
    killProcessTree(chrome.pid);
    killChromeProcessesForProfile(profile);
    await sleep(500);
    await removeDirectoryWithRetry(profile);

    if (stderr.trim()) {
      console.error(stderr.split("\n").slice(0, 10).join("\n"));
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
