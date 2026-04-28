const STORAGE_KEY = "rtxVsrEnabled";
const SMOOTH_OVERLAY_STORAGE_KEY = "rtxSmoothOverlayEnabled";
const DEFAULT_ENABLED = true;
const HOST_NAME = "com.geforce_video_enhance.rtx_vsr_switch";
const NATIVE_PORT_TIMEOUT_MS = 30000;

let nativePort = null;
let nativePortPending = [];
let activeSmoothOverlayTabId = null;
let activeSmoothOverlayWindowId = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  if (message.type === "switchMode") {
    switchMode(message, sender).then(sendResponse);
    return true;
  }

  if (
    message.type === "smoothOverlayStart" ||
    message.type === "smoothOverlaySync" ||
    message.type === "smoothOverlayStop" ||
    message.type === "smoothOverlayStatus"
  ) {
    handleSmoothOverlayMessage(message, sender).then(sendResponse);
    return true;
  }

  return false;
});

async function switchMode(message, sender) {
  const enabled = Boolean(message.enabled);
  const mode = enabled ? "vsr" : "non_vsr";

  if (message.native === true || message.strategy === "native" || message.dryRun === true) {
    return switchNativeMode(message, sender, enabled, mode);
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });

  return {
    ok: true,
    enabled,
    mode,
    strategy: "in_page_canvas"
  };
}

async function switchNativeMode(message, sender, enabled, mode) {
  const target = await getSwitchTarget(message, sender);
  const url = target.url;

  if (!isAllowedUrl(url)) {
    return {
      ok: false,
      error: "Only YouTube video pages can be switched."
    };
  }

  const pauseResponse = message.dryRun
    ? { ok: true, skipped: true, reason: "dry-run" }
    : await pauseTabVideo(target.tabId);

  const nativeResponse = await sendNativeMessage({
    type: "openMode",
    mode,
    url,
    dryRun: Boolean(message.dryRun)
  });

  if (!nativeResponse.ok) {
    if (!message.dryRun && pauseResponse.didPause) {
      await resumeTabVideo(target.tabId);
    }
    return nativeResponse;
  }

  if (!message.dryRun) {
    await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
  }

  return {
    ok: true,
    enabled,
    mode,
    paused: pauseResponse,
    native: nativeResponse
  };
}

function sendNativeMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message,
          installRequired: true
        });
        return;
      }

      resolve(response || { ok: false, error: "Native host returned no response." });
    });
  });
}

async function handleSmoothOverlayMessage(message, sender) {
  if (message.type !== "smoothOverlayStop" && message.type !== "smoothOverlayStatus") {
    const target = await getSwitchTarget(message, sender);
    const url = message.url || target.url;

    if (!isAllowedUrl(url)) {
      return {
        ok: false,
        error: "Only YouTube video pages can use Smooth Motion overlay."
      };
    }

    message = {
      ...message,
      url
    };
  }

  const response = await sendNativePortMessage(message);

  if (message.type === "smoothOverlayStart" && response?.ok) {
    activeSmoothOverlayTabId = typeof sender.tab?.id === "number" ? sender.tab.id : null;
    activeSmoothOverlayWindowId = typeof sender.tab?.windowId === "number" ? sender.tab.windowId : null;
    await chrome.storage.local.set({ [SMOOTH_OVERLAY_STORAGE_KEY]: true });
  }

  if (message.type === "smoothOverlayStop" && response?.ok) {
    activeSmoothOverlayTabId = null;
    activeSmoothOverlayWindowId = null;
    await chrome.storage.local.set({ [SMOOTH_OVERLAY_STORAGE_KEY]: false });
  }

  return response;
}

function sendNativePortMessage(payload) {
  return new Promise((resolve) => {
    const pending = {
      resolve,
      timer: globalThis.setTimeout(() => {
        removePendingNativePortRequest(pending);
        resolve({
          ok: false,
          error: "Native host timed out.",
          installRequired: false
        });
      }, NATIVE_PORT_TIMEOUT_MS)
    };

    nativePortPending.push(pending);

    try {
      ensureNativePort().postMessage(payload);
    } catch (error) {
      removePendingNativePortRequest(pending);
      resolve({
        ok: false,
        error: error?.message || String(error),
        installRequired: true
      });
    }
  });
}

function ensureNativePort() {
  if (nativePort) {
    return nativePort;
  }

  nativePort = chrome.runtime.connectNative(HOST_NAME);
  nativePort.onMessage.addListener((response) => {
    const pending = nativePortPending.shift();
    if (!pending) {
      return;
    }

    globalThis.clearTimeout(pending.timer);
    pending.resolve(response || { ok: false, error: "Native host returned no response." });
  });

  nativePort.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || "Native host disconnected.";
    nativePort = null;

    const pendingRequests = nativePortPending.splice(0);
    pendingRequests.forEach((pending) => {
      globalThis.clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        error,
        installRequired: true
      });
    });
  });

  return nativePort;
}

function removePendingNativePortRequest(target) {
  const index = nativePortPending.indexOf(target);
  if (index !== -1) {
    nativePortPending.splice(index, 1);
  }

  globalThis.clearTimeout(target.timer);
}

async function getSwitchTarget(message, sender) {
  if (message.url || sender.tab?.url) {
    return {
      url: message.url || sender.tab.url,
      tabId: sender.tab?.id
    };
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return {
    url: tabs[0]?.url || "",
    tabId: tabs[0]?.id
  };
}

function pauseTabVideo(tabId) {
  if (typeof tabId !== "number") {
    return Promise.resolve({ ok: false, skipped: true, reason: "no-tab" });
  }

  return sendTabMessage(tabId, { type: "pauseForSwitch" });
}

function resumeTabVideo(tabId) {
  if (typeof tabId !== "number") {
    return Promise.resolve({ ok: false, skipped: true, reason: "no-tab" });
  }

  return sendTabMessage(tabId, { type: "resumeAfterFailedSwitch" });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          skipped: true,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      resolve(response || { ok: false, skipped: true, reason: "empty-response" });
    });
  });
}

function isAllowedUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (
        parsed.hostname === "www.youtube.com" ||
        parsed.hostname === "m.youtube.com" ||
        parsed.hostname === "youtube.com" ||
        parsed.hostname === "youtu.be" ||
        parsed.hostname === "www.youtube-nocookie.com"
      )
    );
  } catch {
    return false;
  }
}

async function stopSmoothOverlayFromBackground(reason) {
  if (activeSmoothOverlayTabId == null && activeSmoothOverlayWindowId == null && !nativePort) {
    return;
  }

  activeSmoothOverlayTabId = null;
  activeSmoothOverlayWindowId = null;

  try {
    await sendNativePortMessage({
      type: "smoothOverlayStop",
      reason
    });
  } catch {
    // Native host shutdown is best-effort during tab/window teardown.
  }

  await chrome.storage.local.set({ [SMOOTH_OVERLAY_STORAGE_KEY]: false });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeSmoothOverlayTabId) {
    stopSmoothOverlayFromBackground("tab-removed");
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId !== activeSmoothOverlayTabId || !changeInfo.url) {
    return;
  }

  if (!isAllowedUrl(changeInfo.url)) {
    stopSmoothOverlayFromBackground("tab-navigated-away");
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === activeSmoothOverlayWindowId) {
    stopSmoothOverlayFromBackground("window-removed");
  }
});
