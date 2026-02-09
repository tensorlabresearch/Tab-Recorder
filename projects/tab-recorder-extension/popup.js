const tabList = document.getElementById("tab-list");
const statusEl = document.getElementById("status");
const folderInput = document.getElementById("folder-id");
const saveFolderButton = document.getElementById("save-folder");
const lastUploadEl = document.getElementById("last-upload");
const openUploadButton = document.getElementById("open-upload");
const monitorToggle = document.getElementById("monitor-audio");

let currentState = null;
let refreshInterval = null;

async function init() {
  await renderTabs();
  await refreshState();
  await loadFolderId();
  await loadMonitorSetting();

  refreshInterval = setInterval(async () => {
    await refreshState();
    await renderTabs();
  }, 1500);

  window.addEventListener("focus", () => {
    refreshState();
    renderTabs();
  });

  openUploadButton.addEventListener("click", async () => {
    if (currentState?.lastUpload?.webViewLink) {
      await chrome.tabs.create({ url: currentState.lastUpload.webViewLink });
    }
  });

  monitorToggle.addEventListener("change", async () => {
    await chrome.runtime.sendMessage({ type: "set-monitor", enabled: monitorToggle.checked });
  });

  saveFolderButton.addEventListener("click", async () => {
    const folderId = folderInput.value.trim();
    const storage = getStorageArea();
    await storage.set({ driveFolderId: folderId });
    saveFolderButton.textContent = "Saved";
    setTimeout(() => {
      saveFolderButton.textContent = "Save";
    }, 1200);
    await renderRecordDestination();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "state-changed") {
      currentState = message.payload;
      renderStatus();
      renderTabs();
    }
  });
}

async function renderTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  tabList.innerHTML = "";

  if (!tabs.length) {
    tabList.textContent = "No tabs found.";
    return;
  }

  const isRecording = currentState?.status === "recording" || currentState?.status === "starting";
  const recordingTabId = Number(currentState?.tabId);

  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = "tab";

    const icon = document.createElement("img");
    icon.src = tab.favIconUrl || "";
    icon.alt = "";

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = tab.title || tab.url || "Untitled";

    const button = document.createElement("button");
    const isActiveRecording = isRecording && Number.isFinite(recordingTabId) && tab.id === recordingTabId;
    button.textContent = isActiveRecording ? "Stop Record" : "Record";
    button.classList.toggle("recording", isActiveRecording);
    button.disabled = false;

    button.addEventListener("click", async () => {
      if (isActiveRecording) {
        await chrome.runtime.sendMessage({ type: "stop-recording" });
      } else {
        await chrome.runtime.sendMessage({ type: "start-recording", tabId: tab.id });
      }
      await refreshState();
    });

    row.append(icon, title, button);
    tabList.append(row);
  }
}

async function refreshState() {
  currentState = await chrome.runtime.sendMessage({ type: "get-state" });
  renderStatus();
  monitorToggle.checked = Boolean(currentState?.monitorEnabled);
}

async function loadFolderId() {
  const storage = getStorageArea();
  if (!storage) {
    folderInput.value = "";
    return;
  }
  const { driveFolderId } = await storage.get("driveFolderId");
  folderInput.value = driveFolderId || "";
}

async function loadMonitorSetting() {
  const storage = getStorageArea();
  if (!storage) {
    monitorToggle.checked = false;
    return;
  }
  const { monitorEnabled } = await storage.get("monitorEnabled");
  if (typeof monitorEnabled === "boolean") {
    monitorToggle.checked = monitorEnabled;
  } else {
    monitorToggle.checked = true;
    await storage.set({ monitorEnabled: true });
    await chrome.runtime.sendMessage({ type: "set-monitor", enabled: true });
  }
}

function getStorageArea() {
  if (!globalThis.chrome || !chrome.storage) return null;
  return chrome.storage.sync || chrome.storage.local || null;
}

function renderStatus() {
  const status = currentState?.status || "idle";
  const pill = document.createElement("span");
  pill.className = `pill ${status}`;
  pill.textContent = status;

  const text = document.createElement("div");

  if (status === "recording") {
    text.textContent = "Recording in progress. Audio + video will upload to Drive on stop.";
  } else if (status === "uploading") {
    text.textContent = "Uploading to Drive...";
  } else if (status === "error") {
    text.textContent = currentState?.lastError || "Upload failed.";
  } else {
    text.textContent = "Pick a tab to start recording.";
  }

  statusEl.innerHTML = "";
  statusEl.append(pill, text);

  stopButton.disabled = status !== "recording";
  renderLastUpload();
}

function renderLastUpload() {
  const lastUpload = currentState?.lastUpload;
  if (!lastUpload) {
    lastUploadEl.textContent = "No uploads yet.";
    openUploadButton.disabled = true;
    return;
  }

  const name = lastUpload.name || "tab-recording.webm";
  const id = lastUpload.id || "unknown id";
  lastUploadEl.textContent = `${name} (${id})`;
  openUploadButton.disabled = !lastUpload.webViewLink;
}

init();
