const OFFSCREEN_URL = "offscreen.html";

const STATE = {
  recording: false,
  tabId: null,
  startedAt: null,
  status: "idle",
  lastUpload: null,
  lastError: null,
  monitorEnabled: true
};

const MENU_IDS = {
  RECORD_TAB: "record-tab",
  STOP_RECORDING: "stop-recording"
};

chrome.runtime.onInstalled.addListener(() => {
  createContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_IDS.RECORD_TAB && tab?.id != null) {
    await startRecording(tab.id);
  }
  if (info.menuItemId === MENU_IDS.STOP_RECORDING) {
    await stopRecording("context-menu");
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (STATE.recording && STATE.tabId === tabId) {
    await stopRecording("tab-closed");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "get-state") {
    sendResponse(getStatePayload());
    return;
  }

  if (message.type === "start-recording") {
    startRecording(message.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "stop-recording") {
    stopRecording("popup")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "set-monitor") {
    STATE.monitorEnabled = Boolean(message.enabled);
    chrome.storage.local.set({ monitorEnabled: STATE.monitorEnabled });
    persistState();
    chrome.runtime.sendMessage({
      type: "offscreen-monitor",
      payload: { enabled: STATE.monitorEnabled }
    });
    chrome.runtime.sendMessage({ type: "state-changed", payload: getStatePayload() });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "offscreen-status") {
    handleOffscreenStatus(message.payload);
    return;
  }

  if (message.type === "get-auth-token") {
    getAuthToken()
      .then((token) => sendResponse({ ok: true, token }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

async function createContextMenus() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_IDS.RECORD_TAB,
    title: "Record this tab",
    contexts: ["page", "action"]
  });
  chrome.contextMenus.create({
    id: MENU_IDS.STOP_RECORDING,
    title: "Stop recording",
    contexts: ["page", "action"]
  });
  updateContextMenus();
}

function updateContextMenus() {
  const stopEnabled = STATE.recording;
  chrome.contextMenus.update(MENU_IDS.STOP_RECORDING, {
    enabled: stopEnabled,
    title: stopEnabled ? "Stop recording" : "Stop recording (inactive)"
  });
  chrome.contextMenus.update(MENU_IDS.RECORD_TAB, {
    enabled: !STATE.recording,
    title: STATE.recording ? "Record this tab (busy)" : "Record this tab"
  });
}

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (contexts.length > 0) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Record tab audio and video using MediaRecorder"
  });
}

async function startRecording(tabId) {
  if (STATE.recording) {
    await stopRecording("switch-tab");
  }

  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  STATE.recording = true;
  STATE.tabId = tabId;
  STATE.startedAt = Date.now();
  STATE.status = "starting";
  STATE.lastError = null;
  if (STATE.monitorEnabled) {
    chrome.runtime.sendMessage({
      type: "offscreen-monitor",
      payload: { enabled: true }
    });
  }
  await persistState();

  chrome.runtime.sendMessage({
    type: "offscreen-start",
    payload: { streamId, tabId }
  });

  updateBadge();
  updateContextMenus();
}

async function stopRecording(reason) {
  if (!STATE.recording) return;

  STATE.status = "stopping";
  await persistState();

  chrome.runtime.sendMessage({
    type: "offscreen-stop",
    payload: { reason }
  });
}

function handleOffscreenStatus(payload) {
  if (!payload) return;

  if (payload.event === "recording-started") {
    STATE.status = "recording";
    if (payload.data?.tabId != null) {
      STATE.tabId = payload.data.tabId;
    }
  }

  if (payload.event === "recording-stopped") {
    STATE.status = "uploading";
    STATE.recording = false;
    STATE.tabId = null;
    STATE.startedAt = null;
  }

  if (payload.event === "upload-complete") {
    STATE.status = "idle";
    STATE.recording = false;
    STATE.tabId = null;
    STATE.startedAt = null;
    STATE.lastUpload = payload.data || null;
  }

  if (payload.event === "upload-error") {
    STATE.status = "error";
    STATE.recording = false;
    STATE.tabId = null;
    STATE.startedAt = null;
    STATE.lastError = payload.error || "Upload failed";
  }

  persistState();
  updateBadge();
  updateContextMenus();
  chrome.runtime.sendMessage({ type: "state-changed", payload: getStatePayload() });
}

function updateBadge() {
  if (STATE.recording || STATE.status === "recording" || STATE.status === "uploading") {
    chrome.action.setBadgeText({ text: "REC" });
    chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function getStatePayload() {
  return {
    recording: STATE.recording,
    tabId: STATE.tabId,
    startedAt: STATE.startedAt,
    status: STATE.status,
    lastUpload: STATE.lastUpload,
    lastError: STATE.lastError,
    monitorEnabled: STATE.monitorEnabled
  };
}

async function persistState() {
  await chrome.storage.session.set({ recorderState: getStatePayload() });
}

function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError?.message || "Failed to get auth token");
        return;
      }
      resolve(token);
    });
  });
}

(async function restoreState() {
  const { recorderState } = await chrome.storage.session.get("recorderState");
  if (recorderState) {
    Object.assign(STATE, recorderState);
  }
  const { monitorEnabled } = await chrome.storage.local.get("monitorEnabled");
  if (typeof monitorEnabled === "boolean") {
    STATE.monitorEnabled = monitorEnabled;
  } else {
    STATE.monitorEnabled = true;
    chrome.storage.local.set({ monitorEnabled: true });
  }
  updateBadge();
  updateContextMenus();
})();
