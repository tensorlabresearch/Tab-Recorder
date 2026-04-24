import {
  isFileSystemAccessAvailable,
  selectSaveFolder,
  getSaveFolder,
  isLocalSaveEnabled,
  setLocalSaveEnabled,
  clearSaveFolder,
  getSupportedAudioFormats,
  getSupportedTranscriptFormats
} from "./lib/fileStorage.js";

const STORAGE_KEYS = {
  AUDIO_FORMAT: "localAudioFormat",
  TRANSCRIPT_FORMAT: "localTranscriptFormat"
};

const enableLocalSaveCheckbox = document.getElementById("enable-local-save");
const folderSection = document.getElementById("folder-section");
const folderPathEl = document.getElementById("folder-path");
const selectFolderBtn = document.getElementById("select-folder-btn");
const openFolderBtn = document.getElementById("open-folder-btn");
const clearFolderBtn = document.getElementById("clear-folder-btn");
const audioFormatSelect = document.getElementById("audio-format");
const transcriptFormatSelect = document.getElementById("transcript-format");
const browserWarningEl = document.getElementById("browser-warning");
const driveSettingsBtn = document.getElementById("drive-settings-btn");
const openNotesBtn = document.getElementById("open-notes-btn");
const toastEl = document.getElementById("toast");

let currentFolderHandle = null;

init().catch((error) => {
  showToast(`Error: ${error.message}`, "error");
});

async function init() {
  // Check if File System Access API is available
  const fsAvailable = isFileSystemAccessAvailable();
  if (!fsAvailable) {
    browserWarningEl.classList.remove("hidden");
    enableLocalSaveCheckbox.disabled = true;
  }

  // Load saved settings
  await loadSettings();

  // Setup event listeners
  enableLocalSaveCheckbox.addEventListener("change", onEnableLocalSaveChange);
  selectFolderBtn.addEventListener("click", onSelectFolder);
  openFolderBtn.addEventListener("click", onOpenFolder);
  clearFolderBtn.addEventListener("click", onClearFolder);
  audioFormatSelect.addEventListener("change", onAudioFormatChange);
  transcriptFormatSelect.addEventListener("change", onTranscriptFormatChange);
  driveSettingsBtn.addEventListener("click", onDriveSettings);
  openNotesBtn.addEventListener("click", onOpenNotes);
}

async function loadSettings() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return;

  // Load local save enabled state
  const localSaveEnabled = await isLocalSaveEnabled();
  enableLocalSaveCheckbox.checked = localSaveEnabled;

  // Load folder info
  const { name, handle } = await getSaveFolder();
  currentFolderHandle = handle;
  updateFolderDisplay(name);

  // Update UI based on enabled state
  updateFolderSectionState(localSaveEnabled);

  // Load format preferences
  const stored = await localStorage.get([
    STORAGE_KEYS.AUDIO_FORMAT,
    STORAGE_KEYS.TRANSCRIPT_FORMAT
  ]);

  if (stored[STORAGE_KEYS.AUDIO_FORMAT]) {
    audioFormatSelect.value = stored[STORAGE_KEYS.AUDIO_FORMAT];
  }
  if (stored[STORAGE_KEYS.TRANSCRIPT_FORMAT]) {
    transcriptFormatSelect.value = stored[STORAGE_KEYS.TRANSCRIPT_FORMAT];
  }
}

async function onEnableLocalSaveChange() {
  const enabled = enableLocalSaveCheckbox.checked;
  await setLocalSaveEnabled(enabled);
  updateFolderSectionState(enabled);

  if (enabled && !currentFolderHandle) {
    showToast("Please select a save folder", "info");
  } else {
    showToast(enabled ? "Local saving enabled" : "Local saving disabled", "success");
  }
}

function updateFolderSectionState(enabled) {
  if (enabled) {
    folderSection.classList.remove("disabled");
    openFolderBtn.disabled = !currentFolderHandle;
    clearFolderBtn.disabled = false;
  } else {
    folderSection.classList.add("disabled");
    openFolderBtn.disabled = true;
    clearFolderBtn.disabled = true;
  }
}

function updateFolderDisplay(folderName) {
  if (folderName) {
    folderPathEl.textContent = folderName;
    folderPathEl.classList.add("has-folder");
    openFolderBtn.disabled = !enableLocalSaveCheckbox.checked;
  } else {
    folderPathEl.textContent = "No folder selected";
    folderPathEl.classList.remove("has-folder");
    openFolderBtn.disabled = true;
  }
}

async function onSelectFolder() {
  try {
    const handle = await selectSaveFolder();
    if (handle) {
      currentFolderHandle = handle;
      updateFolderDisplay(handle.name);
      openFolderBtn.disabled = !enableLocalSaveCheckbox.checked;
      showToast(`Folder "${handle.name}" selected`, "success");
    }
  } catch (error) {
    showToast(`Failed to select folder: ${error.message}`, "error");
  }
}

async function onOpenFolder() {
  if (!currentFolderHandle) {
    showToast("No folder selected", "error");
    return;
  }

  // Unfortunately, we can't directly open the system file manager
  // But we can provide feedback that it's accessible
  showToast(`Folder "${currentFolderHandle.name}" is ready for saving`, "success");

  // Try to verify access by listing entries
  try {
    const entries = [];
    for await (const entry of currentFolderHandle.entries()) {
      entries.push(entry.name);
      if (entries.length >= 5) break; // Just check a few
    }
  } catch (error) {
    // Permission may have expired, ask user to re-select
    showToast("Folder access expired. Please re-select the folder.", "error");
    currentFolderHandle = null;
    updateFolderDisplay(null);
  }
}

async function onClearFolder() {
  if (!currentFolderHandle) return;

  const confirmed = confirm("Clear the saved folder? You'll need to select it again to save locally.");
  if (!confirmed) return;

  try {
    await clearSaveFolder();
    currentFolderHandle = null;
    updateFolderDisplay(null);
    showToast("Folder cleared", "success");
  } catch (error) {
    showToast(`Error clearing folder: ${error.message}`, "error");
  }
}

async function onAudioFormatChange() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (localStorage) {
    await localStorage.set({ [STORAGE_KEYS.AUDIO_FORMAT]: audioFormatSelect.value });
  }
}

async function onTranscriptFormatChange() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (localStorage) {
    await localStorage.set({ [STORAGE_KEYS.TRANSCRIPT_FORMAT]: transcriptFormatSelect.value });
  }
}

async function onDriveSettings() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("notes_page.html") });
}

async function onOpenNotes() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("notes_page.html") });
}

function showToast(message, type = "info") {
  toastEl.textContent = message;
  toastEl.className = `toast ${type}`;
  toastEl.classList.add("show");

  setTimeout(() => {
    toastEl.classList.remove("show");
  }, 3000);
}
