const STORAGE_KEY = "rtxVsrEnabled";
const SMOOTH_OVERLAY_STORAGE_KEY = "rtxSmoothOverlayEnabled";
const DEFAULT_ENABLED = true;
const MOUNT_DEBOUNCE_MS = 150;
const TOAST_DURATION_MS = 1600;
const BYPASS_HOST_CLASS = "rtx-vsr-bypass-host";
const BYPASS_CANVAS_CLASS = "rtx-vsr-bypass-canvas";
const BYPASS_SOURCE_CLASS = "rtx-vsr-bypass-source";
const COMPARE_BUTTON_CLASS = "rtx-vsr-compare-toggle";
const SMOOTH_BUTTON_CLASS = "rtx-smooth-toggle";
const COMPARE_HOST_CLASS = "is-compare";
const COMPARE_CANVAS_CLASS = "is-compare";
const COMPARE_DIVIDER_CLASS = "rtx-vsr-compare-divider";
const SMOOTH_CONTROLS_ASSIST_CLASS = "rtx-smooth-native-controls";
const SPLIT_MIN = 0;
const SPLIT_MAX = 1;
const DEFAULT_SPLIT = 0.5;
const PREVIOUS_OPACITY_KEY = "rtxVsrPreviousOpacity";
const SMOOTH_POINTER_IDLE_MS = 1600;
const SMOOTH_KEYBOARD_IDLE_MS = 900;
const SMOOTH_CONTEXT_MENU_IDLE_MS = 2600;
const SMOOTH_RESUME_POLL_MS = 200;
const SMOOTH_START_WAIT_MS = 4500;
const SMOOTH_START_POLL_MS = 150;

let enabled = DEFAULT_ENABLED;
let compareMode = false;
let smoothOverlayEnabled = false;
let smoothOverlayBusy = false;
let enabledBeforeCompare = DEFAULT_ENABLED;
let splitRatio = DEFAULT_SPLIT;
let mountTimer = 0;
let toastTimer = 0;
let lastPausedForSwitch = null;
let smoothSyncTimer = 0;
let smoothSyncQueued = false;
let smoothSeekSerial = 0;
let smoothUrl = "";
let smoothCleanupCallbacks = [];
let smoothSuppressionTimers = new Map();
let smoothSuppressionReasons = new Set();
let smoothInteractionObserver = null;
let smoothObservedPlayer = null;
let smoothResumeTimer = 0;
let smoothPointerInsidePlayer = false;
let smoothLastVisibleSent = null;
let smoothAttachedVideo = null;
let bypassState = {
  active: false,
  mode: null,
  canvas: null,
  context: null,
  container: null,
  divider: null,
  video: null,
  frameHandle: 0,
  frameKind: null,
  drawQueued: false,
  queuedDrawHandle: 0,
  resizeObserver: null,
  cleanupCallbacks: []
};

function t(key, substitutions) {
  const message = chrome.i18n?.getMessage(key, substitutions);
  return message || key;
}

function readPreference() {
  chrome.storage.local.get({
    [STORAGE_KEY]: DEFAULT_ENABLED,
    [SMOOTH_OVERLAY_STORAGE_KEY]: false
  }, (items) => {
    enabled = Boolean(items[STORAGE_KEY]);
    smoothOverlayEnabled = Boolean(items[SMOOTH_OVERLAY_STORAGE_KEY]);
    mountControls();
    updateButtons();
    applyRenderMode();

    if (smoothOverlayEnabled) {
      startSmoothOverlay("restore");
    }
  });
}

function writePreference(nextEnabled) {
  const previousEnabled = enabled;
  const previousCompareMode = compareMode;
  const previousEnabledBeforeCompare = enabledBeforeCompare;

  compareMode = false;
  enabled = nextEnabled;
  enabledBeforeCompare = enabled;
  updateButtons();
  applyRenderMode();
  showPlayerToast(nextEnabled ? t("toastRestoringVsr") : t("toastSwitchingNonVsr"));

  chrome.runtime.sendMessage({
    type: "switchMode",
    enabled: nextEnabled,
    url: window.location.href
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      enabled = previousEnabled;
      compareMode = previousCompareMode;
      enabledBeforeCompare = previousEnabledBeforeCompare;
      updateButtons();
      applyRenderMode();
      showPlayerToast(getSwitchErrorMessage(response));
      return;
    }

    showPlayerToast(nextEnabled ? t("toastRestoredVsr") : t("toastSwitchedNonVsr"));
  });
}

function setCompareMode(nextCompareMode) {
  if (nextCompareMode && !compareMode) {
    enabledBeforeCompare = enabled;
    compareMode = true;
    enabled = true;
  } else if (!nextCompareMode && compareMode) {
    compareMode = false;
    enabled = enabledBeforeCompare;
  } else {
    compareMode = nextCompareMode;
  }

  updateButtons();
  applyRenderMode();
  showPlayerToast(compareMode ? t("toastCompareOn") : t("toastCompareOff"));
}

function scheduleMount() {
  window.clearTimeout(mountTimer);
  mountTimer = window.setTimeout(mountControls, MOUNT_DEBOUNCE_MS);
}

function mountControls() {
  const controlsList = document.querySelectorAll(".ytp-right-controls");

  controlsList.forEach((controls) => {
    const settingsButton = controls.querySelector(".ytp-settings-button");
    const anchor = settingsButton
      ? Array.from(controls.children).find((child) => child === settingsButton || child.contains(settingsButton))
      : null;

    if (!controls.querySelector(".rtx-vsr-toggle")) {
      insertPlayerButton(controls, anchor, createToggleButton());
    }

    if (!controls.querySelector(`.${COMPARE_BUTTON_CLASS}`)) {
      insertPlayerButton(controls, anchor, createCompareButton());
    }

    if (!controls.querySelector(`.${SMOOTH_BUTTON_CLASS}`)) {
      insertPlayerButton(controls, anchor, createSmoothButton());
    }
  });

  updateButtons();
  applyRenderMode();
}

function insertPlayerButton(controls, anchor, button) {
  if (anchor) {
    controls.insertBefore(button, anchor);
    return;
  }

  controls.prepend(button);
}

function createToggleButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "ytp-button rtx-vsr-toggle";

  const icon = document.createElement("span");
  icon.className = "rtx-vsr-toggle__icon";
  icon.setAttribute("aria-hidden", "true");

  const svg = createSvgElement("svg", {
    viewBox: "0 0 36 36",
    focusable: "false"
  });

  svg.append(
    createSvgElement("path", {
      class: "rtx-vsr-toggle__chip",
      d: "M11 7h14a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H11a4 4 0 0 1-4-4V11a4 4 0 0 1 4-4Z"
    }),
    createSvgElement("path", {
      class: "rtx-vsr-toggle__trace",
      d: "M13 14h10M13 18h6M13 22h10"
    }),
    createSvgElement("path", {
      class: "rtx-vsr-toggle__spark",
      d: "M26 7v5M23.5 9.5h5M29 24l2 2M31 22l-2 2"
    })
  );

  icon.append(svg);
  button.append(icon);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    writePreference(!enabled);
  });

  return button;
}

function createCompareButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ytp-button ${COMPARE_BUTTON_CLASS}`;

  const icon = document.createElement("span");
  icon.className = "rtx-vsr-toggle__icon";
  icon.setAttribute("aria-hidden", "true");

  const svg = createSvgElement("svg", {
    viewBox: "0 0 36 36",
    focusable: "false"
  });

  svg.append(
    createSvgElement("path", {
      class: "rtx-vsr-toggle__chip",
      d: "M8 7h20a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V10a3 3 0 0 1 3-3Z"
    }),
    createSvgElement("path", {
      class: "rtx-vsr-toggle__trace",
      d: "M18 8v20"
    }),
    createSvgElement("path", {
      class: "rtx-vsr-toggle__spark",
      d: "M12 14h3M12 18h3M12 22h3M21 14h3M21 18h3M21 22h3"
    })
  );

  icon.append(svg);
  button.append(icon);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setCompareMode(!compareMode);
  });

  return button;
}

function createSmoothButton() {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ytp-button ${SMOOTH_BUTTON_CLASS}`;

  const icon = document.createElement("span");
  icon.className = "rtx-vsr-toggle__icon";
  icon.setAttribute("aria-hidden", "true");

  const svg = createSvgElement("svg", {
    viewBox: "0 0 36 36",
    focusable: "false"
  });

  svg.append(
    createSvgElement("path", {
      class: "rtx-vsr-toggle__chip",
      d: "M9 8h18a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H9a3 3 0 0 1-3-3V11a3 3 0 0 1 3-3Z"
    }),
    createSvgElement("path", {
      class: "rtx-vsr-toggle__trace",
      d: "M13 23V13l8 5-8 5Z"
    }),
    createSvgElement("path", {
      class: "rtx-vsr-toggle__spark",
      d: "M23 13h4M23 18h6M23 23h4"
    })
  );

  icon.append(svg);
  button.append(icon);

  ["pointerdown", "mousedown", "mouseup", "touchstart", "touchend"].forEach((eventName) => {
    button.addEventListener(eventName, (event) => {
      event.stopPropagation();
    }, true);
  });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleSmoothOverlayFromPlayer();
  }, true);

  return button;
}

function createSvgElement(name, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);

  Object.entries(attributes).forEach(([key, value]) => {
    element.setAttribute(key, value);
  });

  return element;
}

function updateButtons() {
  const buttons = document.querySelectorAll(".rtx-vsr-toggle");
  const title = enabled
    ? t("buttonVsrEnabledTitle")
    : t("buttonVsrDisabledTitle");

  buttons.forEach((button) => {
    button.classList.toggle("is-enabled", enabled);
    button.classList.toggle("is-disabled", !enabled);
    button.setAttribute("aria-label", title);
    button.setAttribute("aria-pressed", String(enabled));
    button.title = title;
  });

  const compareButtons = document.querySelectorAll(`.${COMPARE_BUTTON_CLASS}`);
  const compareTitle = compareMode
    ? t("compareEnabledTitle")
    : t("compareDisabledTitle");

  compareButtons.forEach((button) => {
    button.classList.toggle("is-enabled", compareMode);
    button.classList.toggle("is-disabled", !compareMode);
    button.setAttribute("aria-label", compareTitle);
    button.setAttribute("aria-pressed", String(compareMode));
    button.title = compareTitle;
  });

  const smoothButtons = document.querySelectorAll(`.${SMOOTH_BUTTON_CLASS}`);
  const smoothTitle = smoothOverlayEnabled
    ? t("smoothEnabledTitle")
    : t("smoothDisabledTitle");

  smoothButtons.forEach((button) => {
    button.classList.toggle("is-enabled", smoothOverlayEnabled);
    button.classList.toggle("is-disabled", !smoothOverlayEnabled);
    button.classList.toggle("is-busy", smoothOverlayBusy);
    button.disabled = smoothOverlayBusy;
    button.setAttribute("aria-label", smoothTitle);
    button.setAttribute("aria-pressed", String(smoothOverlayEnabled));
    button.title = smoothTitle;
  });
}

function getSwitchErrorMessage(response) {
  if (response?.installRequired) {
    return t("localSwitcherInstallFirst");
  }

  if (response?.error) {
    return t("switchFailedWithError", response.error);
  }

  if (chrome.runtime.lastError) {
    return t("switchFailedWithError", chrome.runtime.lastError.message);
  }

  return t("switchFailed");
}

function showPlayerToast(message) {
  const player = document.querySelector(".html5-video-player") || document.body;
  let toast = player.querySelector(".rtx-vsr-toast");

  if (!toast) {
    toast = document.createElement("div");
    toast.className = "rtx-vsr-toast";
    player.appendChild(toast);
  }

  toast.textContent = message;
  toast.classList.add("is-visible");

  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("is-visible");
  }, TOAST_DURATION_MS);
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEY)) {
    enabled = Boolean(changes[STORAGE_KEY].newValue);
    compareMode = false;
    enabledBeforeCompare = enabled;
    updateButtons();
    applyRenderMode();
  }

  if (Object.prototype.hasOwnProperty.call(changes, SMOOTH_OVERLAY_STORAGE_KEY)) {
    const nextEnabled = Boolean(changes[SMOOTH_OVERLAY_STORAGE_KEY].newValue);
    if (nextEnabled !== smoothOverlayEnabled) {
      smoothOverlayEnabled = nextEnabled;
      updateButtons();
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type === undefined) {
    return false;
  }

  if (message.type === "pauseForSwitch") {
    sendResponse(pauseVideoForSwitch());
    return false;
  }

  if (message.type === "resumeAfterFailedSwitch") {
    sendResponse(resumeVideoAfterFailedSwitch());
    return false;
  }

  if (message.type === "setSmoothOverlay") {
    setSmoothOverlay(Boolean(message.enabled)).then(sendResponse);
    return true;
  }

  return false;
});

const observer = new MutationObserver(scheduleMount);

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

window.addEventListener("yt-navigate-finish", () => {
  scheduleMount();
  handleSmoothNavigation();
});
window.addEventListener("yt-navigate-start", () => {
  if (smoothOverlayEnabled) {
    setSmoothSuppressReason("navigation", true);
    syncSmoothOverlayNow("navigation-start");
  }
});
window.addEventListener("yt-page-data-updated", scheduleMount);
document.addEventListener("fullscreenchange", scheduleMount);
window.addEventListener("pagehide", stopSmoothOverlayForPageExit);
window.addEventListener("beforeunload", stopSmoothOverlayForPageExit);

readPreference();
scheduleMount();

async function setSmoothOverlay(nextEnabled) {
  if (nextEnabled) {
    return startSmoothOverlay("manual");
  }

  return stopSmoothOverlay("manual");
}

async function toggleSmoothOverlayFromPlayer() {
  if (smoothOverlayBusy) {
    return;
  }

  const previousEnabled = smoothOverlayEnabled;
  const nextEnabled = !smoothOverlayEnabled;
  smoothOverlayBusy = true;
  updateButtons();
  showPlayerToast(nextEnabled ? t("popupStartingSmooth") : t("popupStoppingSmooth"));

  try {
    const response = await setSmoothOverlay(nextEnabled);
    if (!response?.ok) {
      smoothOverlayEnabled = previousEnabled;
      updateButtons();
      showPlayerToast(getSwitchErrorMessage(response));
    }
  } catch (error) {
    smoothOverlayEnabled = previousEnabled;
    updateButtons();
    showPlayerToast(getSwitchErrorMessage({ error: error?.message || String(error) }));
  } finally {
    smoothOverlayBusy = false;
    updateButtons();
  }
}

async function startSmoothOverlay(reason) {
  smoothSeekSerial += 1;
  smoothOverlayEnabled = true;
  const state = await waitForSmoothOverlayState(reason, false);
  if (!state) {
    smoothOverlayEnabled = false;
    updateButtons();
    showPlayerToast(t("noSyncVideoToast"));
    return { ok: false, error: t("noVideoAvailable") };
  }

  smoothUrl = state.url;
  updateButtons();
  showPlayerToast(t("smoothStarting"));

  const response = await sendRuntimeMessage({
    type: "smoothOverlayStart",
    ...state
  });

  if (!response?.ok) {
    smoothOverlayEnabled = false;
    updateButtons();
    showPlayerToast(getSwitchErrorMessage(response));
    return response || { ok: false, error: t("noResponse") };
  }

  attachSmoothOverlaySync();
  refreshSmoothOverlaySuppression();
  showPlayerToast(t("smoothEnabledToast"));
  queueSmoothOverlaySync("started");
  return response;
}

async function stopSmoothOverlay(reason) {
  smoothOverlayEnabled = false;
  smoothUrl = "";
  detachSmoothOverlaySync();
  updateButtons();

  const response = await sendRuntimeMessage({
    type: "smoothOverlayStop",
    reason
  });

  showPlayerToast(response?.ok ? t("smoothDisabledToast") : getSwitchErrorMessage(response));
  return response || { ok: false, error: t("noResponse") };
}

function attachSmoothOverlaySync() {
  detachSmoothOverlaySync();

  const syncNow = (event) => {
    if (event?.type === "seeking" || event?.type === "seeked" || event?.type === "loadedmetadata") {
      smoothSeekSerial += 1;
    }

    refreshSmoothOverlaySuppression();
    queueSmoothOverlaySync(event?.type || "event");
  };

  const events = [
    "play",
    "playing",
    "pause",
    "ended",
    "waiting",
    "seeking",
    "seeked",
    "loadedmetadata",
    "ratechange",
    "volumechange",
    "resize"
  ];

  const attachVideoEvents = () => {
    const video = getActiveSmoothVideo();
    if (!video || video === smoothAttachedVideo) {
      return;
    }

    smoothAttachedVideo = video;
    events.forEach((eventName) => {
      video.addEventListener(eventName, syncNow);
      smoothCleanupCallbacks.push(() => video.removeEventListener(eventName, syncNow));
    });
  };

  attachVideoEvents();

  const layoutEvents = ["resize", "scroll", "fullscreenchange", "visibilitychange"];
  layoutEvents.forEach((eventName) => {
    const target = eventName === "resize" || eventName === "scroll" ? window : document;
    const onLayout = (event) => {
      if (event?.type === "visibilitychange" && document.hidden) {
        syncSmoothOverlayNow("document-hidden");
        return;
      }

      syncNow(event);
    };
    target.addEventListener(eventName, onLayout, true);
    smoothCleanupCallbacks.push(() => target.removeEventListener(eventName, onLayout, true));
  });

  const interactionEvents = [
    "pointermove",
    "mousemove",
    "pointerdown",
    "pointerup",
    "pointercancel",
    "click",
    "dblclick",
    "contextmenu",
    "keydown",
    "keyup",
    "wheel",
    "touchstart",
    "touchend",
    "touchcancel",
    "focusin",
    "focusout"
  ];
  const onInteraction = (event) => {
    attachVideoEvents();
    handleSmoothInteractionEvent(event);
  };
  interactionEvents.forEach((eventName) => {
    document.addEventListener(eventName, onInteraction, true);
    smoothCleanupCallbacks.push(() => document.removeEventListener(eventName, onInteraction, true));
  });

  smoothInteractionObserver = new MutationObserver(() => {
    attachVideoEvents();
    refreshSmoothOverlaySuppression();
    queueSmoothOverlaySync("dom-state");
  });

  updateSmoothInteractionObserver();

  smoothSyncTimer = window.setInterval(() => {
    attachVideoEvents();
    updateSmoothInteractionObserver();
    refreshSmoothOverlaySuppression();
    queueSmoothOverlaySync("timer");
  }, 750);
}

function detachSmoothOverlaySync() {
  if (smoothSyncTimer) {
    window.clearInterval(smoothSyncTimer);
    smoothSyncTimer = 0;
  }

  smoothCleanupCallbacks.forEach((cleanup) => cleanup());
  smoothCleanupCallbacks = [];
  smoothSyncQueued = false;
  smoothLastVisibleSent = null;
  smoothAttachedVideo = null;
  smoothPointerInsidePlayer = false;
  updateSmoothControlsAssist(false);

  if (smoothInteractionObserver) {
    smoothInteractionObserver.disconnect();
    smoothInteractionObserver = null;
  }
  smoothObservedPlayer = null;

  if (smoothResumeTimer) {
    window.clearTimeout(smoothResumeTimer);
    smoothResumeTimer = 0;
  }

  smoothSuppressionTimers.forEach((timer) => window.clearTimeout(timer));
  smoothSuppressionTimers = new Map();
  smoothSuppressionReasons = new Set();
}

function updateSmoothInteractionObserver() {
  if (!smoothInteractionObserver) {
    return;
  }

  const player = getActiveSmoothPlayer();
  if (player === smoothObservedPlayer) {
    return;
  }

  smoothInteractionObserver.disconnect();
  smoothObservedPlayer = player;

  if (player) {
    smoothInteractionObserver.observe(player, {
      attributes: true,
      attributeFilter: ["class", "style"],
      childList: true,
      subtree: true
    });
  }
}

function handleSmoothInteractionEvent(event) {
  if (!smoothOverlayEnabled) {
    return;
  }

  const video = getActiveSmoothVideo();
  const player = getSmoothPlayerForVideo(video);
  if (!video || !player) {
    return;
  }

  if (event.type === "keydown" || event.type === "keyup") {
    handleSmoothKeyboardEvent(event, player);
    return;
  }

  const inPlayer = isSmoothEventInPlayer(event, player);
  if (!inPlayer) {
    if (smoothPointerInsidePlayer) {
      smoothPointerInsidePlayer = false;
      setSmoothSuppressReason("pointer-over-control", false);
      scheduleSmoothVisibilitySync("pointer-leave");
    }
    return;
  }

  smoothPointerInsidePlayer = true;

  if (event.type === "contextmenu") {
    setSmoothSuppressReason("contextmenu", true, SMOOTH_CONTEXT_MENU_IDLE_MS);
    syncSmoothOverlayNow("contextmenu-hide");
    return;
  }

  if (
    event.type === "pointermove" ||
    event.type === "mousemove" ||
    event.type === "wheel" ||
    event.type === "touchstart" ||
    event.type === "focusin" ||
    event.type === "click" ||
    event.type === "dblclick"
  ) {
    setSmoothSuppressReason("pointer-active", true, SMOOTH_POINTER_IDLE_MS);
  }

  if (event.type === "pointerdown" || event.type === "touchstart") {
    setSmoothSuppressReason("pointer-active", true, SMOOTH_POINTER_IDLE_MS);
    if (isSmoothControlTarget(event, player)) {
      setSmoothSuppressReason("dragging", true);
    }
  }

  if (event.type === "pointerup" || event.type === "pointercancel" || event.type === "touchend" || event.type === "touchcancel") {
    setSmoothSuppressReason("dragging", false);
    setSmoothSuppressReason("pointer-active", true, SMOOTH_POINTER_IDLE_MS);
  }

  setSmoothSuppressReason("pointer-over-control", isSmoothControlTarget(event, player));
  refreshSmoothOverlaySuppression();
}

function handleSmoothKeyboardEvent(event, player) {
  if (isEditableTarget(event.target)) {
    return;
  }

  const activeElement = document.activeElement;
  const playerHasFocus = activeElement && (player === activeElement || player.contains(activeElement));
  const fullscreenElement = document.fullscreenElement;
  const fullscreenPlayer = fullscreenElement && (fullscreenElement === player || fullscreenElement.contains(player));

  if (!playerHasFocus && !fullscreenPlayer) {
    return;
  }

  if (event.type === "keyup") {
    setSmoothSuppressReason("keyboard-active", true, SMOOTH_KEYBOARD_IDLE_MS);
    return;
  }

  const key = event.key;
  const isSeekKey = key === "ArrowLeft" || key === "ArrowRight" || key === "j" || key === "J" || key === "l" || key === "L" || /^[0-9]$/.test(key);
  const isPlayerKey = isSeekKey ||
    key === " " ||
    key === "k" ||
    key === "K" ||
    key === "m" ||
    key === "M" ||
    key === "c" ||
    key === "C" ||
    key === "f" ||
    key === "F" ||
    key === "t" ||
    key === "T" ||
    key === "i" ||
    key === "I" ||
    key === "ArrowUp" ||
    key === "ArrowDown" ||
    key === "Home" ||
    key === "End";

  if (!isPlayerKey) {
    return;
  }

  setSmoothSuppressReason("keyboard-active", true, isSeekKey ? SMOOTH_POINTER_IDLE_MS : SMOOTH_KEYBOARD_IDLE_MS);
  if (isSeekKey) {
    setSmoothSuppressReason("dragging", true, SMOOTH_POINTER_IDLE_MS);
  }
}

function refreshSmoothOverlaySuppression() {
  const video = getActiveSmoothVideo();
  const player = getSmoothPlayerForVideo(video);

  setSmoothSuppressReason("paused-ended", Boolean(video && (video.paused || video.ended)));
  setSmoothSuppressReason("menu-open", Boolean(player && hasVisibleSmoothElement(player, ".ytp-popup,.ytp-panel,.ytp-settings-menu,.ytp-contextmenu")));
  setSmoothSuppressReason("ad-ui", Boolean(player && isSmoothAdUiVisible(player)));
  setSmoothSuppressReason("end-screen", Boolean(video?.ended || (player && hasVisibleSmoothElement(player, ".ytp-endscreen-content,.ytp-ce-element"))));
  updateSmoothControlsAssist();

  if (!video || !player || document.hidden) {
    scheduleSmoothVisibilitySync("state-refresh");
    return;
  }

  if (smoothSuppressionReasons.size === 0 && !isSmoothPlayerIdle(player)) {
    scheduleSmoothResumeCheck();
  }
}

function setSmoothSuppressReason(reason, active, ttl = 0) {
  if (smoothSuppressionTimers.has(reason)) {
    window.clearTimeout(smoothSuppressionTimers.get(reason));
    smoothSuppressionTimers.delete(reason);
  }

  const hadReason = smoothSuppressionReasons.has(reason);

  if (active) {
    smoothSuppressionReasons.add(reason);
    updateSmoothControlsAssist(true);
    if (ttl > 0) {
      smoothSuppressionTimers.set(reason, window.setTimeout(() => {
        smoothSuppressionTimers.delete(reason);
        setSmoothSuppressReason(reason, false);
      }, ttl));
    }

    if (!hadReason) {
      syncSmoothOverlayNow(`suppress-${reason}`);
    }
    return;
  }

  if (!hadReason) {
    return;
  }

  smoothSuppressionReasons.delete(reason);
  updateSmoothControlsAssist(smoothSuppressionReasons.size > 0);
  scheduleSmoothVisibilitySync(`release-${reason}`);
}

function updateSmoothControlsAssist(forceActive = null) {
  const active = forceActive == null
    ? smoothOverlayEnabled && smoothSuppressionReasons.size > 0
    : Boolean(forceActive && smoothOverlayEnabled);

  document.querySelectorAll(".html5-video-player").forEach((player) => {
    player.classList.toggle(SMOOTH_CONTROLS_ASSIST_CLASS, active);
  });
}

function scheduleSmoothResumeCheck() {
  if (smoothResumeTimer) {
    return;
  }

  smoothResumeTimer = window.setTimeout(() => {
    smoothResumeTimer = 0;
    refreshSmoothOverlaySuppression();
    scheduleSmoothVisibilitySync("resume-check");
  }, SMOOTH_RESUME_POLL_MS);
}

function scheduleSmoothVisibilitySync(reason) {
  if (!smoothOverlayEnabled) {
    return;
  }

  const nextVisible = shouldShowSmoothOverlay();
  if (nextVisible) {
    queueSmoothOverlaySync(reason);
    return;
  }

  syncSmoothOverlayNow(reason);
}

function syncSmoothOverlayNow(reason) {
  if (!smoothOverlayEnabled) {
    return;
  }

  smoothSyncQueued = false;
  syncSmoothOverlay(reason);
}

function shouldShowSmoothOverlay(video = getActiveSmoothVideo(), player = getSmoothPlayerForVideo(video)) {
  return Boolean(
    smoothOverlayEnabled &&
    !document.hidden &&
    video &&
    player &&
    !video.paused &&
    !video.ended &&
    smoothSuppressionReasons.size === 0 &&
    isSmoothPlayerIdle(player)
  );
}

function isSmoothPlayerIdle(player) {
  if (!player) {
    return true;
  }

  if (!smoothPointerInsidePlayer) {
    return true;
  }

  if (player.classList.contains("ytp-autohide")) {
    return true;
  }

  const chromeBottom = player.querySelector(".ytp-chrome-bottom");
  return !isElementVisible(chromeBottom);
}

function getActiveSmoothVideo() {
  const connectedVideos = Array.from(document.querySelectorAll("video")).filter((video) => video.isConnected);

  if (connectedVideos.length === 0) {
    return null;
  }

  if (bypassState.active && bypassState.video?.isConnected) {
    return bypassState.video;
  }

  const visibleVideos = connectedVideos.filter((video) => {
    const rect = video.getBoundingClientRect();
    return rect.width >= 16 && rect.height >= 16;
  });

  const playing = visibleVideos.find((video) => !video.paused && !video.ended && video.readyState >= 2);
  if (playing) {
    return playing;
  }

  const mainVideo = connectedVideos.find((video) => video.classList.contains("html5-main-video"));
  if (mainVideo) {
    return mainVideo;
  }

  const decodedPlaying = connectedVideos.find((video) => (
    !video.paused &&
    !video.ended &&
    video.readyState >= 2 &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  ));
  if (decodedPlaying) {
    return decodedPlaying;
  }

  if (visibleVideos.length === 0) {
    return connectedVideos
      .map((video) => ({ video, area: Math.max(1, video.videoWidth) * Math.max(1, video.videoHeight) }))
      .sort((a, b) => b.area - a.area)[0]?.video || null;
  }

  return visibleVideos
    .map((video) => ({ video, area: visibleArea(video.getBoundingClientRect()) }))
    .sort((a, b) => b.area - a.area)[0]?.video || null;
}

function getActiveSmoothPlayer() {
  return getSmoothPlayerForVideo(getActiveSmoothVideo());
}

function getSmoothPlayerForVideo(video) {
  if (!video) {
    return null;
  }

  return video.closest(".html5-video-player") ||
    document.querySelector(".html5-video-player") ||
    video.closest(".html5-video-container") ||
    video;
}

function visibleArea(rect) {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function isSmoothEventInPlayer(event, player) {
  if (!player) {
    return false;
  }

  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.includes(player)) {
    return true;
  }

  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    const rect = player.getBoundingClientRect();
    return event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom;
  }

  return event.target instanceof Node && player.contains(event.target);
}

function isSmoothControlTarget(event, player) {
  if (!player) {
    return false;
  }

  const selector = ".ytp-chrome-bottom,.ytp-chrome-top,.ytp-progress-bar-container,.ytp-progress-bar,.ytp-scrubber-container,.ytp-button,.ytp-volume-panel,.ytp-volume-slider,.ytp-tooltip,.ytp-popup,.ytp-panel,.ytp-settings-menu,.ytp-contextmenu,.ytp-cards-teaser,.ytp-cards-button,.ytp-ce-element,.ytp-endscreen-content,.ytp-ad-overlay-container,.ytp-ad-player-overlay,.ytp-ad-skip-button,.ytp-ad-skip-button-container,.ytp-ad-skip-button-modern";
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  if (path.some((node) => node instanceof Element && node.closest?.(selector))) {
    return true;
  }

  if (typeof event.clientX === "number" && typeof event.clientY === "number") {
    const element = document.elementFromPoint(event.clientX, event.clientY);
    return Boolean(element && player.contains(element) && element.closest(selector));
  }

  return false;
}

function isSmoothAdUiVisible(player) {
  if (!player) {
    return false;
  }

  if (player.classList.contains("ad-showing") || player.classList.contains("ad-interrupting")) {
    return true;
  }

  return hasVisibleSmoothElement(
    player,
    ".ytp-ad-overlay-container,.ytp-ad-player-overlay,.ytp-ad-skip-button,.ytp-ad-skip-button-container,.ytp-ad-skip-button-modern,.ytp-ad-preview-container"
  );
}

function hasVisibleSmoothElement(root, selector) {
  return Array.from(root.querySelectorAll(selector)).some(isElementVisible);
}

function isElementVisible(element) {
  if (!element || !element.isConnected) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || 1) > 0.02;
}

function isEditableTarget(target) {
  return target instanceof Element &&
    (target.matches("input,textarea,select") || target.isContentEditable);
}

function queueSmoothOverlaySync(reason) {
  if (!smoothOverlayEnabled || smoothSyncQueued) {
    return;
  }

  smoothSyncQueued = true;
  window.requestAnimationFrame(() => {
    smoothSyncQueued = false;
    syncSmoothOverlay(reason);
  });
}

async function syncSmoothOverlay(reason) {
  if (!smoothOverlayEnabled) {
    return;
  }

  refreshSmoothOverlaySuppression();
  const state = getSmoothOverlayState(reason, false);
  if (!state) {
    return;
  }

  smoothLastVisibleSent = state.playback.visible;

  if (smoothUrl && state.url !== smoothUrl) {
    smoothSeekSerial += 1;
    smoothUrl = state.url;
    await sendRuntimeMessage({
      type: "smoothOverlayStart",
      ...state
    });
    return;
  }

  await sendRuntimeMessage({
    type: "smoothOverlaySync",
    ...state
  });
}

async function waitForSmoothOverlayState(reason, forceSeek) {
  const started = performance.now();

  while (performance.now() - started <= SMOOTH_START_WAIT_MS) {
    const state = getSmoothOverlayState(reason, forceSeek);
    if (state) {
      return state;
    }

    await new Promise((resolve) => window.setTimeout(resolve, SMOOTH_START_POLL_MS));
  }

  return null;
}

function getSmoothOverlayState(reason, forceSeek) {
  const video = getActiveSmoothVideo();
  if (!video) {
    return null;
  }

  const player = getSmoothPlayerForVideo(video);
  const rect = getSmoothOverlayRect(video, player);
  if (!rect || rect.width < 16 || rect.height < 16) {
    return null;
  }

  const shouldShowOverlay = shouldShowSmoothOverlay(video, player);

  return {
    url: window.location.href,
    reason,
    rect: cssRectToScreenRect(rect),
    windowRect: cssWindowRect(),
    relativeRect: cssRectToWindowRect(rect),
    playback: {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: Boolean(video.paused || video.ended),
      volume: Number.isFinite(video.volume) ? video.volume : 1,
      muted: Boolean(video.muted),
      playbackRate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      seekSerial: forceSeek ? smoothSeekSerial + 1 : smoothSeekSerial,
      visible: shouldShowOverlay,
      suppressReasons: Array.from(smoothSuppressionReasons)
    }
  };
}

function getSmoothOverlayRect(video, player) {
  const candidates = [
    bypassState.active && bypassState.container?.isConnected ? bypassState.container : null,
    player?.isConnected ? player : null,
    video
  ].filter(Boolean);

  for (const candidate of candidates) {
    const rect = candidate.getBoundingClientRect();
    if (rect.width >= 16 && rect.height >= 16) {
      return rect;
    }
  }

  return null;
}

function cssWindowRect() {
  const scale = Math.max(window.devicePixelRatio || 1, 1);
  return {
    x: Math.round(window.screenX * scale),
    y: Math.round(window.screenY * scale),
    width: Math.max(1, Math.round(window.outerWidth * scale)),
    height: Math.max(1, Math.round(window.outerHeight * scale))
  };
}

function cssRectToWindowRect(rect) {
  const borderX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const topChrome = Math.max(0, window.outerHeight - window.innerHeight - borderX);
  const scale = Math.max(window.devicePixelRatio || 1, 1);

  return {
    x: Math.round((borderX + rect.left) * scale),
    y: Math.round((topChrome + rect.top) * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale))
  };
}

function cssRectToScreenRect(rect) {
  const borderX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const topChrome = Math.max(0, window.outerHeight - window.innerHeight - borderX);
  const scale = Math.max(window.devicePixelRatio || 1, 1);

  return {
    x: Math.round((window.screenX + borderX + rect.left) * scale),
    y: Math.round((window.screenY + topChrome + rect.top) * scale),
    width: Math.max(1, Math.round(rect.width * scale)),
    height: Math.max(1, Math.round(rect.height * scale))
  };
}

function handleSmoothNavigation() {
  if (!smoothOverlayEnabled) {
    return;
  }

  smoothSeekSerial += 1;
  window.setTimeout(() => {
    if (smoothOverlayEnabled) {
      if (document.querySelector("video")) {
        setSmoothSuppressReason("navigation", false);
        startSmoothOverlay("navigation");
      } else {
        stopSmoothOverlay("navigation-no-video");
      }
    }
  }, 1200);
}

function stopSmoothOverlayForPageExit() {
  if (!smoothOverlayEnabled) {
    return;
  }

  smoothOverlayEnabled = false;
  smoothUrl = "";
  detachSmoothOverlaySync();
  chrome.runtime.sendMessage({
    type: "smoothOverlayStop",
    reason: "page-exit"
  }, () => {});
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          ok: false,
          error: chrome.runtime.lastError.message
        });
        return;
      }

      resolve(response);
    });
  });
}

function pauseVideoForSwitch() {
  const video = document.querySelector("video");

  if (!video) {
    lastPausedForSwitch = null;
    return { ok: false, skipped: true, reason: "no-video" };
  }

  const wasPaused = video.paused;
  const state = {
    ok: true,
    skipped: false,
    didPause: !wasPaused,
    wasPaused,
    currentTime: video.currentTime,
    readyState: video.readyState,
    videoWidth: video.videoWidth,
    videoHeight: video.videoHeight
  };

  if (!wasPaused) {
    video.pause();
    lastPausedForSwitch = video;
  } else {
    lastPausedForSwitch = null;
  }

  return state;
}

function resumeVideoAfterFailedSwitch() {
  const video = lastPausedForSwitch;
  lastPausedForSwitch = null;

  if (!video) {
    return { ok: true, skipped: true, reason: "nothing-to-resume" };
  }

  video.play().catch(() => {});
  return { ok: true, skipped: false };
}

function applyRenderMode() {
  if (compareMode) {
    enableCanvasBypass("compare");
    queueSmoothOverlaySync("render-mode-compare");
    return;
  }

  if (enabled) {
    disableCanvasBypass();
    queueSmoothOverlaySync("render-mode-native");
    return;
  }

  enableCanvasBypass("full");
  queueSmoothOverlaySync("render-mode-canvas");
}

function enableCanvasBypass(mode) {
  const video = document.querySelector("video");

  if (!video) {
    return;
  }

  const player = document.querySelector(".html5-video-player") || video.closest(".html5-video-container") || video.parentElement;
  if (!player) {
    return;
  }

  if (
    bypassState.active &&
    bypassState.mode === mode &&
    bypassState.video === video &&
    bypassState.container === player &&
    bypassState.canvas?.isConnected
  ) {
    updateCompareSplit();
    return;
  }

  disableCanvasBypass();

  const canvas = document.createElement("canvas");
  canvas.className = BYPASS_CANVAS_CLASS;
  canvas.classList.toggle(COMPARE_CANVAS_CLASS, mode === "compare");
  player.append(canvas);
  player.classList.add(BYPASS_HOST_CLASS);
  player.classList.toggle(COMPARE_HOST_CLASS, mode === "compare");

  if (mode === "full") {
    video.classList.add(BYPASS_SOURCE_CLASS);
  } else {
    video.classList.remove(BYPASS_SOURCE_CLASS);
  }

  const divider = mode === "compare" ? createCompareDivider(player) : null;

  bypassState = {
    active: true,
    mode,
    canvas,
    context: canvas.getContext("2d", { alpha: false }),
    container: player,
    divider,
    video,
    frameHandle: 0,
    frameKind: null,
    drawQueued: false,
    queuedDrawHandle: 0,
    resizeObserver: null,
    cleanupCallbacks: []
  };

  attachBypassLifecycle();
  updateCompareSplit();
  drawBypassFrame();
}

function createCompareDivider(player) {
  const divider = document.createElement("div");
  divider.className = COMPARE_DIVIDER_CLASS;
  divider.tabIndex = 0;
  divider.setAttribute("role", "slider");
  divider.setAttribute("aria-label", t("compareDividerAriaLabel"));
  divider.setAttribute("aria-orientation", "horizontal");

  const setFromClientX = (clientX) => {
    const rect = player.getBoundingClientRect();
    if (rect.width <= 0) {
      return;
    }

    splitRatio = clamp((clientX - rect.left) / rect.width, SPLIT_MIN, SPLIT_MAX);
    updateCompareSplit();
  };

  divider.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setFromClientX(event.clientX);

    try {
      divider.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic test events do not always have a capturable pointer.
    }
  });

  divider.addEventListener("pointermove", (event) => {
    if (event.buttons !== 1 && !divider.hasPointerCapture(event.pointerId)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    setFromClientX(event.clientX);
  });

  divider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    event.preventDefault();
    const step = event.shiftKey ? 0.1 : 0.02;
    splitRatio = clamp(splitRatio + (event.key === "ArrowRight" ? step : -step), SPLIT_MIN, SPLIT_MAX);
    updateCompareSplit();
  });

  player.append(divider);
  return divider;
}

function updateCompareSplit() {
  if (!bypassState.container) {
    return;
  }

  const percent = `${Math.round(splitRatio * 10000) / 100}%`;
  bypassState.container.style.setProperty("--rtx-vsr-split", percent);

  if (bypassState.divider) {
    const rect = bypassState.container.getBoundingClientRect();
    const halfHandle = bypassState.divider.offsetWidth / 2 || 14;
    const splitPx = rect.width * splitRatio;
    const hitPx = rect.width > halfHandle * 2
      ? clamp(splitPx, halfHandle, rect.width - halfHandle)
      : splitPx;
    const lineOffset = halfHandle + splitPx - hitPx;

    bypassState.divider.style.left = `${hitPx}px`;
    bypassState.divider.style.setProperty("--rtx-vsr-line-offset", `${lineOffset}px`);
    bypassState.divider.setAttribute("aria-valuemin", String(Math.round(SPLIT_MIN * 100)));
    bypassState.divider.setAttribute("aria-valuemax", String(Math.round(SPLIT_MAX * 100)));
    bypassState.divider.setAttribute("aria-valuenow", String(Math.round(splitRatio * 100)));
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function disableCanvasBypass() {
  cancelBypassFrame();

  if (bypassState.queuedDrawHandle) {
    window.cancelAnimationFrame(bypassState.queuedDrawHandle);
  }

  bypassState.cleanupCallbacks.forEach((cleanup) => cleanup());

  if (bypassState.resizeObserver) {
    bypassState.resizeObserver.disconnect();
  }

  if (bypassState.video) {
    bypassState.video.classList.remove(BYPASS_SOURCE_CLASS);
  }

  if (bypassState.video && Object.prototype.hasOwnProperty.call(bypassState.video.dataset, PREVIOUS_OPACITY_KEY)) {
    bypassState.video.style.opacity = bypassState.video.dataset[PREVIOUS_OPACITY_KEY];
    delete bypassState.video.dataset[PREVIOUS_OPACITY_KEY];
  }

  if (bypassState.canvas) {
    bypassState.canvas.remove();
  }

  if (bypassState.divider) {
    bypassState.divider.remove();
  }

  if (bypassState.container) {
    bypassState.container.classList.remove(BYPASS_HOST_CLASS);
    bypassState.container.classList.remove(COMPARE_HOST_CLASS);
    bypassState.container.style.removeProperty("--rtx-vsr-split");
  }

  bypassState = {
    active: false,
    mode: null,
    canvas: null,
    context: null,
    container: null,
    divider: null,
    video: null,
    frameHandle: 0,
    frameKind: null,
    drawQueued: false,
    queuedDrawHandle: 0,
    resizeObserver: null,
    cleanupCallbacks: []
  };
}

function drawBypassFrame() {
  const { active, canvas, context, video } = bypassState;

  if (!active || !canvas || !context || !video || !video.isConnected) {
    disableCanvasBypass();
    return;
  }

  const rect = bypassState.container.getBoundingClientRect();
  const scale = Math.max(window.devicePixelRatio || 1, 1);
  const width = Math.max(1, Math.round(rect.width * scale));
  const height = Math.max(1, Math.round(rect.height * scale));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  context.fillStyle = "#000";
  context.fillRect(0, 0, width, height);

  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    const videoAspect = video.videoWidth / video.videoHeight;
    const canvasAspect = width / height;
    let drawWidth = width;
    let drawHeight = height;

    if (videoAspect > canvasAspect) {
      drawHeight = width / videoAspect;
    } else {
      drawWidth = height * videoAspect;
    }

    const x = (width - drawWidth) / 2;
    const y = (height - drawHeight) / 2;

    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(video, x, y, drawWidth, drawHeight);
  }

  scheduleBypassFrame();
}

function attachBypassLifecycle() {
  const { video, container } = bypassState;
  const queueDraw = () => queueBypassDraw();
  const updateLayout = () => {
    updateCompareSplit();
    queueBypassDraw();
  };
  const events = ["loadeddata", "play", "playing", "pause", "seeked", "timeupdate", "resize", "ratechange"];

  events.forEach((eventName) => {
    video.addEventListener(eventName, queueDraw);
    bypassState.cleanupCallbacks.push(() => video.removeEventListener(eventName, queueDraw));
  });

  window.addEventListener("resize", updateLayout);
  document.addEventListener("fullscreenchange", updateLayout);
  bypassState.cleanupCallbacks.push(() => window.removeEventListener("resize", updateLayout));
  bypassState.cleanupCallbacks.push(() => document.removeEventListener("fullscreenchange", updateLayout));

  if (typeof ResizeObserver === "function") {
    bypassState.resizeObserver = new ResizeObserver(updateLayout);
    bypassState.resizeObserver.observe(container);
  }
}

function queueBypassDraw() {
  if (!bypassState.active || bypassState.drawQueued) {
    return;
  }

  bypassState.drawQueued = true;
  bypassState.queuedDrawHandle = window.requestAnimationFrame(() => {
    bypassState.drawQueued = false;
    bypassState.queuedDrawHandle = 0;
    drawBypassFrame();
  });
}

function scheduleBypassFrame() {
  if (!bypassState.active || !bypassState.video) {
    return;
  }

  cancelBypassFrame();

  if (bypassState.video.paused || bypassState.video.ended) {
    return;
  }

  if (typeof bypassState.video.requestVideoFrameCallback === "function") {
    bypassState.frameKind = "video";
    bypassState.frameHandle = bypassState.video.requestVideoFrameCallback(drawBypassFrame);
    return;
  }

  bypassState.frameKind = "animation";
  bypassState.frameHandle = window.requestAnimationFrame(drawBypassFrame);
}

function cancelBypassFrame() {
  if (!bypassState.frameHandle) {
    return;
  }

  if (bypassState.frameKind === "video" && typeof bypassState.video?.cancelVideoFrameCallback === "function") {
    bypassState.video.cancelVideoFrameCallback(bypassState.frameHandle);
  } else {
    window.cancelAnimationFrame(bypassState.frameHandle);
  }

  bypassState.frameHandle = 0;
  bypassState.frameKind = null;
}
