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
  BROWSER_AI
} from "./lib/browserAi.js";
import { serializeSummary } from "./lib/summaryFile.js";

const statusEl = document.getElementById("status");
const recordingStatusEl = document.getElementById("recording-status");
const elapsedEl = document.getElementById("elapsed");
const tabLevelEl = document.getElementById("tab-level");
const micLevelEl = document.getElementById("mic-level");
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
const folderNameEl = document.getElementById("folder-name");
const pickFolderButton = document.getElementById("pick-folder-btn");

const micMuteBtn = document.getElementById("mic-mute-btn");
const tabMuteBtn = document.getElementById("tab-mute-btn");

const MIC_DEVICE_ID_KEY = "selectedMicDeviceId";
const NO_MIC_VALUE = "__none__";

const MIC_GAIN = 2.0;
const TAB_GAIN = 0.8;
const FADE_SECONDS = 0.05;

let mediaRecorder = null;
let recordedChunks = [];
let currentSession = null;
let elapsedTimerId = null;
let levelRafId = null;
let analyserBuffer = null;
let changeInProgress = false;
let cachedMicDevices = [];
let pauseStartedAt = null;
let totalPausedMs = 0;
let labelTimerId = null;
let lastAutoLabel = "";

let tabMuted = false;
let micMuted = false;

let graph = freshGraph();

function freshGraph() {
  return {
    context: null,
    recordDestination: null,
    tab: emptyNodeGroup(),
    mic: emptyNodeGroup()
  };
}

function emptyNodeGroup() {
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
    filterInput.addEventListener("input", () => {
      recordingsFilter = filterInput.value.trim().toLowerCase();
      applyRecordingsFilter();
    });
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

  tabMuteBtn?.addEventListener("click", () => {
    toggleTabMute();
  });
  micMuteBtn?.addEventListener("click", () => {
    toggleMicMute();
  });

  openSettingsButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });
  const openSupportLink = document.getElementById("open-support-link");
  openSupportLink?.addEventListener("click", async (e) => {
    e.preventDefault();
    await chrome.tabs.create({ url: chrome.runtime.getURL("support.html") });
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
  document.getElementById("open-support-link")?.addEventListener("click", (event) => {
    event.preventDefault();
    window.location.href = "support.html";
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

function pickInitialMicId(savedId, mics) {
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
      const { downloadId } = await saveBlob(blob, finishedSession);
      await persistSessionRecord(finishedSession, downloadId, mimeType);
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
  // Echo cancellation + noise suppression cleans up room reverb and any
  // ambient noise picked up by the mic.
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
  // Note: tab + mic audio are routed only into recordDestination, never to
  // graph.context.destination. Nothing plays back through the user's
  // speakers while recording.
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
  micLevelEl.parentElement.parentElement.style.opacity = has ? "1" : "0.4";
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
  // Account for any active pause so durationMs is correct.
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
  micLevelEl.parentElement.parentElement.style.opacity = "1";
}

function startLabelTimer() {
  stopLabelTimer();
  labelTimerId = setInterval(() => {
    const nowStr = defaultTimestampLabel();
    const currentVal = String(meetingLabelInput.value || "").trim();
    // Only overwrite if the field still shows the last auto-generated label
    // (i.e. the user hasn't typed anything custom).
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
  const blobUrl = URL.createObjectURL(blob);
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: `Tab Recorder/${session.fileName}`,
      saveAs: false
    });
    return { downloadId };
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
  }
}

async function persistSessionRecord(session, downloadId, mimeType) {
  const endedAt = Date.now();
  // Subtract paused time so duration reflects actual recorded media length,
  // not wall-clock time.
  const pausedDuringActive = pauseStartedAt != null ? endedAt - pauseStartedAt : 0;
  const durationMs = Math.max(0, endedAt - session.startedAt - totalPausedMs - pausedDuringActive);
  const payload = {
    id: session.id,
    meetingLabel: session.meetingLabel,
    tabTitle: session.meetingLabel,
    startedAt: session.startedAt,
    endedAt,
    durationMs,
    fileName: `Tab Recorder/${session.fileName}`,
    downloadId: Number.isInteger(downloadId) ? downloadId : null,
    audioFormat: "webm",
    audioMimeType: mimeType
  };
  try {
    await chrome.runtime.sendMessage({ type: "save-session", session: payload });
  } catch (_) {
    // Service worker unavailable; the file is still on disk and will be ignored by the list.
  }
}

function buildFileName(label) {
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

function defaultTimestampLabel() {
  const now = new Date();
  const date = now.toISOString().split("T")[0];
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${date} ${hh}:${mm}`;
}

function formatElapsed(ms) {
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
let operationsInFlight = 0;
let deferredReload = false;

function startOperation(fileName) {
  if (fileName) inProgressFileNames.add(fileName);
  operationsInFlight += 1;
}

function endOperation(fileName) {
  if (fileName) inProgressFileNames.delete(fileName);
  operationsInFlight = Math.max(0, operationsInFlight - 1);
  if (operationsInFlight === 0 && deferredReload) {
    deferredReload = false;
    loadAndRenderSessions().catch(() => {});
  }
}

function formatWorkerErrorEvent(event) {
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

  recordingsListEl.innerHTML = "";
  for (const session of cachedMergedSessions) {
    recordingsListEl.appendChild(renderSessionRow(session));
  }
  applyRecordingsFilter();
}

function applyRecordingsFilter() {
  if (!recordingsListEl) return;
  const q = recordingsFilter;
  const countEl = document.getElementById("recordings-filter-count");
  if (!q) {
    let total = 0;
    for (const row of recordingsListEl.querySelectorAll(".recording-item")) {
      row.classList.remove("is-filtered-out");
      total++;
    }
    if (countEl) countEl.textContent = "";
    return;
  }
  let visible = 0;
  let total = 0;
  for (const row of recordingsListEl.querySelectorAll(".recording-item")) {
    total++;
    const blob = row.dataset.searchBlob || "";
    const match = blob.includes(q);
    row.classList.toggle("is-filtered-out", !match);
    if (match) visible++;
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


function renderSessionRow(session) {
  const row = document.createElement("div");
  row.className = "recording-item";
  row.dataset.sessionId = session.id;
  row.dataset.searchBlob = [
    session.meetingLabel,
    session.tabTitle,
    session.description,
    session.transcriptText,
  ].filter(Boolean).join(" ").toLowerCase();

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

  top.appendChild(meta);

  row.appendChild(top);

  const actions = document.createElement("div");
  actions.className = "recording-item-actions";

  const isInProgress = inProgressFileNames.has(session.fileName);
  if (isInProgress) row.classList.add("is-working");

  const hasTranscript = !!(session.transcriptText || session._fsTxtPath);
  if (!hasTranscript) {
    const transcribeBtn = document.createElement("button");
    transcribeBtn.type = "button";
    transcribeBtn.className = "row-action";
    transcribeBtn.dataset.action = "transcribe";
    transcribeBtn.textContent = isInProgress ? "Working..." : "Transcribe";
    if (isInProgress) {
      transcribeBtn.disabled = true;
      transcribeBtn.title = "An operation is already running on this recording.";
    }
    actions.appendChild(transcribeBtn);
  }

  if (!session.mp3FileName) {
    const mp3Btn = document.createElement("button");
    mp3Btn.type = "button";
    mp3Btn.className = "row-action";
    mp3Btn.dataset.action = "convert-mp3";
    mp3Btn.textContent = isInProgress ? "Working..." : "Convert to MP3";
    if (isInProgress) {
      mp3Btn.disabled = true;
      mp3Btn.title = "An operation is already running on this recording.";
    }
    actions.appendChild(mp3Btn);
  }

  if (session.transcriptText || session._fsTxtPath) {
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "row-action";
    copyBtn.dataset.action = "copy-transcript";
    copyBtn.textContent = "Copy Transcript";
    actions.appendChild(copyBtn);
  }

  if (browserAiAvailable && hasTranscript) {
    const summarizeBtn = document.createElement("button");
    summarizeBtn.type = "button";
    summarizeBtn.className = "row-action";
    summarizeBtn.dataset.action = "summarize";
    summarizeBtn.textContent = isInProgress
      ? "Working..."
      : session._fsSummaryPath ? "Re-summarize" : "Summarize";
    if (isInProgress) {
      summarizeBtn.disabled = true;
      summarizeBtn.title = "An operation is already running on this recording.";
    }
    actions.appendChild(summarizeBtn);
  }

  // Diarize is opt-in (speakerDetectionEnabled) and requires Whisper segments
  // — we only show it when the user enabled speaker detection AND the segments
  // sidecar is available on disk (written by transcribeSessionImpl). Older
  // recordings without a .segments.json need to be re-transcribed first.
  if (speakerDetectionEnabled && session._fsSegmentsJsonPath) {
    const diarizeBtn = document.createElement("button");
    diarizeBtn.type = "button";
    diarizeBtn.className = "row-action";
    diarizeBtn.dataset.action = "diarize";
    diarizeBtn.textContent = isInProgress
      ? "Working..."
      : session._fsDiarizedTxtPath ? "Re-diarize" : "Diarize";
    if (isInProgress) {
      diarizeBtn.disabled = true;
      diarizeBtn.title = "An operation is already running on this recording.";
    }
    actions.appendChild(diarizeBtn);
  }

  row.appendChild(actions);

  // Trashcan in the top-right corner of the row. Same data-action="delete"
  // so the existing onRecordingsListClick handler picks it up unchanged.
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "recording-item-delete";
  deleteBtn.dataset.action = "delete";
  deleteBtn.setAttribute("aria-label", "Delete recording");
  deleteBtn.title = "Delete recording";
  deleteBtn.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
      '<path fill="currentColor" d="M9 3a1 1 0 0 0-1 1v1H4.5a1 1 0 1 0 0 2H5l1.07 12.14A2 2 0 0 0 8.06 21h7.88a2 2 0 0 0 1.99-1.86L19 7h.5a1 1 0 1 0 0-2H16V4a1 1 0 0 0-1-1H9zm1 2h4V4h-4v1zm-.5 5a.75.75 0 0 1 .75.75v7.5a.75.75 0 1 1-1.5 0v-7.5A.75.75 0 0 1 9.5 10zm5 0a.75.75 0 0 1 .75.75v7.5a.75.75 0 1 1-1.5 0v-7.5A.75.75 0 0 1 14.5 10z"/>' +
    '</svg>';
  if (isInProgress) {
    deleteBtn.disabled = true;
    deleteBtn.title = "An operation is already running on this recording.";
  }
  row.appendChild(deleteBtn);

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

  if (isInProgress) {
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

function formatStamp(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function setRowProgress(row, { label, fraction, visible, spinner } = {}) {
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
    "</svg>"
};

function makeBadge(kind, label) {
  const span = document.createElement("span");
  span.className = `recording-badge recording-badge-${kind}`;
  span.title = label;
  span.setAttribute("aria-label", label);
  span.innerHTML = BADGE_ICONS[kind] || "";
  return span;
}

function makeBadgesForSession(session) {
  const hasTranscript = !!(session.transcriptText || session._fsTxtPath);
  const hasMp3 = !!session.mp3FileName;
  if (!hasTranscript && !hasMp3) return null;
  const wrap = document.createElement("span");
  wrap.className = "recording-badges";
  if (hasTranscript) wrap.appendChild(makeBadge("transcript", "Transcript saved"));
  if (hasMp3) wrap.appendChild(makeBadge("mp3", "MP3 saved"));
  return wrap;
}

async function onRecordingsListClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const row = button.closest(".recording-item");
  const sessionId = row?.dataset.sessionId;
  if (!sessionId) return;

  const action = button.dataset.action;
  if (action === "delete") {
    if (!confirm("Delete this recording? The audio file (and any MP3/transcript next to it) will be removed.")) return;
    button.disabled = true;
    const session = await findSession(sessionId);
    try {
      try {
        const handle = await getRecordingsDirectoryHandle({ mode: "readwrite" });
        if (handle && session?.fileName) {
          await removeRecordingArtifact(handle, session.fileName, { extensions: ["webm", "mp3", "txt", "summary.md"] });
        }
      } catch (_) {}
      await chrome.runtime.sendMessage({ type: "delete-session", sessionId });
      await loadAndRenderSessions();
    } catch (error) {
      statusEl.textContent = `Delete failed: ${error?.message || error}`;
      button.disabled = false;
    }
    return;
  }

  if (action === "copy-transcript") {
    const session = await findSession(sessionId);
    let text = session?.transcriptText || "";
    if (!text && session?._fsTxtPath) {
      try {
        const handle = await getRecordingsDirectoryHandle();
        if (handle) text = (await readArtifactText(handle, session._fsTxtPath)) || "";
      } catch (_) {}
    }
    if (!text) {
      statusEl.textContent = "No transcript on this recording yet.";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      statusEl.textContent = "Transcript copied to clipboard.";
    } catch (error) {
      statusEl.textContent = `Copy failed: ${error?.message || error}`;
    }
    return;
  }

  if (action === "convert-mp3") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    await convertSessionToMp3(session, button);
    return;
  }

  if (action === "transcribe") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    await transcribeSession(session, button);
    return;
  }

  if (action === "summarize") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    await summarizeSession(session, button);
    return;
  }

  if (action === "diarize") {
    const session = await findSession(sessionId);
    if (!session) {
      statusEl.textContent = "Recording not found.";
      return;
    }
    await diarizeSession(session, button);
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

async function summarizeSession(session, button) {
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

  const row = button.closest(".recording-item");
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
    const { description, summary } = await summarizeAndDescribe(transcript);
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
    await loadAndRenderSessions();
  } catch (error) {
    statusEl.textContent = `Summarize failed: ${error?.message || error}`;
    if (row) setRowProgress(row, { visible: false });
    if (button) {
      button.disabled = false;
      button.textContent = session._fsSummaryPath ? "Re-summarize" : "Summarize";
    }
  } finally {
    endOperation(session.fileName);
  }
}

async function diarizeSession(session, button) {
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

  const row = button?.closest(".recording-item");
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
    await loadAndRenderSessions();
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

function formatSessionDate(ts) {
  if (!ts) return "";
  const date = new Date(Number(ts));
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

function formatDurationHuman(ms) {
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

async function convertSessionToMp3(session, button) {
  startOperation(session?.fileName);
  try {
    await convertSessionToMp3Impl(session, button);
  } finally {
    endOperation(session?.fileName);
  }
}

async function convertSessionToMp3Impl(session, button) {
  const row = button.closest(".recording-item");

  let handle;
  try {
    handle = await ensureRecordingsHandle({ writable: true });
  } catch (error) {
    statusEl.textContent = `Folder access not granted: ${error?.message || error}`;
    return;
  }

  const originalLabel = button.textContent;
  const restore = () => {
    button.disabled = false;
    button.textContent = originalLabel;
    setRowProgress(row, { visible: false });
  };

  button.disabled = true;
  button.textContent = "Working...";
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
  await loadAndRenderSessions();
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

async function transcribeSession(session, button) {
  startOperation(session?.fileName);
  try {
    await transcribeSessionImpl(session, button);
  } finally {
    endOperation(session?.fileName);
  }
}

async function transcribeSessionImpl(session, button) {
  const row = button.closest(".recording-item");

  let handle;
  try {
    handle = await ensureRecordingsHandle({ writable: true });
  } catch (error) {
    statusEl.textContent = `Folder access not granted: ${error?.message || error}`;
    return;
  }

  const originalLabel = button.textContent;
  const restore = () => {
    button.disabled = false;
    button.textContent = originalLabel;
    setRowProgress(row, { visible: false });
    clearTranscriptPreview(row);
  };

  button.disabled = true;
  button.textContent = "Working...";
  statusEl.textContent = "";

  // Transcription has no truthful percentage — switch the row's progress
  // element into spinner mode for the entire whisper run.
  setRowProgress(row, { label: "Reading audio file", spinner: true });
  clearTranscriptPreview(row);

  let file;
  try {
    file = await readRecordingFile(handle, session.fileName);
  } catch (error) {
    statusEl.textContent = `Could not open file: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Decoding audio" });
  let pcm16k;
  let durationMs;
  try {
    const audioCtx = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();
    durationMs = Math.round(audioBuffer.duration * 1000);
    setCachedDuration(session.fileName, durationMs);
    pcm16k = await resampleToMono16k(audioBuffer);
  } catch (error) {
    statusEl.textContent = `Decode failed: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Loading transcription model" });
  const modelId = await getSelectedModelId();

  let result;
  try {
    result = await runWhisperWorker(pcm16k, {
      modelId,
      onStage: (stage) => setRowProgress(row, { label: stage }),
      onDownloadProgress: ({ file: fileName, loaded, total, progress }) => {
        const pct = Number(progress) || (total ? Math.round((loaded / total) * 100) : 0);
        const label = fileName
          ? `Downloading ${fileName} (${pct}%)`
          : `Downloading model (${pct}%)`;
        setRowProgress(row, { label });
      },
      onEngine: (device) => {
        setRowProgress(row, {
          label: device === "webgpu" ? "Transcribing on WebGPU" : "Transcribing on CPU"
        });
      },
      onSegment: (segment) => {
        appendTranscriptSegment(row, segment);
      }
    });
  } catch (error) {
    const msg = String(error?.message || error);
    console.error("[panel] transcription failed", error);
    statusEl.textContent = `Transcription failed: ${msg}`;
    restore();
    return;
  }

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

  await loadAndRenderSessions();
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
    const { description, summary } = await summarizeAndDescribe(transcriptText);
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
  const targetRate = 16000;
  const numFrames = Math.ceil(audioBuffer.duration * targetRate);
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

  source.start(0);
  const rendered = await offline.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

function runWhisperWorker(pcm16k, { modelId, onSegment, onStage, onEngine, onDownloadProgress } = {}) {
  return new Promise((resolve, reject) => {
    const workerUrl = chrome.runtime.getURL("lib/whisperWorker.js");
    const worker = new Worker(workerUrl, { type: "module" });
    const jobId = Math.random().toString(36).slice(2, 10);

    worker.onmessage = (event) => {
      const data = event.data;
      if (!data || data.jobId !== jobId) return;
      if (data.type === "stage") {
        try { onStage?.(data.stage); } catch (_) {}
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
          try { onSegment?.(data.segment); } catch (_) {}
        }
        return;
      }
      if (data.type === "done") {
        worker.terminate();
        resolve({
          text: data.text || "",
          segments: data.segments || [],
          device: data.device || null
        });
        return;
      }
      if (data.type === "error") {
        worker.terminate();
        reject(new Error(data.error || "Transcription failed"));
      }
    };
    worker.onerror = (event) => {
      const detail = formatWorkerErrorEvent(event);
      console.error("[panel] whisper worker errored", event);
      worker.terminate();
      reject(new Error(detail || "Worker error (no details from runtime)"));
    };
    worker.onmessageerror = (event) => {
      console.error("[panel] whisper worker message error", event);
      worker.terminate();
      reject(new Error("Worker message error (postMessage cloning failed)"));
    };

    const pcmBuffer = pcm16k.buffer;
    worker.postMessage(
      {
        type: "transcribe",
        jobId,
        modelId: modelId || "Xenova/whisper-small.en",
        pcm: new Float32Array(pcmBuffer),
        language: "english"
      },
      [pcmBuffer]
    );
  });
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
    for (const session of sessions) {
      if (!session?.fileName) continue;
      if (Number(session.durationMs) > 0) continue;
      if (cache[session.fileName]) continue;
      try {
        const file = await readRecordingFile(handle, session.fileName);
        const ms = await probeAudioDuration(file);
        if (ms > 0) {
          setCachedDuration(session.fileName, ms);
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
