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

function t(key, substitutions) {
  const message = chrome.i18n?.getMessage(key, substitutions);
  return message || key;
}

function applyStaticI18n() {
  const uiLanguage = chrome.i18n?.getUILanguage?.() || "en";
  const normalizedLanguage = uiLanguage.replace("_", "-").toLowerCase();
  document.documentElement.lang =
    normalizedLanguage.startsWith("zh-tw") || normalizedLanguage.startsWith("zh-hk")
      ? "zh-TW"
      : normalizedLanguage.startsWith("zh")
      ? "zh-CN"
      : "en";
  document.title = t("popupTitle");

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });

  document.querySelectorAll("[data-i18n-aria-label]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel));
  });
}

function render(enabled) {
  currentEnabled = enabled;
  toggle.checked = enabled;
  statusDot.classList.toggle("is-enabled", enabled);
  statusText.textContent = enabled ? t("popupVsrStatusEnabled") : t("popupVsrStatusDisabled");
}

function renderSmooth(enabled) {
  currentSmoothEnabled = enabled;
  smoothToggle.checked = enabled;
  smoothStatusDot.classList.toggle("is-enabled", enabled);
  smoothStatusText.textContent = enabled ? t("popupSmoothStatusEnabled") : t("popupSmoothStatusDisabled");
}

applyStaticI18n();

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
  statusText.textContent = enabled ? t("popupSwitchingVsr") : t("popupSwitchingNonVsr");

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
  smoothStatusText.textContent = enabled ? t("popupStartingSmooth") : t("popupStoppingSmooth");

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
      callback({ ok: false, error: t("noActiveTab") });
      return;
    }

    chrome.tabs.sendMessage(tabId, message, callback);
  });
}

function getSwitchErrorMessage(response) {
  if (response?.installRequired) {
    return t("localSwitcherNotInstalled");
  }

  if (response?.error) {
    return t("switchFailedWithError", response.error);
  }

  if (chrome.runtime.lastError) {
    return t("switchFailedWithError", chrome.runtime.lastError.message);
  }

  return t("switchFailed");
}
