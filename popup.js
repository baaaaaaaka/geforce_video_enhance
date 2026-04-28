const STORAGE_KEY = "rtxVsrEnabled";
const SMOOTH_OVERLAY_STORAGE_KEY = "rtxSmoothOverlayEnabled";
const DEFAULT_ENABLED = true;

const toggle = document.querySelector("#vsrToggle");
const statusDot = document.querySelector("#statusDot");
const statusText = document.querySelector("#statusText");
const smoothToggle = document.querySelector("#smoothToggle");
const smoothStatusDot = document.querySelector("#smoothStatusDot");
const smoothStatusText = document.querySelector("#smoothStatusText");

let currentEnabled = DEFAULT_ENABLED;
let currentSmoothEnabled = false;

function render(enabled) {
  currentEnabled = enabled;
  toggle.checked = enabled;
  statusDot.classList.toggle("is-enabled", enabled);
  statusText.textContent = enabled ? "当前模式：VSR 原生视频层" : "当前模式：non-VSR canvas 显示";
}

function renderSmooth(enabled) {
  currentSmoothEnabled = enabled;
  smoothToggle.checked = enabled;
  smoothStatusDot.classList.toggle("is-enabled", enabled);
  smoothStatusText.textContent = enabled ? "当前模式：Smooth Motion 覆盖层" : "当前模式：原生 YouTube 输出";
}

chrome.storage.local.get({
  [STORAGE_KEY]: DEFAULT_ENABLED,
  [SMOOTH_OVERLAY_STORAGE_KEY]: false
}, (items) => {
  render(Boolean(items[STORAGE_KEY]));
  renderSmooth(Boolean(items[SMOOTH_OVERLAY_STORAGE_KEY]));
});

toggle.addEventListener("change", async () => {
  const previousEnabled = currentEnabled;
  const enabled = toggle.checked;
  render(enabled);
  toggle.disabled = true;
  statusText.textContent = enabled ? "正在恢复 VSR 显示..." : "正在切换到 non-VSR 显示...";

  chrome.runtime.sendMessage({ type: "switchMode", enabled }, (response) => {
    toggle.disabled = false;

    if (chrome.runtime.lastError || !response?.ok) {
      render(previousEnabled);
      statusText.textContent = getSwitchErrorMessage(response);
      return;
    }

    render(enabled);
  });
});

smoothToggle.addEventListener("change", async () => {
  const previousEnabled = currentSmoothEnabled;
  const enabled = smoothToggle.checked;
  renderSmooth(enabled);
  smoothToggle.disabled = true;
  smoothStatusText.textContent = enabled ? "正在开启 Smooth Motion 覆盖层..." : "正在关闭 Smooth Motion 覆盖层...";

  sendActiveTabMessage({ type: "setSmoothOverlay", enabled }, (response) => {
    smoothToggle.disabled = false;

    if (chrome.runtime.lastError || !response?.ok) {
      renderSmooth(previousEnabled);
      smoothStatusText.textContent = getSwitchErrorMessage(response);
      return;
    }

    renderSmooth(enabled);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
    render(Boolean(changes[STORAGE_KEY].newValue));
  }

  if (Object.prototype.hasOwnProperty.call(changes, SMOOTH_OVERLAY_STORAGE_KEY)) {
    renderSmooth(Boolean(changes[SMOOTH_OVERLAY_STORAGE_KEY].newValue));
  }
});

function sendActiveTabMessage(message, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (typeof tabId !== "number") {
      callback({ ok: false, error: "没有可用的当前标签页" });
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function getSwitchErrorMessage(response) {
  if (response?.installRequired) {
    return "本地切换器未安装";
  }

  if (response?.error) {
    return `切换失败：${response.error}`;
  }

  if (chrome.runtime.lastError) {
    return `切换失败：${chrome.runtime.lastError.message}`;
  }

  return "切换失败";
}
