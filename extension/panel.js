import {
  getRecordingsDirectoryHandle,
  pickRecordingsDirectory,
  readRecordingFile,
  probeAudioDuration,
  setCachedDuration,
  getDurationCache,
  clearRuntimeDurationCache,
  ensureWritable,
  enumerateRecordings,
  writeRecordingArtifact,
  writeRecordingMeta,
  removeRecordingArtifact,
  readArtifactText
} from "./lib/audioFs.js";
import { getSelectedModelId, getAutoTranscribePreference } from "./lib/whisperModel.js";
import {
  getSelectedSpeakerEmbedModelId,
  getAutoDiarizePreference,
  getSpeakerDetectionEnabled,
  isSpeakerEmbedModelCached
} from "./lib/speakerEmbedModel.js";
import { mergeSessionSources } from "./lib/sessionMerge.js";
import { diarize } from "./lib/diarize.js";
import { formatDiarizedText, formatDiarizedJson } from "./lib/diarizedTranscript.js";
import { openDiarizationWorker } from "./lib/diarizationWorkerClient.js";
import {
  isAvailable as isBrowserAiAvailable,
  summarizeAndDescribe,
  getAutoSummarizePreference,
  getSummaryHeadChars,
  BROWSER_AI
} from "./lib/browserAi.js";
import { serializeSummary } from "./lib/summaryFile.js";
import {
  TRANSCRIPTION_SAMPLE_RATE,
  createTranscriptionChunkPlan,
  mergeTranscriptionChunkResults,
  offsetTranscriptionSegment,
  segmentBelongsToTranscriptionChunk
} from "./lib/transcriptionChunks.js";
import {
  canDecodeWebmOpusWithWebCodecs,
  decodeWebmOpusChunks
} from "./lib/webmOpusDecoder.js";
import { compileFilter } from "./lib/filterExpression.js";
import {
  getAutocompleteContext,
  applySuggestion,
} from "./lib/filterAutocomplete.js";
import {
  enqueue as enqueueJob,
  subscribe as subscribeToJobQueue,
  cancel as cancelJob,
  cancelAll as cancelAllJobs,
  clearFinished as clearFinishedJobs,
  updateJobProgress,
} from "./lib/jobQueue.js";

const statusEl = document.getElementById("status");
const recordingStatusEl = document.getElementById("recording-status");
const elapsedEl = document.getElementById("elapsed");
const tabLevelEl = document.getElementById("tab-level");
const micLevelEl = document.getElementById("mic-level");
const tabMuteBtn = document.getElementById("tab-mute-btn");
const micMuteBtn = document.getElementById("mic-mute-btn");
const preRecordEl = document.getElementById("pre-record");
const recordingEl = document.getElementById("recording");
const meetingLabelInput = document.getElementById("meeting-label");
const micSelect = document.getElementById("mic-select");
const micSelectLive = document.getElementById("mic-select-live");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const pauseButton = document.getElementById("pause-btn");
const changeTabButton = document.getElementById("change-tab-btn");
const openSettingsButton = document.getElementById("open-settings-btn");
const loadingSplashEl = document.getElementById("loading-splash");
const recordingsSectionEl = document.getElementById("recordings-section");
const recordingsListEl = document.getElementById("recordings-list");
const refreshRecordingsButton = document.getElementById("refresh-recordings-btn");
const openFolderButton = document.getElementById("open-folder-btn");
const combineTranscriptsBtn = document.getElementById("combine-transcripts-btn");
const deleteSelectedBtn = document.getElementById("delete-selected-btn");
const bulkActionsEl = document.getElementById("bulk-actions");
const folderNameEl = document.getElementById("folder-name");
const pickFolderButton = document.getElementById("pick-folder-btn");

const MIC_DEVICE_ID_KEY = "selectedMicDeviceId";
const NO_MIC_VALUE = "__none__";

const MIC_GAIN = 2.0;
const TAB_GAIN = 0.8;
const FADE_SECONDS = 0.05;

let mediaRecorder = null;
let recordedChunks = [];
let currentSession = null;
let graph = freshGraph();
let tabMuted = false;
let micMuted = false;
let elapsedTimerId = null;
let levelRafId = null;
let analyserBuffer = null;
let changeInProgress = false;
let cachedMicDevices = [];
let pauseStartedAt = null;
let totalPausedMs = 0;
let labelTimerId = null;
let lastAutoLabel = "";
const selectedSessionIds = new Set();
let dayCollapseInitialized = false;
const collapsedDayKeys = new Set();

export function freshGraph() {
  return {
    context: null,
    recordDestination: null,
    tab: emptyNodeGroup(),
    mic: emptyNodeGroup()
  };
}

export function emptyNodeGroup() {
  return { stream: null, source: null, gain: null, analyser: null, endedHandler: null };
}

init();

async function init() {
  if (!hasExtensionRuntime()) {
    setupLocalPreviewMode();
    return;
  }

  const initialLabel = defaultTimestampLabel();
  if (!meetingLabelInput.value) {
    meetingLabelInput.value = initialLabel;
  }
  lastAutoLabel = initialLabel;
  startLabelTimer();

  const stored = await chrome.storage.local.get([MIC_DEVICE_ID_KEY]).catch(() => ({}));

  await populateMicSelectors(stored?.[MIC_DEVICE_ID_KEY]);
  hideLoadingSplash();

  // Best-effort detection; never throws and never triggers a model download.
  refreshBrowserAiAvailability().catch(() => {});

  const filterInput = document.getElementById("recordings-filter");
  if (filterInput) {
    const autocompleteEl = document.getElementById("filter-autocomplete");
    const datepickerEl = document.getElementById("filter-datepicker");
    const datepickerInput = document.getElementById("filter-datepicker-input");
    let acSelectedIndex = 0;
    let acContext = null;

    filterInput.addEventListener("input", () => {
      recordingsFilter = filterInput.value.trim();
      applyRecordingsFilter();
      refreshAutocomplete();
    });

    filterInput.addEventListener("keyup", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Escape") return;
      refreshAutocomplete();
    });

    filterInput.addEventListener("click", refreshAutocomplete);

    filterInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" && acContext?.suggestions?.length) {
        e.preventDefault();
        acSelectedIndex = Math.min(acSelectedIndex + 1, acContext.suggestions.length - 1);
        renderAutocomplete();
      } else if (e.key === "ArrowUp" && acContext?.suggestions?.length) {
        e.preventDefault();
        acSelectedIndex = Math.max(acSelectedIndex - 1, 0);
        renderAutocomplete();
      } else if (e.key === "Enter" && acContext?.suggestions?.length && !autocompleteEl?.classList.contains("hidden")) {
        e.preventDefault();
        acceptSuggestion(acContext.suggestions[acSelectedIndex]);
      } else if (e.key === "Escape") {
        hideAutocomplete();
        hideDatepicker();
      } else if (e.key === "Tab" && acContext?.suggestions?.length && !autocompleteEl?.classList.contains("hidden")) {
        e.preventDefault();
        acceptSuggestion(acContext.suggestions[acSelectedIndex]);
      }
    });

    filterInput.addEventListener("blur", () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active === datepickerInput || datepickerEl?.contains(active)) return;
        hideAutocomplete();
        hideDatepicker();
      }, 150);
    });

    if (datepickerInput) {
      datepickerInput.addEventListener("change", () => {
        if (!datepickerInput.value) return;
        const pos = filterInput.selectionStart ?? 0;
        const text = filterInput.value;
        const before = text.slice(0, pos);
        const argStart = findDateArgStart(before);
        if (argStart < 0) return;
        const dateStr = datepickerInput.value;
        const isRange = /date\.\s*range\s*\(/.test(before);
        const hasComma = before.slice(before.lastIndexOf("date.")).includes(",");
        const suffix = isRange && !hasComma ? '","' : '")';
        const insertText = dateStr + suffix;
        const newText = text.slice(0, argStart) + insertText + text.slice(pos);
        filterInput.value = newText;
        const newCursor = argStart + insertText.length;
        filterInput.focus();
        filterInput.setSelectionRange(newCursor, newCursor);
        recordingsFilter = newText.trim();
        applyRecordingsFilter();
        hideDatepicker();
        refreshAutocomplete();
      });
    }

    function refreshAutocomplete() {
      const pos = filterInput.selectionStart ?? 0;
      const text = filterInput.value;
      acContext = getAutocompleteContext(text, pos);

      if (!acContext || acContext.phase === "none") {
        hideAutocomplete();
        hideDatepicker();
        return;
      }

      if (acContext.phase === "date") {
        hideAutocomplete();
        showDatepicker();
        return;
      }

      hideDatepicker();

      if (acContext.suggestions.length === 0) {
        hideAutocomplete();
        return;
      }

      acSelectedIndex = 0;
      renderAutocomplete();
    }

    function renderAutocomplete() {
      if (!autocompleteEl || !acContext?.suggestions?.length) { hideAutocomplete(); return; }
      autocompleteEl.innerHTML = "";
      for (let i = 0; i < acContext.suggestions.length; i++) {
        const s = acContext.suggestions[i];
        const item = document.createElement("div");
        item.className = "ac-item" + (i === acSelectedIndex ? " is-active" : "");
        const label = document.createElement("span");
        label.className = "ac-label";
        label.textContent = s.label;
        item.appendChild(label);
        if (s.detail) {
          const detail = document.createElement("span");
          detail.className = "ac-detail";
          detail.textContent = s.detail;
          item.appendChild(detail);
        }
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          acceptSuggestion(s);
        });
        autocompleteEl.appendChild(item);
      }
      autocompleteEl.classList.remove("hidden");
    }

    function acceptSuggestion(s) {
      if (!s || !acContext) return;
      const result = applySuggestion(filterInput.value, acContext.replaceStart, acContext.replaceEnd, s.insert);
      filterInput.value = result.text;
      filterInput.focus();
      filterInput.setSelectionRange(result.cursorPos, result.cursorPos);
      recordingsFilter = result.text.trim();
      applyRecordingsFilter();
      hideAutocomplete();
      setTimeout(refreshAutocomplete, 0);
    }

    function hideAutocomplete() {
      if (autocompleteEl) autocompleteEl.classList.add("hidden");
    }

    function showDatepicker() {
      if (!datepickerEl) return;
      const rect = filterInput.getBoundingClientRect();
      const parentRect = filterInput.parentElement.getBoundingClientRect();
      datepickerEl.style.left = `${rect.left - parentRect.left}px`;
      datepickerEl.style.top = `${rect.bottom - parentRect.top + 4}px`;
      datepickerEl.classList.remove("hidden");
      if (datepickerInput) {
        datepickerInput.value = "";
        setTimeout(() => datepickerInput.focus(), 0);
      }
    }

    function hideDatepicker() {
      if (datepickerEl) datepickerEl.classList.add("hidden");
    }

    function findDateArgStart(before) {
      const lastQuote = before.lastIndexOf('"');
      if (lastQuote >= 0) return lastQuote + 1;
      return -1;
    }

    const filterHelpBtn = document.getElementById("filter-help-btn");
    const filterHelp = document.getElementById("filter-help");
    if (filterHelpBtn && filterHelp) {
      filterHelpBtn.addEventListener("click", () => {
        filterHelp.classList.toggle("hidden");
      });
    }
  }

  micSelect.addEventListener("change", () => onMicSelectChange(micSelect.value));
  micSelectLive.addEventListener("change", () => onMicSelectChange(micSelectLive.value));

  startButton.addEventListener("click", () => {
    onStartRecording().catch((error) => {
      statusEl.textContent = String(error?.message || error);
      resetRecordingUI();
    });
  });
  stopButton.addEventListener("click", () => {
    onStopRecording().catch((error) => {
      statusEl.textContent = String(error?.message || error);
    });
  });
  pauseButton?.addEventListener("click", () => {
    onTogglePause().catch((error) => {
      statusEl.textContent = String(error?.message || error);
    });
  });
  changeTabButton.addEventListener("click", () => {
    onChangeTab().catch((error) => {
      recordingStatusEl.textContent = `Tab change failed: ${error?.message || error}`;
      setChanging(false);
    });
  });

  tabMuteBtn?.addEventListener("click", toggleTabMute);
  micMuteBtn?.addEventListener("click", toggleMicMute);

  combineTranscriptsBtn?.addEventListener("click", () => {
    onCombineTranscripts().catch((error) => {
      statusEl.textContent = `Combine failed: ${error?.message || error}`;
    });
  });

  deleteSelectedBtn?.addEventListener("click", () => {
    onDeleteSelected().catch((error) => {
      statusEl.textContent = `Delete failed: ${error?.message || error}`;
    });
  });

  openSettingsButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });
  const buyCoffeeBtn = document.getElementById("buy-coffee-btn");
  const openCoffeeSupportTab = async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("support.html") });
  };
  buyCoffeeBtn?.addEventListener("click", openCoffeeSupportTab);
  buyCoffeeBtn?.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); await openCoffeeSupportTab(); }
  });

  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshMicSelectors().catch(() => {});
  });

  refreshRecordingsButton?.addEventListener("click", async () => {
    refreshRecordingsButton.disabled = true;
    const originalLabel = refreshRecordingsButton.textContent;
    refreshRecordingsButton.textContent = "Refreshing...";
    try {
      // Drop the runtime-only duration cache so every file is re-probed
      // from disk, then re-render and run a fresh enrichment pass.
      clearRuntimeDurationCache();
      await loadAndRenderSessions();
      enrichDurationsInBackground().catch(() => {});
    } finally {
      refreshRecordingsButton.disabled = false;
      refreshRecordingsButton.textContent = originalLabel;
    }
  });

  openFolderButton?.addEventListener("click", async () => {
    await openRecordingsFolder();
  });

  pickFolderButton?.addEventListener("click", async () => {
    pickFolderButton.disabled = true;
    try {
      const handle = await pickRecordingsDirectory();
      updateFolderStatus(handle);
      enrichDurationsInBackground().catch(() => {});
      await loadAndRenderSessions();
    } catch (error) {
      statusEl.textContent = `Folder pick canceled: ${error?.message || error}`;
    } finally {
      pickFolderButton.disabled = false;
    }
  });

  updateFolderStatus().catch(() => {});

  recordingsListEl?.addEventListener("click", onRecordingsListClick);

  // Clicking anywhere outside an open tag editor closes it.
  document.addEventListener("click", (event) => {
    if (!openTagEditorSessionId) return;
    if (event.target.closest(".tag-editor-popover")) return;
    if (event.target.closest(".recording-item-tag-btn")) return;
    closeTagEditor();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    // Only the session record store now triggers re-renders; the duration
    // cache has been retired in favor of always re-scanning disk.
    if (area === "local" && changes.v2Sessions) {
      if (operationsInFlight > 0) {
        // Don't tear down the row while a transcribe / MP3 conversion is
        // running on it — that would destroy the spinner, the button's
        // disabled state, and the live transcript preview. Defer until the
        // operation finishes; endOperation() runs the reload then.
        deferredReload = true;
        return;
      }
      loadAndRenderSessions().catch(() => {});
    }
  });

  initJobQueuePanel();

  loadAndRenderSessions()
    .then(() => enrichDurationsInBackground())
    .catch(() => {});

  window.addEventListener("beforeunload", () => {
    if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) {
      try { mediaRecorder.stop(); } catch (_) {}
    }
  });
}

function hideLoadingSplash() {
  loadingSplashEl?.classList.add("is-hidden");
}

const JOB_TYPE_ICONS = {
  queued: '<span class="dot"></span>',
  running: '<span class="spinner"></span>',
  done: '<span class="check">&#x2713;</span>',
  error: '<span class="cross">&#x2717;</span>',
  cancelled: '<span class="cross">&#x2717;</span>',
};

function initJobQueuePanel() {
  const panel = document.getElementById("job-queue-panel");
  const listEl = document.getElementById("job-queue-list");
  const clearBtn = document.getElementById("job-queue-clear");
  const collapseBtn = document.getElementById("job-queue-collapse");
  const titleEl = document.getElementById("job-queue-title");
  if (!panel || !listEl) return;

  collapseBtn?.addEventListener("click", () => {
    panel.classList.toggle("is-collapsed");
    collapseBtn.textContent = panel.classList.contains("is-collapsed") ? "+" : "\u2014";
  });

  clearBtn?.addEventListener("click", () => {
    clearFinishedJobs();
    cancelAllJobs();
  });

  const autoClearTimers = new Map();

  subscribeToJobQueue((jobs) => {
    if (jobs.length === 0) {
      panel.classList.add("hidden");
      autoClearTimers.clear();
      return;
    }
    panel.classList.remove("hidden");

    const pendingCount = jobs.filter((j) => j.status === "queued" || j.status === "running").length;
    if (titleEl) {
      titleEl.textContent = pendingCount > 0 ? `Jobs \u2014 ${pendingCount} pending` : "Jobs";
    }

    for (const job of jobs) {
      if (job.status === "done" && !autoClearTimers.has(job.id)) {
        const timer = setTimeout(() => {
          autoClearTimers.delete(job.id);
          clearFinishedJobs();
        }, 30000);
        autoClearTimers.set(job.id, timer);
      }
      if (job.status !== "done" && autoClearTimers.has(job.id)) {
        clearTimeout(autoClearTimers.get(job.id));
        autoClearTimers.delete(job.id);
      }
    }

    listEl.innerHTML = "";
    for (const job of jobs) {
      const item = document.createElement("div");
      item.className = `job-item is-${job.status}`;

      const row = document.createElement("div");
      row.className = "job-item-row";

      const icon = document.createElement("span");
      icon.className = "job-item-icon";
      icon.innerHTML = JOB_TYPE_ICONS[job.status] || "";
      row.appendChild(icon);

      const label = document.createElement("span");
      label.className = "job-item-label";
      label.textContent = job.label;
      row.appendChild(label);

      if (job.status === "queued") {
        const cancelBtnEl = document.createElement("button");
        cancelBtnEl.className = "job-item-cancel";
        cancelBtnEl.type = "button";
        cancelBtnEl.title = "Cancel";
        cancelBtnEl.textContent = "\u00d7";
        cancelBtnEl.addEventListener("click", () => cancelJob(job.id));
        row.appendChild(cancelBtnEl);
      }

      item.appendChild(row);

      const session = document.createElement("div");
      session.className = "job-item-session";
      session.textContent = job.sessionLabel;
      item.appendChild(session);

      if (job.status === "running" && job.progressLabel) {
        const prog = document.createElement("div");
        prog.className = "job-item-progress";
        prog.textContent = job.progressLabel;
        item.appendChild(prog);
      }

      if (job.status === "error" && job.error) {
        const err = document.createElement("div");
        err.className = "job-item-error";
        err.textContent = job.error;
        item.appendChild(err);
      }

      listEl.appendChild(item);
    }
  });
}

function hasExtensionRuntime() {
  return !!(
    globalThis.chrome?.storage?.local &&
    globalThis.chrome?.runtime?.getURL &&
    globalThis.chrome?.tabs
  );
}

function setupLocalPreviewMode() {
  const initialLabel = defaultTimestampLabel();
  if (meetingLabelInput && !meetingLabelInput.value) {
    meetingLabelInput.value = initialLabel;
  }
  lastAutoLabel = initialLabel;

  buildPreviewMicOptions(micSelect);
  buildPreviewMicOptions(micSelectLive);
  updateFolderStatusPreview();

  if (statusEl) {
    statusEl.textContent = "Preview mode: load the unpacked extension in Chrome to record audio.";
  }
  if (startButton) startButton.disabled = true;
  if (pickFolderButton) pickFolderButton.disabled = true;
  if (openFolderButton) openFolderButton.disabled = true;
  if (refreshRecordingsButton) refreshRecordingsButton.disabled = true;

  openSettingsButton?.addEventListener("click", () => {
    window.location.href = "settings.html";
  });
  const buyCoffeeBtn = document.getElementById("buy-coffee-btn");
  const openCoffeeSupport = () => { window.location.href = "support.html"; };
  buyCoffeeBtn?.addEventListener("click", openCoffeeSupport);
  buyCoffeeBtn?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openCoffeeSupport(); }
  });

  hideLoadingSplash();
}

function buildPreviewMicOptions(selectEl) {
  if (!selectEl) return;
  selectEl.innerHTML = "";
  const option = document.createElement("option");
  option.value = NO_MIC_VALUE;
  option.textContent = "Preview microphone";
  selectEl.append(option);
  selectEl.value = NO_MIC_VALUE;
}

function updateFolderStatusPreview() {
  if (!folderNameEl) return;
  folderNameEl.textContent = "Preview mode";
  folderNameEl.classList.remove("is-positive");
}

async function populateMicSelectors(savedId) {
  let devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const hasLabels = devices.some(d => d.kind === "audioinput" && d.label);
  if (!hasLabels) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) {
      // Permission denied; user can still pick "no microphone"
    }
  }
  cachedMicDevices = devices.filter(d => d.kind === "audioinput");

  const chosenId = pickInitialMicId(savedId, cachedMicDevices);
  buildMicOptions(micSelect, cachedMicDevices, chosenId);
  buildMicOptions(micSelectLive, cachedMicDevices, chosenId);

  if (chosenId !== savedId) {
    chrome.storage.local.set({ [MIC_DEVICE_ID_KEY]: chosenId }).catch(() => {});
  }
}

async function refreshMicSelectors() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  cachedMicDevices = devices.filter(d => d.kind === "audioinput");
  const current = micSelect.value || NO_MIC_VALUE;
  const stillExists = current === NO_MIC_VALUE || cachedMicDevices.some(m => m.deviceId === current);
  const target = stillExists ? current : pickInitialMicId(null, cachedMicDevices);
  buildMicOptions(micSelect, cachedMicDevices, target);
  buildMicOptions(micSelectLive, cachedMicDevices, target);
}

export function pickInitialMicId(savedId, mics) {
  if (savedId === NO_MIC_VALUE) return NO_MIC_VALUE;
  if (savedId && mics.some(m => m.deviceId === savedId)) return savedId;
  if (mics.length === 0) return NO_MIC_VALUE;
  const physical = mics.find(m =>
    m.deviceId !== "default" &&
    !/nomachine|virtual|loopback|monitor/i.test(m.label || "")
  );
  return physical?.deviceId || mics[0].deviceId;
}

function buildMicOptions(selectEl, mics, chosenId) {
  selectEl.innerHTML = "";

  const noneOpt = document.createElement("option");
  noneOpt.value = NO_MIC_VALUE;
  noneOpt.textContent = "No microphone (tab audio only)";
  selectEl.appendChild(noneOpt);

  for (const mic of mics) {
    const opt = document.createElement("option");
    opt.value = mic.deviceId;
    opt.textContent = mic.label || `Microphone ${mic.deviceId.slice(0, 6)}`;
    selectEl.appendChild(opt);
  }

  selectEl.value = chosenId;
}

async function onMicSelectChange(newValue) {
  if (micSelect.value !== newValue) micSelect.value = newValue;
  if (micSelectLive.value !== newValue) micSelectLive.value = newValue;
  chrome.storage.local.set({ [MIC_DEVICE_ID_KEY]: newValue }).catch(() => {});

  if (mediaRecorder && mediaRecorder.state === "recording") {
    if (changeInProgress) {
      recordingStatusEl.textContent = "Another change is in progress. Try again in a moment.";
      return;
    }
    await swapMic(newValue);
  }
}

async function onStartRecording() {
  if (mediaRecorder) return;
  stopLabelTimer();
  startButton.disabled = true;
  statusEl.textContent = "Pick the tab to record...";
  pauseStartedAt = null;
  totalPausedMs = 0;

  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    });
  } catch (error) {
    startButton.disabled = false;
    statusEl.textContent = String(error?.message || error);
    return;
  }

  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) {
    for (const t of displayStream.getTracks()) t.stop();
    startButton.disabled = false;
    statusEl.textContent = "No tab audio. Make sure 'Share tab audio' is checked.";
    return;
  }
  for (const t of displayStream.getVideoTracks()) {
    t.stop();
    displayStream.removeTrack(t);
  }

  const chosenMicId = micSelect.value;
  let micStream = null;
  if (chosenMicId !== NO_MIC_VALUE) {
    try {
      micStream = await acquireMicStream(chosenMicId);
    } catch (error) {
      statusEl.textContent = `Mic unavailable: ${error?.message || error}. Recording tab only.`;
    }
  }

  initGraph();
  attachTabStream(displayStream);
  if (micStream) attachMicStream(micStream);
  analyserBuffer = new Uint8Array(graph.tab.analyser.fftSize);

  const mimeType = pickMimeType();
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(graph.recordDestination.stream, {
    mimeType,
    audioBitsPerSecond: 128000
  });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];
    cleanupGraph();
    stopMeters();
    const finishedSession = currentSession;
    let saveOk = false;
    try {
      const { downloadId, fileName } = await saveBlob(blob, finishedSession);
      await persistSessionRecord(finishedSession, downloadId, mimeType, fileName);
      statusEl.textContent = `Saved: ${finishedSession.fileName}`;
      saveOk = true;
    } catch (error) {
      statusEl.textContent = `Save failed: ${error?.message || error}`;
    }
    currentSession = null;
    mediaRecorder = null;
    resetRecordingUI();
    await loadAndRenderSessions().catch(() => {});

    if (saveOk && finishedSession) {
      const auto = await getAutoTranscribePreference().catch(() => false);
      if (auto) triggerAutoTranscribe(finishedSession.id);
    }
  };
  mediaRecorder.onerror = (event) => {
    statusEl.textContent = `Recorder error: ${event.error?.message || event.error}`;
  };

  const meetingLabel = cleanMeetingLabel();
  currentSession = {
    id: makeId(),
    meetingLabel,
    startedAt: Date.now(),
    fileName: buildFileName(meetingLabel)
  };
  mediaRecorder.start(1000);

  preRecordEl.classList.add("hidden");
  recordingEl.classList.remove("hidden");
  recordingsSectionEl?.classList.add("hidden");
  recordingStatusEl.textContent = `Recording: ${meetingLabel}`;
  updateMicMeterVisibility();
  startElapsedTimer();
  startMeterLoop();
  startButton.disabled = false;
}

async function acquireMicStream(deviceId) {
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false
  };
  if (deviceId && deviceId !== "default" && deviceId !== NO_MIC_VALUE) {
    audioConstraints.deviceId = { exact: deviceId };
  }
  return await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
    video: false
  });
}

function initGraph() {
  graph = freshGraph();
  graph.context = new AudioContext();
  graph.recordDestination = graph.context.createMediaStreamDestination();
}

function attachTabStream(stream) {
  const ctx = graph.context;
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(graph.recordDestination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  gain.connect(analyser);

  rampGain(gain, TAB_GAIN, FADE_SECONDS);

  const endedHandler = () => {
    if (changeInProgress) return;
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try { mediaRecorder.stop(); } catch (_) {}
    }
  };
  stream.getAudioTracks()[0].addEventListener("ended", endedHandler);

  graph.tab = { stream, source, gain, analyser, endedHandler };
}

async function detachTabStream() {
  const node = graph.tab;
  if (!node.stream) return;
  graph.tab = emptyNodeGroup();

  if (node.endedHandler) {
    try { node.stream.getAudioTracks()[0].removeEventListener("ended", node.endedHandler); } catch (_) {}
  }
  if (node.gain && graph.context) {
    rampGain(node.gain, 0, FADE_SECONDS);
    await sleep(FADE_SECONDS * 1000 + 10);
  }
  try { node.source.disconnect(); } catch (_) {}
  try { node.gain.disconnect(); } catch (_) {}
  try { node.analyser.disconnect(); } catch (_) {}
  for (const t of node.stream.getTracks()) {
    try { t.stop(); } catch (_) {}
  }
}

function attachMicStream(stream) {
  const ctx = graph.context;
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(graph.recordDestination);

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  gain.connect(analyser);

  rampGain(gain, MIC_GAIN, FADE_SECONDS);

  graph.mic = { stream, source, gain, analyser, endedHandler: null };
  updateMicMeterVisibility();
}

async function detachMicStream() {
  const node = graph.mic;
  if (!node.stream) return;
  graph.mic = emptyNodeGroup();

  if (node.gain && graph.context) {
    rampGain(node.gain, 0, FADE_SECONDS);
    await sleep(FADE_SECONDS * 1000 + 10);
  }
  try { node.source.disconnect(); } catch (_) {}
  try { node.gain.disconnect(); } catch (_) {}
  try { node.analyser.disconnect(); } catch (_) {}
  for (const t of node.stream.getTracks()) {
    try { t.stop(); } catch (_) {}
  }
  micLevelEl.style.width = "0%";
  updateMicMeterVisibility();
}

function rampGain(gainNode, target, seconds) {
  const ctx = graph.context;
  if (!ctx) {
    gainNode.gain.value = target;
    return;
  }
  const now = ctx.currentTime;
  gainNode.gain.cancelScheduledValues(now);
  gainNode.gain.setValueAtTime(gainNode.gain.value, now);
  gainNode.gain.linearRampToValueAtTime(target, now + seconds);
}

function updateMicMeterVisibility() {
  const has = !!graph.mic.stream;
  micLevelEl.parentElement.style.opacity = has ? "1" : "0.4";
}

function toggleTabMute() {
  tabMuted = !tabMuted;
  tabMuteBtn.setAttribute("aria-pressed", String(tabMuted));
  if (graph.tab.gain) {
    const value = tabMuted ? 0 : TAB_GAIN;
    rampGain(graph.tab.gain, value, FADE_SECONDS);
  }
}

function toggleMicMute() {
  micMuted = !micMuted;
  micMuteBtn.setAttribute("aria-pressed", String(micMuted));
  if (graph.mic.gain) {
    const value = micMuted ? 0 : MIC_GAIN;
    rampGain(graph.mic.gain, value, FADE_SECONDS);
  }
}

async function onChangeTab() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  if (changeInProgress) return;
  setChanging(true);
  recordingStatusEl.textContent = "Pick the new tab to record...";
  try {
    let newDisplayStream;
    try {
      newDisplayStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
    } catch (_) {
      recordingStatusEl.textContent = `Recording: ${currentSession.meetingLabel}`;
      return;
    }
    const newAudioTracks = newDisplayStream.getAudioTracks();
    if (!newAudioTracks.length) {
      for (const t of newDisplayStream.getTracks()) t.stop();
      recordingStatusEl.textContent = "New tab has no audio. Keeping previous tab. (Make sure 'Share tab audio' is checked.)";
      return;
    }
    for (const t of newDisplayStream.getVideoTracks()) {
      t.stop();
      newDisplayStream.removeTrack(t);
    }

    await detachTabStream();
    attachTabStream(newDisplayStream);
    recordingStatusEl.textContent = `Recording: ${currentSession.meetingLabel}`;
  } finally {
    setChanging(false);
  }
}

async function swapMic(deviceId) {
  setChanging(true);
  try {
    await detachMicStream();
    if (deviceId === NO_MIC_VALUE) {
      recordingStatusEl.textContent = `Recording: ${currentSession.meetingLabel} (no mic)`;
      return;
    }
    let newMicStream;
    try {
      newMicStream = await acquireMicStream(deviceId);
    } catch (e) {
      recordingStatusEl.textContent = `Mic unavailable: ${e?.message || e}. Recording tab only.`;
      micSelect.value = NO_MIC_VALUE;
      micSelectLive.value = NO_MIC_VALUE;
      return;
    }
    attachMicStream(newMicStream);
    recordingStatusEl.textContent = `Recording: ${currentSession.meetingLabel}`;
  } finally {
    setChanging(false);
  }
}

function setChanging(on) {
  changeInProgress = on;
  changeTabButton.disabled = on;
  micSelectLive.disabled = on;
}

async function onStopRecording() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state !== "recording" && mediaRecorder.state !== "paused") return;
  if (mediaRecorder.state === "paused" && pauseStartedAt != null) {
    totalPausedMs += Date.now() - pauseStartedAt;
    pauseStartedAt = null;
  }
  stopButton.disabled = true;
  stopButton.textContent = "Saving...";
  if (pauseButton) pauseButton.disabled = true;
  recordingStatusEl.textContent = "Saving recording...";
  mediaRecorder.stop();
}

async function onTogglePause() {
  if (!mediaRecorder || !pauseButton) return;
  if (mediaRecorder.state === "recording") {
    try { mediaRecorder.pause(); } catch (_) { return; }
    pauseStartedAt = Date.now();
    pauseButton.textContent = "Resume";
    pauseButton.classList.add("is-paused");
    recordingEl.classList.add("is-paused");
    if (currentSession) {
      recordingStatusEl.textContent = `Paused: ${currentSession.meetingLabel}`;
    }
    if (elapsedTimerId) {
      clearInterval(elapsedTimerId);
      elapsedTimerId = null;
    }
    return;
  }
  if (mediaRecorder.state === "paused") {
    if (pauseStartedAt != null) {
      totalPausedMs += Date.now() - pauseStartedAt;
      pauseStartedAt = null;
    }
    try { mediaRecorder.resume(); } catch (_) { return; }
    pauseButton.textContent = "Pause";
    pauseButton.classList.remove("is-paused");
    recordingEl.classList.remove("is-paused");
    if (currentSession) {
      recordingStatusEl.textContent = `Recording: ${currentSession.meetingLabel}`;
    }
    startElapsedTimer();
  }
}

function resetRecordingUI() {
  preRecordEl.classList.remove("hidden");
  recordingEl.classList.add("hidden");
  recordingEl.classList.remove("is-paused");
  recordingsSectionEl?.classList.remove("hidden");
  stopButton.disabled = false;
  stopButton.textContent = "Stop Recording";
  startButton.disabled = false;
  changeTabButton.disabled = false;
  micSelectLive.disabled = false;
  if (pauseButton) {
    pauseButton.disabled = false;
    pauseButton.textContent = "Pause";
    pauseButton.classList.remove("is-paused");
  }
  pauseStartedAt = null;
  totalPausedMs = 0;
  tabMuted = false;
  micMuted = false;
  tabMuteBtn?.setAttribute("aria-pressed", "false");
  micMuteBtn?.setAttribute("aria-pressed", "false");
  const newLabel = defaultTimestampLabel();
  meetingLabelInput.value = newLabel;
  lastAutoLabel = newLabel;
  startLabelTimer();
  elapsedEl.textContent = "00:00";
  tabLevelEl.style.width = "0%";
  micLevelEl.style.width = "0%";
  micLevelEl.parentElement.style.opacity = "1";
}

function startLabelTimer() {
  stopLabelTimer();
  labelTimerId = setInterval(() => {
    const nowStr = defaultTimestampLabel();
    const currentVal = String(meetingLabelInput.value || "").trim();
    if (!currentVal || currentVal === lastAutoLabel) {
      meetingLabelInput.value = nowStr;
      lastAutoLabel = nowStr;
    }
  }, 1000);
}

function stopLabelTimer() {
  if (labelTimerId) {
    clearInterval(labelTimerId);
    labelTimerId = null;
  }
}

function startElapsedTimer() {
  const start = currentSession?.startedAt || Date.now();
  const tick = () => {
    const now = Date.now();
    const activePauseMs = pauseStartedAt != null ? now - pauseStartedAt : 0;
    const elapsed = now - start - totalPausedMs - activePauseMs;
    elapsedEl.textContent = formatElapsed(Math.max(0, elapsed));
  };
  tick();
  elapsedTimerId = setInterval(tick, 500);
}

function startMeterLoop() {
  const update = () => {
    const tabAnalyser = graph.tab.analyser;
    const micAnalyser = graph.mic.analyser;
    if (tabAnalyser) {
      tabLevelEl.style.width = `${Math.round(readLevel(tabAnalyser) * 100)}%`;
    }
    if (micAnalyser) {
      micLevelEl.style.width = `${Math.round(readLevel(micAnalyser) * 100)}%`;
    } else {
      micLevelEl.style.width = "0%";
    }
    levelRafId = requestAnimationFrame(update);
  };
  update();
}

function readLevel(analyser) {
  if (!analyser) return 0;
  if (!analyserBuffer || analyserBuffer.length < analyser.fftSize) {
    analyserBuffer = new Uint8Array(analyser.fftSize);
  }
  const buf = analyserBuffer.subarray(0, analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sumSquares = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / buf.length);
  return Math.min(1, rms * 4);
}

function stopMeters() {
  if (elapsedTimerId) {
    clearInterval(elapsedTimerId);
    elapsedTimerId = null;
  }
  if (levelRafId) {
    cancelAnimationFrame(levelRafId);
    levelRafId = null;
  }
  analyserBuffer = null;
}

function cleanupGraph() {
  for (const node of [graph.tab, graph.mic]) {
    if (!node.stream) continue;
    if (node.endedHandler) {
      try { node.stream.getAudioTracks()[0].removeEventListener("ended", node.endedHandler); } catch (_) {}
    }
    for (const t of node.stream.getTracks()) {
      try { t.stop(); } catch (_) {}
    }
  }
  if (graph.recordDestination) {
    for (const t of graph.recordDestination.stream.getTracks()) {
      try { t.stop(); } catch (_) {}
    }
  }
  if (graph.context) {
    graph.context.close().catch(() => {});
  }
  graph = freshGraph();
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus"
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "audio/webm";
}

async function saveBlob(blob, session) {
  if (!blob || blob.size === 0) throw new Error("Empty recording");

  // If the user has picked a recordings folder, write the webm directly into
  // it via the File System Access API so the recording, MP3 and transcript all
  // live in the same user-selected folder. Fall back to chrome.downloads
  // (Downloads/Tab Recorder) when no folder has been granted.
  const handle = await getRecordingsDirectoryHandle({ mode: "readwrite" }).catch(() => null);
  if (handle) {
    try {
      const result = await writeRecordingArtifact(handle, session.fileName, blob, { extension: "webm" });
      return { downloadId: null, fileName: result.fileName };
    } catch (_) {
      // Fall through to the downloads path below.
    }
  }

  const blobUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `Tab Recorder/${session.fileName}`,
      saveAs: false
    });
    await waitForDownloadComplete(downloadId);
    return { downloadId, fileName: `Tab Recorder/${session.fileName}` };
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }
}

/**
 * Wait for a chrome.downloads download to reach the "complete" state.
 * In some browsers (notably Brave) the download API writes the file to disk
 * asynchronously, so the file is not yet readable immediately after
 * chrome.downloads.download() resolves. Without this wait, the auto-transcribe
 * step fires before the file exists and fails with "File not found".
 *
 * Falls back after a 30s timeout so a stuck download doesn't block forever.
 */
function waitForDownloadComplete(downloadId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { chrome.downloads.onChanged.removeListener(listener); } catch (_) {}
      resolve();
    };

    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && (delta.state.current === "complete" || delta.state.current === "interrupted")) {
        finish();
      }
    };

    try {
      chrome.downloads.onChanged.addListener(listener);
    } catch (_) {
      finish();
      return;
    }

    setTimeout(finish, timeoutMs);
  });
}

async function persistSessionRecord(session, downloadId, mimeType, savedFileName) {
  const endedAt = Date.now();
  const pausedDuringActive = pauseStartedAt != null ? endedAt - pauseStartedAt : 0;
  const durationMs = Math.max(0, endedAt - session.startedAt - totalPausedMs - pausedDuringActive);
  // When the recording was written into the user-picked folder, savedFileName is
  // the day-folder-relative path (no "Tab Recorder/" prefix); when it went through
  // chrome.downloads it keeps the "Tab Recorder/" prefix. Persist whichever path
  // actually matches the file on disk so MP3/transcription lookups resolve.
  const payload = {
    id: session.id,
    meetingLabel: session.meetingLabel,
    tabTitle: session.meetingLabel,
    startedAt: session.startedAt,
    endedAt,
    durationMs,
    fileName: savedFileName || `Tab Recorder/${session.fileName}`,
    downloadId: Number.isInteger(downloadId) ? downloadId : null,
    audioFormat: "webm",
    audioMimeType: mimeType
  };
  try {
    await chrome.runtime.sendMessage({ type: "save-session", session: payload });
  } catch (_) {}
  try {
    const handle = await getRecordingsDirectoryHandle({ mode: "readwrite" });
    if (handle) {
      await writeRecordingMeta(handle, payload.fileName, {
        durationMs,
        startedAt: payload.startedAt,
        endedAt
      });
    }
  } catch (_) {}
}

export function buildFileName(label) {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const safe = String(label || "recording")
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").slice(0, 50) || "recording";
  return `${dateStr}/${safe}_${hh}-${mm}.webm`;
}

function cleanMeetingLabel() {
  const value = String(meetingLabelInput.value || "").trim();
  return value || defaultTimestampLabel();
}

export function defaultTimestampLabel() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

export function formatElapsed(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  }
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

function makeId() {
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedMergedSessions = [];
let browserAiAvailable = false;
// Master opt-in for speaker detection (off by default). Refreshed before each
// render so toggling it in Settings takes effect on the next list refresh.
let speakerDetectionEnabled = false;
let recordingsFilter = "";

// Operations currently in flight (transcribe, MP3 convert). Tracked by the
// session's fileName because that's stable even when a synthesized session
// gets promoted to a stored one mid-operation.
const inProgressFileNames = new Set();
const queuedSessionActions = new Set();
let operationsInFlight = 0;
let deferredReload = false;

export function startOperation(fileName) {
  if (fileName) inProgressFileNames.add(fileName);
  operationsInFlight += 1;
}

export function endOperation(fileName) {
  if (fileName) inProgressFileNames.delete(fileName);
  operationsInFlight = Math.max(0, operationsInFlight - 1);
  if (operationsInFlight === 0 && deferredReload) {
    deferredReload = false;
    loadAndRenderSessions().catch(() => {});
  }
}

export function formatWorkerErrorEvent(event) {
  if (!event) return "";
  const parts = [];
  if (event.message) parts.push(event.message);
  if (event.filename) parts.push(`at ${event.filename}${event.lineno != null ? ":" + event.lineno : ""}${event.colno != null ? ":" + event.colno : ""}`);
  if (event.error?.message && event.error.message !== event.message) {
    parts.push(`(${event.error.message})`);
  }
  if (event.error?.stack) parts.push(event.error.stack.split("\n")[0]);
  return parts.join(" ");
}

async function loadAndRenderSessions() {
  if (!recordingsListEl) return;

  const [stored, downloadOrphans, fsFiles] = await Promise.all([
    fetchStoredSessions(),
    fetchDownloadOrphans(),
    fetchFsRecordings()
  ]);

  // Pick up the latest speaker-detection opt-in (toggled in Settings) so the
  // per-row Diarize action shows/hides without needing a panel reload.
  try {
    speakerDetectionEnabled = await getSpeakerDetectionEnabled();
  } catch (_) {
    speakerDetectionEnabled = false;
  }

  cachedMergedSessions = mergeSessionSources(stored, downloadOrphans, fsFiles);

  // Apply the runtime-only duration cache so rows that were probed earlier
  // in this panel session show their duration immediately without
  // re-decoding. The cache lives only in memory; restart wipes it.
  const durations = getDurationCache();
  for (const session of cachedMergedSessions) {
    if (Number(session.durationMs) > 0) continue;
    const cached = durations[session.fileName];
    if (cached) session.durationMs = cached;
  }

  if (cachedMergedSessions.length === 0) {
    recordingsListEl.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "recordings-empty";
    empty.textContent = "No recordings yet.";
    recordingsListEl.appendChild(empty);
    return;
  }

  for (const h of recordingsListEl.querySelectorAll(".day-header")) {
    if (h.classList.contains("is-collapsed")) collapsedDayKeys.add(h.dataset.dayKey);
    else collapsedDayKeys.delete(h.dataset.dayKey);
  }

  recordingsListEl.innerHTML = "";

  const todayKey = (() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  })();

  if (!dayCollapseInitialized) {
    const preGroups = groupSessionsByDay(cachedMergedSessions);
    for (const g of preGroups) {
      if (g.dayKey !== todayKey) collapsedDayKeys.add(g.dayKey);
    }
    dayCollapseInitialized = true;
  }

  const groups = groupSessionsByDay(cachedMergedSessions);
  for (const group of groups) {
    const isCollapsed = collapsedDayKeys.has(group.dayKey);

    const dayHeader = document.createElement("div");
    dayHeader.className = "day-header";
    dayHeader.dataset.dayKey = group.dayKey;
    if (isCollapsed) dayHeader.classList.add("is-collapsed");

    const dayCheckbox = document.createElement("input");
    dayCheckbox.type = "checkbox";
    dayCheckbox.className = "day-select-all";
    dayCheckbox.dataset.dayKey = group.dayKey;
    dayCheckbox.title = "Select all recordings in this day";
    dayCheckbox.addEventListener("change", () => {
      const section = dayHeader.nextElementSibling;
      if (!section) return;
      const checked = dayCheckbox.checked;
      for (const row of section.querySelectorAll(".recording-item")) {
        const sid = row.dataset.sessionId;
        const cb = row.querySelector(".recording-item-select");
        if (!cb || cb.checked === checked) continue;
        cb.checked = checked;
        if (checked) {
          if (sid) selectedSessionIds.add(sid);
          row.classList.add("is-selected");
        } else {
          if (sid) selectedSessionIds.delete(sid);
          row.classList.remove("is-selected");
        }
      }
      updateBulkActions();
    });
    dayHeader.appendChild(dayCheckbox);

    const collapseBtn = document.createElement("button");
    collapseBtn.type = "button";
    collapseBtn.className = "day-collapse-btn";
    if (isCollapsed) collapseBtn.classList.add("is-collapsed");
    collapseBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" class="day-chevron" aria-hidden="true"><path fill="currentColor" d="M7 10l5 5 5-5z"/></svg>' +
      `<span class="day-label">${group.dayLabel}</span>` +
      `<span class="day-count">${group.sessions.length}</span>`;
    collapseBtn.addEventListener("click", () => {
      dayHeader.classList.toggle("is-collapsed");
      collapseBtn.classList.toggle("is-collapsed");
      const section = dayHeader.nextElementSibling;
      if (section) section.classList.toggle("is-collapsed");
      if (dayHeader.classList.contains("is-collapsed")) collapsedDayKeys.add(group.dayKey);
      else collapsedDayKeys.delete(group.dayKey);
    });
    dayHeader.appendChild(collapseBtn);

    const folderBtn = document.createElement("button");
    folderBtn.type = "button";
    folderBtn.className = "day-folder-btn";
    folderBtn.title = "Open folder for this day";
    folderBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2z"/></svg>';
    folderBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      revealDayFolder(group.dayKey);
    });
    dayHeader.appendChild(folderBtn);

    const daySection = document.createElement("div");
    daySection.className = "day-section";
    if (isCollapsed) daySection.classList.add("is-collapsed");

    for (const session of group.sessions) {
      daySection.appendChild(renderSessionRow(session));
    }

    recordingsListEl.appendChild(dayHeader);
    recordingsListEl.appendChild(daySection);
  }
  applyRecordingsFilter();

  // If a tag editor was open before this re-render (e.g. a save triggered
  // the storage-changed reload), restore it on the freshly rendered row.
  if (openTagEditorSessionId) {
    const sessionId = openTagEditorSessionId;
    openTagEditorSessionId = null;
    const row = findSessionRow(sessionId);
    const btn = row?.querySelector(".recording-item-tag-btn");
    if (btn) openTagEditor(btn, sessionId);
  }
}

export function groupSessionsByDay(sessions) {
  const groups = [];
  const map = new Map();
  for (const session of sessions) {
    const ts = Number(session?.startedAt || 0);
    const date = new Date(ts);
    if (Number.isNaN(date.getTime())) continue;
    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    if (!map.has(dayKey)) {
      const dayLabel = formatDateLabel(date);
      const group = { dayKey, dayLabel, sessions: [] };
      map.set(dayKey, group);
      groups.push(group);
    }
    map.get(dayKey).sessions.push(session);
  }
  return groups;
}

export function formatDateLabel(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const that = new Date(date);
  that.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today - that) / 86400000);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const base = `${months[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
  if (diffDays === 0) return `Today — ${base}`;
  if (diffDays === 1) return `Yesterday — ${base}`;
  return base;
}

export function applyRecordingsFilter() {
  if (!recordingsListEl) return;
  const q = recordingsFilter;
  const countEl = document.getElementById("recordings-filter-count");
  if (!q) {
    for (const row of recordingsListEl.querySelectorAll(".recording-item")) {
      row.classList.remove("is-filtered-out");
    }
    for (const header of recordingsListEl.querySelectorAll(".day-header")) {
      header.classList.remove("is-filtered-out");
    }
    if (countEl) countEl.textContent = "";
    return;
  }

  const predicate = compileFilter(q);
  const sessionMap = new Map();
  for (const s of cachedMergedSessions) {
    if (s?.id) sessionMap.set(s.id, s);
  }

  let visible = 0;
  let total = 0;
  for (const section of recordingsListEl.querySelectorAll(".day-section")) {
    let sectionVisible = 0;
    for (const row of section.querySelectorAll(".recording-item")) {
      total++;
      const session = sessionMap.get(row.dataset.sessionId);
      const match = session ? predicate(session) : false;
      row.classList.toggle("is-filtered-out", !match);
      if (match) { visible++; sectionVisible++; }
    }
    const header = section.previousElementSibling;
    if (header?.classList.contains("day-header")) {
      header.classList.toggle("is-filtered-out", sectionVisible === 0);
    }
  }
  if (countEl) countEl.textContent = `${visible} of ${total}`;
}

async function fetchStoredSessions() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-sessions" });
    if (response?.ok && Array.isArray(response.sessions)) return response.sessions;
  } catch (_) {}
  try {
    const result = await chrome.storage.local.get("v2Sessions");
    return Array.isArray(result?.v2Sessions) ? result.v2Sessions : [];
  } catch (_) {
    return [];
  }
}

// ----- Free-form tagging -----
// Tags live on each session record (`session.tags`, array of lowercase
// strings). A separate `tagUsage` map in storage tracks the last time a user
// *applied* a tag (user interaction, not recording creation), which powers
// the "top 10 recently used" suggestions in the tag editor popover.

const TAG_USAGE_KEY = "tagUsage";
const TAG_SUGGESTION_LIMIT = 10;

// Session whose tag editor popover is currently open. Re-renders (triggered
// by storage changes after a tag save) wipe the DOM, so we remember it here
// and re-open the editor after loadAndRenderSessions completes.
let openTagEditorSessionId = null;

async function fetchTagUsage() {
  try {
    const result = await chrome.storage.local.get(TAG_USAGE_KEY);
    return result?.[TAG_USAGE_KEY] && typeof result[TAG_USAGE_KEY] === "object"
      ? result[TAG_USAGE_KEY]
      : {};
  } catch (_) {
    return {};
  }
}

async function touchTagUsage(tag) {
  try {
    const usage = await fetchTagUsage();
    usage[tag] = Date.now();
    // Keep the map bounded — drop the least-recently-used entries past 100.
    const entries = Object.entries(usage).sort((a, b) => b[1] - a[1]).slice(0, 100);
    await chrome.storage.local.set({ [TAG_USAGE_KEY]: Object.fromEntries(entries) });
  } catch (_) {}
}

function collectKnownTags(sessions) {
  const set = new Set();
  for (const s of sessions) {
    if (Array.isArray(s?.tags)) s.tags.forEach((t) => set.add(String(t)));
  }
  return set;
}

async function fetchTagSuggestions() {
  // Top 10 most recently *applied* tags, followed by any other known tags
  // (alphabetical) so the picker still surfaces tags that exist on
  // recordings but were never applied via the editor (e.g. legacy data).
  const usage = await fetchTagUsage();
  const recent = Object.entries(usage)
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
    .slice(0, TAG_SUGGESTION_LIMIT);
  const known = collectKnownTags(cachedMergedSessions);
  const extras = [...known].filter((t) => !recent.includes(t)).sort();
  return [...recent, ...extras];
}

async function persistSessionTags(sessionId, tags) {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "update-session-tags",
      sessionId,
      tags
    });
    if (response?.ok) {
      const session = cachedMergedSessions.find((s) => s?.id === sessionId);
      if (session) session.tags = response.session?.tags ?? tags;
    }
  } catch (_) {}
}

function normalizeTag(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "-").slice(0, 40);
}

function closeTagEditor() {
  openTagEditorSessionId = null;
  document.querySelectorAll(".tag-editor-popover").forEach((el) => el.remove());
  document.querySelectorAll(".recording-item-tag-btn.is-open").forEach((el) => el.classList.remove("is-open"));
}

async function openTagEditor(button, sessionId) {
  const row = button.closest(".recording-item");
  const session = cachedMergedSessions.find((s) => s?.id === sessionId);
  if (!row || !session) return;

  // Toggle behavior: clicking the open button closes the editor.
  if (button.classList.contains("is-open")) {
    closeTagEditor();
    return;
  }
  closeTagEditor();
  button.classList.add("is-open");
  openTagEditorSessionId = sessionId;

  const popover = document.createElement("div");
  popover.className = "tag-editor-popover";
  popover.dataset.sessionId = sessionId;

  const chipList = document.createElement("div");
  chipList.className = "tag-editor-chips";
  popover.appendChild(chipList);

  const renderChips = () => {
    chipList.innerHTML = "";
    const tags = Array.isArray(session.tags) ? session.tags : [];
    if (!tags.length) {
      const hint = document.createElement("span");
      hint.className = "tag-editor-empty";
      hint.textContent = "No tags yet";
      chipList.appendChild(hint);
      return;
    }
    for (const tag of tags) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "tag-editor-chip";
      chip.textContent = `${tag} ×`;
      chip.title = `Remove tag "${tag}"`;
      chip.addEventListener("click", async () => {
        session.tags = tags.filter((t) => t !== tag);
        await persistSessionTags(sessionId, session.tags);
        renderChips();
      });
      chipList.appendChild(chip);
    }
  };
  renderChips();

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Add tag…";
  input.className = "tag-editor-input";
  popover.appendChild(input);

  const suggestions = document.createElement("div");
  suggestions.className = "tag-editor-suggestions";
  popover.appendChild(suggestions);

  const allSuggestions = await fetchTagSuggestions();

  const renderSuggestions = (filter) => {
    suggestions.innerHTML = "";
    const current = new Set(Array.isArray(session.tags) ? session.tags : []);
    const needle = String(filter || "").trim().toLowerCase();
    const matches = allSuggestions
      .filter((t) => !current.has(t))
      .filter((t) => !needle || t.includes(needle))
      .slice(0, TAG_SUGGESTION_LIMIT);
    if (!matches.length) {
      suggestions.classList.add("hidden");
      return;
    }
    suggestions.classList.remove("hidden");
    for (const tag of matches) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "tag-editor-suggestion";
      item.textContent = tag;
      item.addEventListener("click", () => applyTag(tag));
      suggestions.appendChild(item);
    }
  };
  renderSuggestions("");

  const applyTag = async (raw) => {
    const tag = normalizeTag(raw);
    if (!tag) return;
    const tags = Array.isArray(session.tags) ? session.tags : [];
    if (!tags.includes(tag)) {
      session.tags = [...tags, tag];
      await persistSessionTags(sessionId, session.tags);
      await touchTagUsage(tag);
      if (!allSuggestions.includes(tag)) allSuggestions.unshift(tag);
      renderChips();
    } else {
      // Re-applying an existing tag still counts as interaction for recency.
      await touchTagUsage(tag);
    }
    input.value = "";
    renderSuggestions("");
  };

  input.addEventListener("input", () => renderSuggestions(input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyTag(input.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeTagEditor();
    }
  });

  // Prevent the row click delegate from treating clicks inside the popover
  // as row actions.
  popover.addEventListener("click", (event) => event.stopPropagation());

  row.appendChild(popover);
  input.focus();
}

async function fetchDownloadOrphans() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "get-orphan-downloads" });
    if (response?.ok && Array.isArray(response.orphans)) return response.orphans;
  } catch (_) {}
  return [];
}

async function fetchFsRecordings() {
  try {
    const handle = await getRecordingsDirectoryHandle();
    if (!handle) return [];
    return await enumerateRecordings(handle);
  } catch (_) {
    return [];
  }
}


export function renderSessionRow(session) {
  const row = document.createElement("div");
  row.className = "recording-item";
  row.dataset.sessionId = session.id;
  row.dataset.searchBlob = [
    session.meetingLabel,
    session.tabTitle,
    session.description,
    session.transcriptText,
    Array.isArray(session.tags) ? session.tags.join(" ") : "",
  ].filter(Boolean).join(" ").toLowerCase();

  const hasTranscript = !!(session.transcriptText || session._fsTxtPath);

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "recording-item-select";
  checkbox.checked = selectedSessionIds.has(session.id);
  if (checkbox.checked) row.classList.add("is-selected");
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      selectedSessionIds.add(session.id);
      row.classList.add("is-selected");
    } else {
      selectedSessionIds.delete(session.id);
      row.classList.remove("is-selected");
    }
    updateBulkActions();
  });
  row.appendChild(checkbox);

  // Tag editor trigger — small icon in the top-right corner of the card,
  // just left of the selection checkbox. Orphaned downloads (dl-/fs- ids)
  // have no persisted session record, so tagging is only offered for real
  // sessions.
  if (typeof session.id === "string" && !session.id.startsWith("dl-") && !session.id.startsWith("fs-")) {
    const tagBtn = document.createElement("button");
    tagBtn.type = "button";
    tagBtn.className = "recording-item-tag-btn";
    tagBtn.dataset.action = "edit-tags";
    tagBtn.title = "Edit tags";
    tagBtn.setAttribute("aria-label", "Edit tags");
    tagBtn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M2 2h5.6l5.4 5.4a1.5 1.5 0 0 1 0 2.1l-3.5 3.5a1.5 1.5 0 0 1-2.1 0L2 7.6V2zm2.4 2.4a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4z"/></svg>`;
    row.appendChild(tagBtn);
  }

  const top = document.createElement("div");
  top.className = "recording-item-top";

  const title = document.createElement("div");
  title.className = "recording-item-title";
  title.textContent = session.meetingLabel || session.tabTitle || "Untitled";
  top.appendChild(title);

  if (session.description) {
    const desc = document.createElement("div");
    desc.className = "recording-item-description";
    desc.textContent = session.description;
    top.appendChild(desc);
  }

  const meta = document.createElement("div");
  meta.className = "recording-item-meta";
  const metaParts = [];
  const dateLabel = formatSessionDate(session.startedAt);
  if (dateLabel) metaParts.push(dateLabel);
  if (Number(session.durationMs) > 0) metaParts.push(formatDurationHuman(session.durationMs));
  metaParts.forEach((part, idx) => {
    if (idx > 0) meta.appendChild(makeDot());
    meta.appendChild(textNode(part));
  });

  const badges = makeBadgesForSession(session);
  if (badges) {
    if (metaParts.length > 0) meta.appendChild(makeDot());
    meta.appendChild(badges);
  }

  // Render existing tags as small read-only chips on the card.
  if (Array.isArray(session.tags) && session.tags.length > 0) {
    if (metaParts.length > 0 || badges) meta.appendChild(makeDot());
    const tagList = document.createElement("span");
    tagList.className = "recording-item-tags";
    for (const tag of session.tags) {
      const chip = document.createElement("span");
      chip.className = "recording-item-tag";
      chip.textContent = tag;
      tagList.appendChild(chip);
    }
    meta.appendChild(tagList);
  }

  top.appendChild(meta);

  row.appendChild(top);

  const actions = document.createElement("div");
  actions.className = "recording-item-actions";

  const fileNameInProgress = inProgressFileNames.has(session.fileName);
  const isQueued = (action) => queuedSessionActions.has(`${session.id}:${action}`);
  if (fileNameInProgress) row.classList.add("is-working");

  if (!hasTranscript) {
    const transcribeBtn = document.createElement("button");
    transcribeBtn.type = "button";
    transcribeBtn.className = "row-action";
    transcribeBtn.dataset.action = "transcribe";
    const transcribing = fileNameInProgress || isQueued("transcribe");
    transcribeBtn.textContent = transcribing ? "Working..." : "Transcribe";
    if (transcribing) {
      transcribeBtn.disabled = true;
      transcribeBtn.title = "Transcription is already queued or running.";
    }
    actions.appendChild(transcribeBtn);
  }

  if (!session.mp3FileName) {
    const mp3Btn = document.createElement("button");
    mp3Btn.type = "button";
    mp3Btn.className = "row-action";
    mp3Btn.dataset.action = "convert-mp3";
    const converting = fileNameInProgress || isQueued("convert-mp3");
    mp3Btn.textContent = converting ? "Working..." : "Convert to MP3";
    if (converting) {
      mp3Btn.disabled = true;
      mp3Btn.title = "MP3 conversion is already queued or running.";
    }
    actions.appendChild(mp3Btn);
  }

  if (browserAiAvailable && hasTranscript && !session._fsSummaryPath) {
    const summarizeBtn = document.createElement("button");
    summarizeBtn.type = "button";
    summarizeBtn.className = "row-action";
    summarizeBtn.dataset.action = "summarize";
    const summarizing = fileNameInProgress || isQueued("summarize");
    summarizeBtn.textContent = summarizing ? "Working..." : "Summarize";
    if (summarizing) {
      summarizeBtn.disabled = true;
      summarizeBtn.title = "Summarization is already queued or running.";
    }
    actions.appendChild(summarizeBtn);
  }

  if (speakerDetectionEnabled && session._fsSegmentsJsonPath && !session._fsDiarizedTxtPath) {
    const diarizeBtn = document.createElement("button");
    diarizeBtn.type = "button";
    diarizeBtn.className = "row-action";
    diarizeBtn.dataset.action = "diarize";
    const diarizing = fileNameInProgress || isQueued("diarize");
    diarizeBtn.textContent = diarizing ? "Working..." : "Diarize";
    if (diarizing) {
      diarizeBtn.disabled = true;
      diarizeBtn.title = "Diarization is already queued or running.";
    }
    actions.appendChild(diarizeBtn);
  }

  row.appendChild(actions);

  const progress = document.createElement("div");
  progress.className = "recording-item-progress hidden";
  progress.dataset.role = "progress";
  const labelRow = document.createElement("div");
  labelRow.className = "progress-label";
  const spinner = document.createElement("span");
  spinner.className = "progress-spinner";
  spinner.dataset.role = "progress-spinner";
  spinner.setAttribute("aria-hidden", "true");
  const labelText = document.createElement("span");
  labelText.dataset.role = "progress-label";
  labelText.textContent = "Working";
  const percentText = document.createElement("span");
  percentText.className = "progress-percent";
  percentText.dataset.role = "progress-percent";
  percentText.textContent = "0%";
  labelRow.appendChild(spinner);
  labelRow.appendChild(labelText);
  labelRow.appendChild(percentText);
  const bar = document.createElement("div");
  bar.className = "progress-bar";
  const fill = document.createElement("div");
  fill.className = "progress-fill";
  fill.dataset.role = "progress-fill";
  bar.appendChild(fill);
  progress.appendChild(labelRow);
  progress.appendChild(bar);

  const liveTranscript = document.createElement("div");
  liveTranscript.className = "transcript-preview hidden";
  liveTranscript.dataset.role = "transcript-preview";
  progress.appendChild(liveTranscript);

  row.appendChild(progress);

  if (fileNameInProgress) {
    // If this row was rebuilt mid-operation (e.g., user clicked Refresh while
    // a transcription was running), surface the spinner so they can see work
    // is still happening. The stage label is generic here since we no longer
    // hold the original setRowProgress timeline; the row's transcript preview
    // remains the live indicator of actual transcription progress.
    setRowProgress(row, { label: "Working in background...", spinner: true });
  }

  return row;
}

function appendTranscriptSegment(row, segment) {
  if (!row || !segment) return;
  const preview = row.querySelector('[data-role="transcript-preview"]');
  if (!preview) return;
  preview.classList.remove("hidden");
  const line = document.createElement("div");
  line.className = "transcript-line";
  const stamp = document.createElement("span");
  stamp.className = "transcript-stamp";
  stamp.textContent = formatStamp(segment.start);
  const text = document.createElement("span");
  text.className = "transcript-text";
  text.textContent = segment.text;
  line.appendChild(stamp);
  line.appendChild(text);
  preview.appendChild(line);
  preview.scrollTop = preview.scrollHeight;
}

function clearTranscriptPreview(row) {
  if (!row) return;
  const preview = row.querySelector('[data-role="transcript-preview"]');
  if (!preview) return;
  preview.innerHTML = "";
  preview.classList.add("hidden");
}

export function formatStamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function setRowProgress(row, { label, fraction, visible, spinner } = {}) {
  if (!row) return;
  const progress = row.querySelector('[data-role="progress"]');
  if (!progress) return;
  if (visible === false) {
    progress.classList.add("hidden");
    progress.classList.remove("is-spinner");
    return;
  }
  progress.classList.remove("hidden");
  if (spinner === true) progress.classList.add("is-spinner");
  if (spinner === false) progress.classList.remove("is-spinner");
  if (label !== undefined) {
    const el = progress.querySelector('[data-role="progress-label"]');
    if (el) el.textContent = String(label);
    updateJobProgress(String(label));
  }
  if (typeof fraction === "number") {
    const f = Math.max(0, Math.min(1, fraction));
    const fill = progress.querySelector('[data-role="progress-fill"]');
    if (fill) fill.style.width = `${f * 100}%`;
    const percent = progress.querySelector('[data-role="progress-percent"]');
    if (percent) percent.textContent = `${Math.round(f * 100)}%`;
  }
}

function textNode(value) {
  return document.createTextNode(String(value));
}

function makeDot() {
  const dot = document.createElement("span");
  dot.className = "dot";
  return dot;
}

const BADGE_ICONS = {
  // Document with text lines — represents a saved transcript.
  transcript:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/>' +
    '<line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/>' +
    '<line x1="10" y1="9" x2="8" y2="9"/>' +
    "</svg>",
  // Music note — represents an MP3 sidecar.
  mp3:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M9 18V5l12-2v13"/>' +
    '<circle cx="6" cy="18" r="3"/>' +
    '<circle cx="18" cy="16" r="3"/>' +
    "</svg>",
  // Sparkles — represents a generated AI summary.
  summary:
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3l1.9 4.6L18.5 9.5 13.9 11.4 12 16l-1.9-4.6L5.5 9.5 10.1 7.6z"/>' +
    '<path d="M19 14l.7 1.8L21.5 16.5 19.7 17.2 19 19l-.7-1.8L16.5 16.5 18.3 15.8z"/>' +
    "</svg>"
};

// A badge is an inert <span> by default. When `action` is supplied it becomes
// a real <button data-action> so the existing onRecordingsListClick delegate
// handles it — the icon doubles as a button (copy transcript, reveal MP3,
// re-summarize, etc.).
export function makeBadge(kind, label, action) {
  const el = document.createElement(action ? "button" : "span");
  el.className = `recording-badge recording-badge-${kind}${action ? " is-action" : ""}`;
  el.title = label;
  el.setAttribute("aria-label", label);
  if (action) {
    el.type = "button";
    el.dataset.action = action;
  }
  el.innerHTML = BADGE_ICONS[kind] || "";
  return el;
}

export function makeBadgesForSession(session) {
  const hasTranscript = !!(session.transcriptText || session._fsTxtPath);
  const hasMp3 = !!session.mp3FileName;
  const hasSummary = !!session._fsSummaryPath;
  if (!hasTranscript && !hasMp3 && !hasSummary) return null;
  const wrap = document.createElement("span");
  wrap.className = "recording-badges";
  // Transcript icon doubles as a copy-to-clipboard button. When a diarized
  // transcript exists it supersedes the plain one, so the copy yields the
  // speaker-labeled, timestamped version.
  if (hasTranscript) {
    const label = session._fsDiarizedTxtPath
      ? "Copy speaker transcript to clipboard"
      : "Copy transcript to clipboard";
    wrap.appendChild(makeBadge("transcript", label, "copy-transcript"));
  }
  // Summary icon indicates a summary exists and re-summarizes when clicked.
  if (hasSummary) {
    wrap.appendChild(makeBadge("summary", "Summary saved — click to re-summarize", "summarize"));
  }
  // MP3 note opens the OS file manager at the recording's folder.
  if (hasMp3) {
    wrap.appendChild(makeBadge("mp3", "Show MP3 in file manager", "reveal-mp3"));
  }
  return wrap;
}

function updateBulkActions() {
  if (!bulkActionsEl) return;
  const count = selectedSessionIds.size;
  if (count >= 1) {
    bulkActionsEl.classList.remove("hidden");
    if (combineTranscriptsBtn) {
      const hasTranscripts = cachedMergedSessions.some(
        (s) => selectedSessionIds.has(s.id) && (s.transcriptText || s._fsTxtPath || s._fsDiarizedTxtPath)
      );
      combineTranscriptsBtn.disabled = count < 2 || !hasTranscripts;
      combineTranscriptsBtn.textContent = `Combine & Copy (${count}) Transcripts`;
    }
    if (deleteSelectedBtn) {
      deleteSelectedBtn.textContent = `Delete (${count}) Recordings`;
    }
  } else {
    bulkActionsEl.classList.add("hidden");
  }
}

async function onCombineTranscripts() {
  if (selectedSessionIds.size < 2) return;

  const sessions = cachedMergedSessions
    .filter((s) => selectedSessionIds.has(s.id))
    .sort((a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0));

  const handle = await getRecordingsDirectoryHandle().catch(() => null);

  const parts = [];
  for (const session of sessions) {
    let text = session.transcriptText || "";
    if (!text && session._fsTxtPath && handle) {
      try {
        text = (await readArtifactText(handle, session._fsTxtPath)) || "";
      } catch (_) {}
    }
    if (!text && session._fsDiarizedTxtPath && handle) {
      try {
        text = (await readArtifactText(handle, session._fsDiarizedTxtPath)) || "";
      } catch (_) {}
    }
    if (!text) continue;

    const label = session.meetingLabel || session.tabTitle || "Untitled";
    const date = formatSessionDate(session.startedAt);
    parts.push(`=== ${label} (${date}) ===\n\n${text.trim()}\n`);
  }

  if (parts.length === 0) {
    statusEl.textContent = "No transcripts found for the selected recordings.";
    statusEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    return;
  }

  const combined = parts.join("\n");
  let success = false;
  try {
    await navigator.clipboard.writeText(combined);
    statusEl.textContent = `Combined ${parts.length} transcripts (oldest to newest) copied to clipboard.`;
    success = true;
  } catch (error) {
    statusEl.textContent = `Copy failed: ${error?.message || error}`;
  }
  if (combineTranscriptsBtn) {
    combineTranscriptsBtn.textContent = success ? "Copied!" : "Copy failed";
    combineTranscriptsBtn.disabled = true;
  }
  statusEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  setTimeout(() => {
    selectedSessionIds.clear();
    for (const row of recordingsListEl.querySelectorAll(".recording-item")) {
      row.classList.remove("is-selected");
      const cb = row.querySelector(".recording-item-select");
      if (cb) cb.checked = false;
    }
    for (const cb of recordingsListEl.querySelectorAll(".day-select-all")) {
      cb.checked = false;
    }
    updateBulkActions();
  }, success ? 800 : 2000);
}

async function onDeleteSelected() {
  const count = selectedSessionIds.size;
  if (count === 0) return;
  if (!confirm(`Delete ${count} selected recording${count === 1 ? "" : "s"}? Audio files and any transcripts/MP3s will be removed.`)) return;

  deleteSelectedBtn.disabled = true;
  const handle = await getRecordingsDirectoryHandle({ mode: "readwrite" }).catch(() => null);

  for (const sessionId of selectedSessionIds) {
    const session = cachedMergedSessions.find((s) => s?.id === sessionId);
    if (!session) continue;
    try {
      if (handle && session?.fileName) {
        await removeRecordingArtifact(handle, session.fileName, { extensions: ["webm", "mp3", "txt", "summary.md", "meta.json"] });
      }
    } catch (_) {}
    try {
      await chrome.runtime.sendMessage({ type: "delete-session", sessionId });
    } catch (_) {}
  }

  selectedSessionIds.clear();
  deleteSelectedBtn.disabled = false;
  await loadAndRenderSessions();
  updateBulkActions();
  statusEl.textContent = `Deleted ${count} recording${count === 1 ? "" : "s"}.`;
}

function findSessionRow(sessionId) {
  if (!recordingsListEl || !sessionId) return null;
  try {
    return recordingsListEl.querySelector(
      `.recording-item[data-session-id="${CSS.escape(String(sessionId))}"]`
    ) || null;
  } catch (_) { return null; }
}

function freshSession(sessionId) {
  return cachedMergedSessions.find((s) => s?.id === sessionId) || null;
}

const FAILURE_RE = /fail|error|not granted|not available|no transcript|could not|denied|skipped|already running/i;

function makeJobRunner(sessionId, action, opFn) {
  return async () => {
    const s = freshSession(sessionId);
    if (!s) throw new Error("Session not found");
    const row = findSessionRow(sessionId);
    const button = row?.querySelector(`button[data-action="${action}"]`) || null;
    statusEl.textContent = "";
    try {
      await opFn(s, button, row);
      const newStatus = statusEl.textContent.trim();
      if (newStatus && FAILURE_RE.test(newStatus)) {
        throw new Error(newStatus);
      }
    } finally {
      queuedSessionActions.delete(`${sessionId}:${action}`);
      await loadAndRenderSessions();
    }
  };
}

async function onRecordingsListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest(".recording-item");
  const sessionId = row?.dataset.sessionId;
  if (!sessionId) return;

  const action = button.dataset.action;

  if (action === "edit-tags") {
    openTagEditor(button, sessionId);
    return;
  }

  if (action === "copy-transcript") {
    const session = await findSession(sessionId);
    let text = "";
    let diarized = false;
    // Speaker detection supersedes the plain transcript: when a diarized
    // transcript exists, copy that (with speaker labels and timestamps) instead.
    if (session?._fsDiarizedTxtPath) {
      try {
        const handle = await getRecordingsDirectoryHandle();
        if (handle) text = (await readArtifactText(handle, session._fsDiarizedTxtPath)) || "";
        diarized = !!text;
      } catch (_) {}
    }
    if (!text) {
      text = session?.transcriptText || "";
      if (!text && session?._fsTxtPath) {
        try {
          const handle = await getRecordingsDirectoryHandle();
          if (handle) text = (await readArtifactText(handle, session._fsTxtPath)) || "";
        } catch (_) {}
      }
    }
    if (!text) {
      statusEl.textContent = "No transcript on this recording yet.";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = diarized
        ? "Speaker transcript copied to clipboard."
        : "Transcript copied to clipboard.";
    } catch (error) {
      statusEl.textContent = `Copy failed: ${error?.message || error}`;
    }
    return;
  }

  if (action === "reveal-mp3") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    await revealRecordingInFolder(session);
    return;
  }

  if (action === "convert-mp3") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    const actionKey = `${sessionId}:convert-mp3`;
    if (queuedSessionActions.has(actionKey)) return;
    queuedSessionActions.add(actionKey);
    loadAndRenderSessions().catch(() => {});
    enqueueJob({
      type: "convert-mp3",
      label: "Convert to MP3",
      sessionId: session.id,
      sessionLabel: session.meetingLabel || session.tabTitle || "Untitled",
      run: makeJobRunner(sessionId, "convert-mp3", (s, btn, row) => convertSessionToMp3(s, btn, row)),
    });
    return;
  }

  if (action === "transcribe") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    const actionKey = `${sessionId}:transcribe`;
    if (queuedSessionActions.has(actionKey)) return;
    queuedSessionActions.add(actionKey);
    loadAndRenderSessions().catch(() => {});
    enqueueJob({
      type: "transcribe",
      label: "Transcribe",
      sessionId: session.id,
      sessionLabel: session.meetingLabel || session.tabTitle || "Untitled",
      run: makeJobRunner(sessionId, "transcribe", (s, btn, row) => transcribeSession(s, btn, row)),
    });
    return;
  }

  if (action === "summarize") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    const actionKey = `${sessionId}:summarize`;
    if (queuedSessionActions.has(actionKey)) return;
    queuedSessionActions.add(actionKey);
    loadAndRenderSessions().catch(() => {});
    enqueueJob({
      type: "summarize",
      label: "Summarize",
      sessionId: session.id,
      sessionLabel: session.meetingLabel || session.tabTitle || "Untitled",
      run: makeJobRunner(sessionId, "summarize", (s, btn, row) => summarizeSession(s, btn, row)),
    });
    return;
  }

  if (action === "diarize") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    const actionKey = `${sessionId}:diarize`;
    if (queuedSessionActions.has(actionKey)) return;
    queuedSessionActions.add(actionKey);
    loadAndRenderSessions().catch(() => {});
    enqueueJob({
      type: "diarize",
      label: "Diarize",
      sessionId: session.id,
      sessionLabel: session.meetingLabel || session.tabTitle || "Untitled",
      run: makeJobRunner(sessionId, "diarize", (s, btn, row) => diarizeSession(s, btn, row)),
    });
    return;
  }
}

async function refreshBrowserAiAvailability() {
  try {
    browserAiAvailable = await isBrowserAiAvailable();
  } catch (_) {
    browserAiAvailable = false;
  }
}

async function summarizeSession(session, button, row) {
  if (!browserAiAvailable) {
    statusEl.textContent = "Browser AI not available on this device.";
    return;
  }
  if (inProgressFileNames.has(session.fileName)) {
    statusEl.textContent = "Another operation is already running on this recording.";
    return;
  }

  // Load transcript text — prefer in-memory, fall back to the FS sidecar.
  let transcript = session.transcriptText || "";
  if (!transcript && session._fsTxtPath) {
    try {
      const handle = await getRecordingsDirectoryHandle();
      if (handle) transcript = (await readArtifactText(handle, session._fsTxtPath)) || "";
    } catch (_) {}
  }
  if (!transcript) {
    statusEl.textContent = "No transcript on this recording yet.";
    return;
  }

  row = row || button?.closest(".recording-item") || null;
  startOperation(session.fileName);
  if (row) {
    row.classList.add("is-working");
    setRowProgress(row, { label: "Summarizing with Gemini Nano...", spinner: true });
  }
  if (button) {
    button.disabled = true;
    button.textContent = "Working...";
  }

  try {
    const headChars = await getSummaryHeadChars();
    const { description, summary } = await summarizeAndDescribe(transcript, { headChars });
    if (!summary && !description) {
      throw new Error("Empty response from on-device model");
    }

    const body = serializeSummary({
      description,
      summary,
      model: BROWSER_AI.MODEL_LABEL,
      generatedAt: new Date()
    });
    const blob = new Blob([body], { type: "text/markdown" });

    const handle = await getRecordingsDirectoryHandle({ mode: "readwrite" });
    if (!handle) throw new Error("Recordings folder not granted.");
    await writeRecordingArtifact(handle, session.fileName, blob, { extension: "summary.md" });

    statusEl.textContent = "Summary saved next to the recording.";
  } catch (error) {
    statusEl.textContent = `Summarize failed: ${error?.message || error}`;
    if (row) setRowProgress(row, { visible: false });
    if (button) {
      button.disabled = false;
      button.textContent = session._fsSummaryPath ? "Re-summarize" : "Summarize";
    }
  } finally {
    endOperation(session.fileName);
    await loadAndRenderSessions();
  }
}

async function diarizeSession(session, button, row) {
  if (inProgressFileNames.has(session.fileName)) {
    statusEl.textContent = "Another operation is already running on this recording.";
    return;
  }
  if (!(await getSpeakerDetectionEnabled())) {
    statusEl.textContent =
      "Speaker detection is disabled. Enable it in Settings to diarize recordings.";
    return;
  }
  if (!session._fsSegmentsJsonPath) {
    statusEl.textContent =
      "No Whisper segments saved for this recording — re-transcribe to enable diarization.";
    return;
  }

  row = row || button?.closest(".recording-item") || null;
  const originalLabel = button?.textContent;
  startOperation(session.fileName);
  if (row) {
    row.classList.add("is-working");
    setRowProgress(row, { label: "Loading audio for diarization", spinner: true });
  }
  if (button) {
    button.disabled = true;
    button.textContent = "Working...";
  }

  let client = null;
  try {
    const handle = await getRecordingsDirectoryHandle({ mode: "readwrite" });
    if (!handle) throw new Error("Recordings folder not granted.");

    const segmentsText = await readArtifactText(handle, session._fsSegmentsJsonPath);
    if (!segmentsText) throw new Error("Could not read segments sidecar.");
    let segments;
    try {
      const parsed = JSON.parse(segmentsText);
      segments = Array.isArray(parsed?.segments) ? parsed.segments : [];
    } catch (error) {
      throw new Error(`Segments sidecar is not valid JSON: ${error?.message || error}`);
    }
    if (segments.length < 2) {
      throw new Error("Need at least two transcribed segments to detect speakers.");
    }

    setRowProgress(row, { label: "Decoding audio" });
    const file = await readRecordingFile(handle, session.fileName);
    const audioCtx = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();
    const pcm16k = await resampleToMono16k(audioBuffer);

    setRowProgress(row, { label: "Loading speaker-embedding model" });
    const modelId = await getSelectedSpeakerEmbedModelId();
    client = await openDiarizationWorker({
      modelId,
      onStage: (stage) => setRowProgress(row, { label: stage }),
      onDownloadProgress: ({ file: fileName, loaded, total, progress }) => {
        const pct = Number(progress) || (total ? Math.round((loaded / total) * 100) : 0);
        const label = fileName
          ? `Downloading ${fileName} (${pct}%)`
          : `Downloading speaker model (${pct}%)`;
        setRowProgress(row, { label });
      },
      onEngine: (device) => {
        setRowProgress(row, {
          label: device === "webgpu" ? "Embedding on WebGPU" : "Embedding on CPU"
        });
      }
    });

    setRowProgress(row, { label: "Embedding utterances (0/?)" });
    const result = await diarize({
      segments,
      pcm16k,
      embedFn: (slice) => client.embed(slice),
      onUtteranceProgress: (current, total) => {
        setRowProgress(row, { label: `Embedding utterances (${current}/${total})` });
      }
    });

    if (result.skipped === "too-few-utterances") {
      statusEl.textContent =
        "Diarization skipped — fewer than two utterances survived segmentation.";
      setRowProgress(row, { visible: false });
      return;
    }

    setRowProgress(row, { label: "Saving diarized transcript" });
    const txt = formatDiarizedText(result.utterances);
    const json = formatDiarizedJson(result.utterances, result.speakerCount, {
      sourceFile: session.fileName,
      modelId,
      device: client.device,
      generatedAt: new Date().toISOString()
    });

    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([txt], { type: "text/plain" }),
      { extension: "diarized.txt" }
    );
    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([json], { type: "application/json" }),
      { extension: "diarized.json" }
    );

    statusEl.textContent =
      `Diarized transcript saved (${result.speakerCount} speaker${result.speakerCount === 1 ? "" : "s"}, ${result.utterances.length} utterances).`;
    setRowProgress(row, { label: "Done", spinner: false });
  } catch (error) {
    console.error("[panel] diarization failed", error);
    statusEl.textContent = `Diarize failed: ${error?.message || error}`;
    if (row) setRowProgress(row, { visible: false });
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel || (session._fsDiarizedTxtPath ? "Re-diarize" : "Diarize");
    }
  } finally {
    if (client) client.terminate();
    endOperation(session.fileName);
    await loadAndRenderSessions();
  }
}

async function findSession(sessionId) {
  return cachedMergedSessions.find((s) => s?.id === sessionId) || null;
}

function triggerAutoTranscribe(sessionId) {
  if (!sessionId || !recordingsListEl) return;
  // The list re-renders on every save-session; the row should exist by now.
  const row = recordingsListEl.querySelector(
    `.recording-item[data-session-id="${CSS.escape(String(sessionId))}"]`
  );
  if (!row) return;
  const btn = row.querySelector('button[data-action="transcribe"]');
  if (btn && !btn.disabled) {
    statusEl.textContent = "Auto-transcribing...";
    btn.click();
  }
}

export function formatSessionDate(ts) {
  if (!ts) return "";
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function formatDurationHuman(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

async function ensureRecordingsHandle({ writable = false } = {}) {
  const mode = writable ? "readwrite" : "read";
  let handle = null;
  try { handle = await getRecordingsDirectoryHandle({ mode }); } catch (_) {}
  if (!handle) {
    statusEl.textContent = "Pick the Tab Recorder folder to grant access.";
    handle = await pickRecordingsDirectory();
    enrichDurationsInBackground().catch(() => {});
  } else if (writable) {
    const ok = await ensureWritable(handle);
    if (!ok) throw new Error("Write permission denied for recordings folder.");
  }
  updateFolderStatus(handle).catch(() => {});
  return handle;
}

async function convertSessionToMp3(session, button, row) {
  startOperation(session?.fileName);
  try {
    await convertSessionToMp3Impl(session, button, row);
  } finally {
    endOperation(session?.fileName);
    await loadAndRenderSessions();
  }
}

async function convertSessionToMp3Impl(session, button, row) {
  row = row || button?.closest(".recording-item") || null;

  let handle;
  try {
    handle = await ensureRecordingsHandle({ writable: true });
  } catch (error) {
    statusEl.textContent = `Folder access not granted: ${error?.message || error}`;
    return;
  }

  const originalLabel = button?.textContent || "";
  const restore = () => {
    if (button) { button.disabled = false; button.textContent = originalLabel; }
    setRowProgress(row, { visible: false });
  };

  if (button) { button.disabled = true; button.textContent = "Working..."; }
  statusEl.textContent = "";

  setRowProgress(row, { label: "Reading", fraction: 0 });

  let file;
  try {
    file = await readRecordingFile(handle, session.fileName);
  } catch (error) {
    statusEl.textContent = `Could not open file: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Decoding", fraction: 0.05 });
  let audioBuffer;
  try {
    const audioCtx = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();
  } catch (error) {
    statusEl.textContent = `Decode failed: ${error?.message || error}`;
    restore();
    return;
  }

  const durationMs = Math.round(audioBuffer.duration * 1000);
  setCachedDuration(session.fileName, durationMs);

  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
  const sampleRate = audioBuffer.sampleRate;

  setRowProgress(row, { label: "Encoding", fraction: 0.1 });
  let mp3Buffer;
  try {
    mp3Buffer = await encodeMp3InWorker(left, right, sampleRate, (progress) => {
      // Encoding spans 10% to 95% of the visible bar so reading/decoding/saving have room.
      setRowProgress(row, { label: "Encoding", fraction: 0.1 + progress * 0.85 });
    });
  } catch (error) {
    statusEl.textContent = `Encode failed: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Saving", fraction: 0.97 });
  const mp3Blob = new Blob([mp3Buffer], { type: "audio/mpeg" });
  let mp3FileName;
  try {
    const result = await writeRecordingArtifact(handle, session.fileName, mp3Blob, { extension: "mp3" });
    mp3FileName = result.fileName;
  } catch (error) {
    statusEl.textContent = `Save failed: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Done", fraction: 1 });

  // Promote synthesized rows so the session store can carry the MP3 reference
  let storedSessionId = session.id;
  if (typeof session.id === "string" && (session.id.startsWith("dl-") || session.id.startsWith("fs-"))) {
    try {
      const persistResponse = await chrome.runtime.sendMessage({
        type: "save-session",
        session: {
          id: makeId(),
          meetingLabel: session.meetingLabel,
          tabTitle: session.tabTitle,
          startedAt: session.startedAt,
          endedAt: session.startedAt + durationMs,
          durationMs,
          fileName: session.fileName,
          downloadId: session.downloadId ?? null,
          audioFormat: "webm",
          audioMimeType: "audio/webm"
        }
      });
      if (persistResponse?.ok && persistResponse.session?.id) {
        storedSessionId = persistResponse.session.id;
      }
    } catch (_) {}
  }

  try {
    await chrome.runtime.sendMessage({
      type: "update-session-mp3",
      sessionId: storedSessionId,
      mp3: { downloadId: null, fileName: mp3FileName }
    });
  } catch (_) {}

  statusEl.textContent = `MP3 saved: ${mp3FileName}`;
}

function encodeMp3InWorker(left, right, sampleRate, onProgress) {
  return new Promise((resolve, reject) => {
    const workerUrl = chrome.runtime.getURL("lib/mp3Worker.js");
    const worker = new Worker(workerUrl, { type: "module" });
    const jobId = Math.random().toString(36).slice(2, 10);

    worker.onmessage = (event) => {
      const data = event.data;
      if (!data || data.jobId !== jobId) return;
      if (data.type === "progress") {
        onProgress?.(data.progress);
        return;
      }
      if (data.type === "done") {
        worker.terminate();
        resolve(data.mp3);
        return;
      }
      if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.error || "Encode failed"));
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "Worker error"));
    };

    // Copy buffers since AudioBuffer-owned views are not transferable.
    const leftCopy = new Float32Array(left);
    const rightCopy = right ? new Float32Array(right) : null;
    const transfer = [leftCopy.buffer];
    if (rightCopy) transfer.push(rightCopy.buffer);

    worker.postMessage(
      {
        type: "encode",
        jobId,
        left: leftCopy,
        right: rightCopy,
        sampleRate,
        bitrate: 128
      },
      transfer
    );
  });
}

async function transcribeSession(session, button, row) {
  startOperation(session?.fileName);
  try {
    await transcribeSessionImpl(session, button, row);
  } finally {
    endOperation(session?.fileName);
    await loadAndRenderSessions();
  }
}

async function transcribeSessionImpl(session, button, row) {
  row = row || button?.closest(".recording-item") || null;

  let handle;
  try {
    handle = await ensureRecordingsHandle({ writable: true });
  } catch (error) {
    statusEl.textContent = `Folder access not granted: ${error?.message || error}`;
    return;
  }

  const originalLabel = button?.textContent || "";
  const restore = () => {
    if (button) { button.disabled = false; button.textContent = originalLabel; }
    setRowProgress(row, { visible: false });
    clearTranscriptPreview(row);
  };

  if (button) { button.disabled = true; button.textContent = "Working..."; }
  statusEl.textContent = "";

  // Transcription has no truthful percentage — switch the row's progress
  // element into spinner mode for the entire whisper run.
  setRowProgress(row, { label: "Reading audio file", spinner: true });
  clearTranscriptPreview(row);

  let file;
  {
    const MAX_ATTEMPTS = 5;
    const RETRY_MS = 1000;
    let lastError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        file = await readRecordingFile(handle, session.fileName);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_ATTEMPTS) {
          setRowProgress(row, { label: `Waiting for file (${attempt}/${MAX_ATTEMPTS - 1})`, spinner: true });
          await sleep(RETRY_MS);
        }
      }
    }
    if (!file) {
      statusEl.textContent = `Could not open file: ${lastError?.message || lastError}`;
      restore();
      return;
    }
  }

  setRowProgress(row, { label: "Inspecting audio" });
  let audioBuffer;
  let durationMs = Math.round(Number(session?.durationMs) || 0);
  let transcriptionPlan = createTranscriptionChunkPlan(durationMs);
  const canStreamLargeWebm =
    transcriptionPlan.chunked &&
    isWebmRecording(file, session) &&
    canDecodeWebmOpusWithWebCodecs();

  if (!canStreamLargeWebm) {
    if (transcriptionPlan.chunked && isWebmRecording(file, session)) {
      statusEl.textContent =
        "This browser cannot stream-decode large WebM/Opus recordings. " +
        "Update Chrome and try again.";
      restore();
      return;
    }
    setRowProgress(row, { label: "Decoding audio" });
    try {
      const audioCtx = new AudioContext();
      try {
        const arrayBuffer = await file.arrayBuffer();
        audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      } finally {
        await audioCtx.close().catch(() => {});
      }
      durationMs = Math.round(audioBuffer.duration * 1000);
      setCachedDuration(session.fileName, durationMs);
      transcriptionPlan = createTranscriptionChunkPlan(durationMs);
    } catch (error) {
      statusEl.textContent = `Decode failed: ${error?.message || error}`;
      restore();
      return;
    }
  } else {
    setCachedDuration(session.fileName, durationMs);
  }

  if (transcriptionPlan?.chunked) {
    statusEl.textContent =
      `Large recording detected (${formatDurationHuman(durationMs)}). ` +
      `Transcribing in ${transcriptionPlan.chunks.length} chunks.`;
    setRowProgress(row, { label: `Large recording: ${transcriptionPlan.chunks.length} transcription chunks` });
  }

  setRowProgress(row, { label: "Preparing transcription" });
  const modelId = await getSelectedModelId();
  const transcriptionCallbacks = {
    modelId,
    row,
    onDownloadProgress: ({ file: fileName, loaded, total, progress }) => {
      const pct = Number(progress) || (total ? Math.round((loaded / total) * 100) : 0);
      const label = fileName
        ? `Downloading ${fileName} (${pct}%)`
        : `Downloading model (${pct}%)`;
      setRowProgress(row, { label });
    },
    onSegment: (segment) => {
      appendTranscriptSegment(row, segment);
    }
  };

  let result;
  try {
    result = audioBuffer
      ? await transcribeAudioBuffer(audioBuffer, transcriptionPlan, transcriptionCallbacks)
      : await transcribeWebmOpusFile(file, transcriptionPlan, transcriptionCallbacks);
  } catch (error) {
    const msg = String(error?.message || error);
    console.error("[panel] transcription failed", error);
    statusEl.textContent = `Transcription failed: ${msg}`;
    restore();
    return;
  }
  audioBuffer = null;

  console.log("[panel] transcription returned", {
    device: result.device,
    textLength: (result.text || "").length,
    segmentCount: (result.segments || []).length
  });

  if (!result.text || !result.text.trim()) {
    statusEl.textContent =
      "Transcription completed but produced no text. The audio may be silent, " +
      "the model may not have detected speech, or the engine returned an empty " +
      "result. Check the [whisperWorker] log for details.";
    restore();
    return;
  }

  setRowProgress(row, { label: "Saving transcript" });
  // Write transcript next to the webm so the file lives in the same folder.
  try {
    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([result.text], { type: "text/plain" }),
      { extension: "txt" }
    );
  } catch (error) {
    statusEl.textContent = `Saving transcript file failed: ${error?.message || error}`;
    restore();
    return;
  }

  // Also persist Whisper segments as a sidecar so a later "Diarize" click
  // can run without re-transcribing. Non-fatal on failure.
  try {
    const segmentsPayload = JSON.stringify(
      { version: 1, segments: result.segments || [] },
      null,
      2
    );
    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([segmentsPayload], { type: "application/json" }),
      { extension: "segments.json" }
    );
  } catch (error) {
    console.warn("[panel] failed to write segments.json sidecar", error);
  }

  const sessionId = await ensureStoredSessionId(session, durationMs);
  if (sessionId) {
    try {
      await chrome.runtime.sendMessage({
        type: "update-session-transcript",
        sessionId,
        transcriptText: result.text,
        transcriptWords: result.segments || []
      });
    } catch (error) {
      // Non-fatal: the .txt is on disk regardless.
    }
  }

  setRowProgress(row, { label: "Done", spinner: false });
  statusEl.textContent = `Transcript saved (${result.segments?.length || 0} segments, ${result.text.length} chars).`;

  await maybeAutoSummarize(session, result.text, handle, row);
  await maybeAutoDiarize(session, result.segments, handle, row);
}

async function maybeAutoDiarize(session, segments, handle, row) {
  // Defensive: only fire when the user has opted in AND the speaker
  // model is already cached. The toggle is gated on cache state in the
  // settings UI, but a stale toggle could still flip true here — recheck.
  if (!Array.isArray(segments) || segments.length < 2) return;
  // Master opt-in gates everything: if speaker detection is off, auto-diarize
  // never runs even if its own toggle was left enabled from a prior session.
  let featureOn = false;
  try {
    featureOn = await getSpeakerDetectionEnabled();
  } catch (_) {}
  if (!featureOn) return;
  let enabled = false;
  try {
    enabled = await getAutoDiarizePreference();
  } catch (_) {}
  if (!enabled) return;

  const modelId = await getSelectedSpeakerEmbedModelId();
  let cached = false;
  try {
    cached = await isSpeakerEmbedModelCached(modelId);
  } catch (_) {}
  if (!cached) {
    statusEl.textContent =
      "Auto-diarize is enabled but the speaker model isn't cached yet. " +
      "Download it from Settings to enable automatic diarization.";
    return;
  }

  let client = null;
  try {
    if (row) setRowProgress(row, { label: "Auto-diarizing", spinner: true });

    const file = await readRecordingFile(handle, session.fileName);
    const audioCtx = new AudioContext();
    const audioBuffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    audioCtx.close();
    const pcm16k = await resampleToMono16k(audioBuffer);

    client = await openDiarizationWorker({
      modelId,
      onStage: (stage) => row && setRowProgress(row, { label: stage }),
      onDownloadProgress: () => {
        // Should not happen: cache check above means no download.
      },
      onEngine: (device) => {
        if (row) {
          setRowProgress(row, {
            label: device === "webgpu" ? "Embedding on WebGPU" : "Embedding on CPU"
          });
        }
      }
    });

    const result = await diarize({
      segments,
      pcm16k,
      embedFn: (slice) => client.embed(slice),
      onUtteranceProgress: (current, total) => {
        if (row) setRowProgress(row, { label: `Embedding utterances (${current}/${total})` });
      }
    });

    if (result.skipped) return;

    const txt = formatDiarizedText(result.utterances);
    const json = formatDiarizedJson(result.utterances, result.speakerCount, {
      sourceFile: session.fileName,
      modelId,
      device: client.device,
      generatedAt: new Date().toISOString()
    });
    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([txt], { type: "text/plain" }),
      { extension: "diarized.txt" }
    );
    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([json], { type: "application/json" }),
      { extension: "diarized.json" }
    );
    statusEl.textContent = `Transcript saved. Diarized as ${result.speakerCount} speaker${result.speakerCount === 1 ? "" : "s"}.`;
  } catch (error) {
    // Auto-diarize must not poison the happy transcription path.
    console.warn("[panel] auto-diarize failed", error);
  } finally {
    if (client) client.terminate();
  }
}

async function maybeAutoSummarize(session, transcriptText, handle, row) {
  if (!browserAiAvailable) return;
  let enabled = false;
  try {
    enabled = await getAutoSummarizePreference();
  } catch (_) {}
  if (!enabled) return;
  if (!transcriptText || !transcriptText.trim()) return;

  try {
    if (row) setRowProgress(row, { label: "Summarizing with Gemini Nano...", spinner: true });
    const headChars = await getSummaryHeadChars();
    const { description, summary } = await summarizeAndDescribe(transcriptText, { headChars });
    if (!description && !summary) return;
    const body = serializeSummary({
      description,
      summary,
      model: BROWSER_AI.MODEL_LABEL,
      generatedAt: new Date()
    });
    await writeRecordingArtifact(
      handle,
      session.fileName,
      new Blob([body], { type: "text/markdown" }),
      { extension: "summary.md" }
    );
    statusEl.textContent = "Transcript saved. Summary saved next to the recording.";
  } catch (error) {
    // Auto-summary must not poison the happy transcription path.
    console.warn("[panel] auto-summarize failed", error);
  }
}

async function ensureStoredSessionId(session, durationMs) {
  if (typeof session.id === "string" && !session.id.startsWith("dl-") && !session.id.startsWith("fs-")) {
    return session.id;
  }
  try {
    const persistResponse = await chrome.runtime.sendMessage({
      type: "save-session",
      session: {
        id: makeId(),
        meetingLabel: session.meetingLabel,
        tabTitle: session.tabTitle,
        startedAt: session.startedAt,
        endedAt: session.startedAt + (Number(durationMs) || 0),
        durationMs: Number(durationMs) || 0,
        fileName: session.fileName,
        downloadId: session.downloadId ?? null,
        audioFormat: "webm",
        audioMimeType: "audio/webm"
      }
    });
    return persistResponse?.session?.id || null;
  } catch (_) {
    return null;
  }
}

async function resampleToMono16k(audioBuffer) {
  return await renderMono16k(audioBuffer);
}

async function resampleAudioBufferRangeToMono16k(audioBuffer, startMs, endMs) {
  return await renderMono16k(audioBuffer, { startMs, endMs });
}

async function renderMono16k(audioBuffer, { startMs = 0, endMs = null } = {}) {
  const targetRate = TRANSCRIPTION_SAMPLE_RATE;
  const startSec = Math.max(0, Number(startMs) / 1000 || 0);
  const requestedEndSec = endMs == null ? audioBuffer.duration : Number(endMs) / 1000;
  const endSec = Math.min(
    audioBuffer.duration,
    Number.isFinite(requestedEndSec) && requestedEndSec > startSec
      ? requestedEndSec
      : audioBuffer.duration
  );
  const durationSec = Math.max(1 / targetRate, endSec - startSec);
  const numFrames = Math.max(1, Math.ceil(durationSec * targetRate));
  const offline = new OfflineAudioContext(1, numFrames, targetRate);
  const source = offline.createBufferSource();
  source.buffer = audioBuffer;

  if (audioBuffer.numberOfChannels > 1) {
    const merger = offline.createChannelMerger(1);
    const splitter = offline.createChannelSplitter(audioBuffer.numberOfChannels);
    source.connect(splitter);
    const gain = offline.createGain();
    gain.gain.value = 1 / audioBuffer.numberOfChannels;
    for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
      splitter.connect(gain, ch);
    }
    gain.connect(merger, 0, 0);
    merger.connect(offline.destination);
  } else {
    source.connect(offline.destination);
  }

  source.start(0, startSec, durationSec);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

async function transcribeAudioBuffer(
  audioBuffer,
  plan,
  { modelId, row, onDownloadProgress, onSegment } = {}
) {
  if (!plan?.chunked) {
    setRowProgress(row, { label: "Resampling audio" });
    const pcm16k = await resampleToMono16k(audioBuffer);
    return await runWhisperWorker(pcm16k, {
      modelId,
      onStage: (stage) => setRowProgress(row, { label: stage }),
      onDownloadProgress,
      onEngine: (device) => {
        setRowProgress(row, { label: formatTranscriptionEngineLabel(device) });
      },
      onSegment
    });
  }

  return await runChunkedWhisperTranscription(audioBuffer, plan, {
    modelId,
    row,
    onDownloadProgress,
    onSegment
  });
}

async function runChunkedWhisperTranscription(
  audioBuffer,
  plan,
  { modelId, row, onDownloadProgress, onSegment } = {}
) {
  const chunkResults = [];
  let activeChunkLabel = "";
  let device = null;
  const client = createWhisperWorkerClient({
    modelId,
    onDownloadProgress,
    onEngine: (engine) => {
      setRowProgress(row, { label: formatTranscriptionEngineLabel(engine, activeChunkLabel) });
    }
  });

  try {
    for (const chunk of plan.chunks) {
      activeChunkLabel = formatTranscriptionChunkLabel(chunk);
      setRowProgress(row, { label: `Preparing ${activeChunkLabel}` });
      const pcm16k = await resampleAudioBufferRangeToMono16k(
        audioBuffer,
        chunk.audioStartMs,
        chunk.audioEndMs
      );

      setRowProgress(row, { label: `Transcribing ${activeChunkLabel}` });
      const result = await client.transcribe(pcm16k, {
        onStage: (stage) => {
          if (stage === "Transcribing") {
            setRowProgress(row, { label: `Transcribing ${activeChunkLabel}` });
          } else {
            setRowProgress(row, { label: `${stage} (${chunk.index + 1}/${chunk.total})` });
          }
        },
        onSegment: (segment) => {
          const adjusted = offsetTranscriptionSegment(segment, chunk.audioStartMs);
          if (segmentBelongsToTranscriptionChunk(adjusted, chunk)) {
            onSegment?.(adjusted);
          }
        }
      });
      device = result.device || device;
      chunkResults.push({ chunk, result });
    }
  } finally {
    client.terminate();
  }

  return {
    ...mergeTranscriptionChunkResults(chunkResults),
    device,
    chunkCount: plan.chunks.length
  };
}

async function transcribeWebmOpusFile(
  file,
  plan,
  { modelId, row, onDownloadProgress, onSegment } = {}
) {
  const chunkResults = [];
  let activeChunkLabel = "";
  let device = null;
  const client = createWhisperWorkerClient({
    modelId,
    onDownloadProgress,
    onEngine: (engine) => {
      setRowProgress(row, { label: formatTranscriptionEngineLabel(engine, activeChunkLabel) });
    }
  });

  try {
    setRowProgress(row, { label: "Reading WebM audio packets" });
    const chunks = decodeWebmOpusChunks(file, plan, {
      onProgress: ({ chunk, fed, total }) => {
        const label = formatTranscriptionChunkLabel(chunk);
        setRowProgress(row, { label: `Decoding ${label} (${fed}/${total})` });
      }
    });

    for await (const { chunk, pcm16k, packetCount, decodedFrames } of chunks) {
      if (!packetCount || !decodedFrames) continue;
      activeChunkLabel = formatTranscriptionChunkLabel(chunk);
      setRowProgress(row, { label: `Transcribing ${activeChunkLabel}` });
      const result = await client.transcribe(pcm16k, {
        onStage: (stage) => {
          if (stage === "Transcribing") {
            setRowProgress(row, { label: `Transcribing ${activeChunkLabel}` });
          } else {
            setRowProgress(row, { label: `${stage} (${chunk.index + 1}/${chunk.total})` });
          }
        },
        onSegment: (segment) => {
          const adjusted = offsetTranscriptionSegment(segment, chunk.audioStartMs);
          if (segmentBelongsToTranscriptionChunk(adjusted, chunk)) {
            onSegment?.(adjusted);
          }
        }
      });
      device = result.device || device;
      chunkResults.push({ chunk, result });
    }
  } finally {
    client.terminate();
  }

  return {
    ...mergeTranscriptionChunkResults(chunkResults),
    device,
    chunkCount: plan.chunks.length
  };
}

export function isWebmRecording(file, session) {
  const name = String(file?.name || session?.fileName || "").toLowerCase();
  const type = String(file?.type || "").toLowerCase();
  return name.endsWith(".webm") || type.includes("webm");
}

export function formatTranscriptionChunkLabel(chunk) {
  return (
    `chunk ${chunk.index + 1}/${chunk.total} ` +
    `(${formatDurationHuman(chunk.coreStartMs)}-${formatDurationHuman(chunk.coreEndMs)})`
  );
}

export function formatTranscriptionEngineLabel(device, chunkLabel = "") {
  const engine = device === "webgpu" ? "WebGPU" : "CPU";
  return chunkLabel ? `Transcribing ${chunkLabel} on ${engine}` : `Transcribing on ${engine}`;
}

async function runWhisperWorker(pcm16k, options = {}) {
  const client = createWhisperWorkerClient(options);
  try {
    return await client.transcribe(pcm16k, options);
  } finally {
    client.terminate();
  }
}

function createWhisperWorkerClient({ modelId, onEngine, onDownloadProgress } = {}) {
  const workerUrl = chrome.runtime.getURL("lib/whisperWorker.js");
  const worker = new Worker(workerUrl, { type: "module" });
  let activeJob = null;
  let closed = false;

  const rejectActive = (error) => {
    if (!activeJob) return;
    const job = activeJob;
    activeJob = null;
    job.reject(error);
  };

  worker.onmessage = (event) => {
    const data = event.data;
    if (!data) return;
    if (data.type === "worker-import-error") {
      rejectActive(new Error(data.error || "Transformers.js import failed"));
      return;
    }
    if (!activeJob || data.jobId !== activeJob.jobId) return;
    if (data.type === "stage") {
      try { activeJob.onStage?.(data.stage); } catch (_) {}
      return;
    }
    if (data.type === "downloadProgress") {
      try { onDownloadProgress?.(data); } catch (_) {}
      return;
    }
    if (data.type === "engine") {
      try { onEngine?.(data.device); } catch (_) {}
      return;
    }
    if (data.type === "segment") {
      if (data.segment) {
        try { activeJob.onSegment?.(data.segment); } catch (_) {}
      }
      return;
    }
    if (data.type === "done") {
      const job = activeJob;
      activeJob = null;
      job.resolve({
        text: data.text || "",
        segments: data.segments || [],
        device: data.device || null
      });
      return;
    }
    if (data.type === "error") {
      rejectActive(new Error(data.error || "Transcription failed"));
    }
  };
  worker.onerror = (event) => {
    const detail = formatWorkerErrorEvent(event);
    console.error("[panel] whisper worker errored", event);
    worker.terminate();
    closed = true;
    rejectActive(new Error(detail || "Worker error (no details from runtime)"));
  };
  worker.onmessageerror = (event) => {
    console.error("[panel] whisper worker message error", event);
    worker.terminate();
    closed = true;
    rejectActive(new Error("Worker message error (postMessage cloning failed)"));
  };

  return {
    transcribe(pcm16k, { onSegment, onStage } = {}) {
      if (closed) return Promise.reject(new Error("Whisper worker is closed."));
      if (activeJob) return Promise.reject(new Error("Whisper worker already has an active job."));

      return new Promise((resolve, reject) => {
        const jobId = Math.random().toString(36).slice(2, 10);
        activeJob = { jobId, resolve, reject, onSegment, onStage };

        const pcm =
          pcm16k instanceof Float32Array ? pcm16k : new Float32Array(pcm16k || []);
        const transferablePcm =
          pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
            ? pcm
            : new Float32Array(pcm);

        try {
          worker.postMessage(
            {
              type: "transcribe",
              jobId,
              modelId: modelId || "Xenova/whisper-small.en",
              pcm: transferablePcm,
              language: "english"
            },
            [transferablePcm.buffer]
          );
        } catch (error) {
          activeJob = null;
          reject(error);
        }
      });
    },
    terminate() {
      if (closed) return;
      closed = true;
      worker.terminate();
      rejectActive(new Error("Whisper worker terminated."));
    }
  };
}

async function openRecordingsFolder() {
  // chrome.downloads.show(id) opens the OS file manager focused on a download.
  // We prefer to show the most-recent Tab Recorder webm so the user lands
  // inside `~/Downloads/Tab Recorder/<date>/`. If no Tab Recorder downloads
  // are tracked yet, fall back to the default Downloads folder.
  try {
    const matches = await chrome.downloads
      .search({
        filenameRegex: "Tab Recorder.*\\.webm$",
        orderBy: ["-startTime"],
        limit: 1,
        exists: true
      })
      .catch(() => []);
    if (Array.isArray(matches) && matches.length > 0) {
      chrome.downloads.show(matches[0].id);
      return;
    }
    chrome.downloads.showDefaultFolder();
  } catch (error) {
    statusEl.textContent = `Could not open folder: ${error?.message || error}`;
  }
}

async function revealDayFolder(dayKey) {
  if (!dayKey) return;
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const matches = await chrome.downloads
      .search({
        filenameRegex: `Tab Recorder/${escapeRe(dayKey)}/.*\\.webm$`,
        orderBy: ["-startTime"],
        limit: 1,
        exists: true
      })
      .catch(() => []);
    if (Array.isArray(matches) && matches.length > 0) {
      chrome.downloads.show(matches[0].id);
      statusEl.textContent = `Opened folder for ${dayKey}.`;
      return;
    }
    chrome.downloads.showDefaultFolder();
    statusEl.textContent = "Opened your downloads folder (day folder not found in download history).";
  } catch (error) {
    statusEl.textContent = `Could not open folder: ${error?.message || error}`;
  }
}

async function revealRecordingInFolder(session) {
  // MP3 and other sidecars are written to the recordings folder via the File
  // System Access API, which has no "reveal in OS file manager" capability.
  // The achievable best is to open the folder holding this recording's files
  // through chrome.downloads.show — try the MP3 by name, then the original
  // webm (by tracked downloadId, then by name), falling back to the default
  // downloads folder.
  const base = (name) => String(name || "").split(/[\\/]/).pop() || "";
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const findDownload = async (fileName) => {
    const b = base(fileName);
    if (!b) return null;
    const matches = await chrome.downloads
      .search({ filenameRegex: escapeRe(b) + "$", exists: true, orderBy: ["-startTime"], limit: 1 })
      .catch(() => []);
    return Array.isArray(matches) && matches.length ? matches[0] : null;
  };
  try {
    const mp3Match = await findDownload(session.mp3FileName);
    if (mp3Match) {
      chrome.downloads.show(mp3Match.id);
      statusEl.textContent = "Opened the MP3's folder in your file manager.";
      return;
    }
    if (Number.isInteger(session.downloadId)) {
      chrome.downloads.show(session.downloadId);
      statusEl.textContent = "Opened the recording's folder in your file manager.";
      return;
    }
    const webmMatch = await findDownload(session.fileName);
    if (webmMatch) {
      chrome.downloads.show(webmMatch.id);
      statusEl.textContent = "Opened the recording's folder in your file manager.";
      return;
    }
    chrome.downloads.showDefaultFolder();
    statusEl.textContent = "Opened your downloads folder (exact MP3 location isn't available to the browser).";
  } catch (error) {
    statusEl.textContent = `Could not open folder: ${error?.message || error}`;
  }
}

async function updateFolderStatus(handleArg) {
  if (!folderNameEl) return;
  let handle = handleArg ?? null;
  if (!handle) {
    try { handle = await getRecordingsDirectoryHandle(); } catch (_) {}
  }
  if (handle) {
    folderNameEl.textContent = handle.name || "Granted";
    folderNameEl.classList.add("is-positive");
    if (pickFolderButton) pickFolderButton.textContent = "Re-pick";
  } else {
    folderNameEl.textContent = "Not granted";
    folderNameEl.classList.remove("is-positive");
    if (pickFolderButton) pickFolderButton.textContent = "Pick Folder";
  }
}

let enrichmentRunning = false;

async function enrichDurationsInBackground() {
  if (enrichmentRunning) return;
  enrichmentRunning = true;
  try {
    const handle = await getRecordingsDirectoryHandle();
    if (!handle) return;
    // Runtime-only cache; consulted to avoid re-probing the same file
    // multiple times within a single panel session. Cleared on Refresh
    // and rebuilt from scratch on every panel open.
    const cache = getDurationCache();
    const sessions = cachedMergedSessions;
    let updated = false;
    // Lazily acquire a writable handle so we can persist durations to disk as a
    // portable .meta.json sidecar. Best-effort: if write access isn't granted we
    // still show the duration this session via the runtime cache.
    let writeHandle = null;
    let triedWriteHandle = false;
    const getWriteHandle = async () => {
      if (triedWriteHandle) return writeHandle;
      triedWriteHandle = true;
      try { writeHandle = await getRecordingsDirectoryHandle({ mode: "readwrite" }); } catch (_) {}
      return writeHandle;
    };
    const persistMeta = async (session, ms) => {
      const wh = await getWriteHandle();
      if (!wh) return;
      try {
        await writeRecordingMeta(wh, session.fileName, {
          durationMs: ms,
          startedAt: Number(session.startedAt) || 0,
          endedAt: (Number(session.startedAt) || 0) + ms
        });
      } catch (_) {}
    };
    for (const session of sessions) {
      if (!session?.fileName) continue;
      // Already know the duration: just make sure it's mirrored to disk so other
      // browsers can read it without decoding the whole file.
      if (Number(session.durationMs) > 0) {
        if (session._fsHasMeta === false) await persistMeta(session, Math.round(Number(session.durationMs)));
        continue;
      }
      if (cache[session.fileName]) continue;
      try {
        const file = await readRecordingFile(handle, session.fileName);
        const ms = await probeAudioDuration(file);
        if (ms > 0) {
          setCachedDuration(session.fileName, ms);
          await persistMeta(session, ms);
          updated = true;
        }
      } catch (_) {
        // Skip files we can't read.
      }
    }
    if (updated) {
      await loadAndRenderSessions();
    }
  } finally {
    enrichmentRunning = false;
  }
}
