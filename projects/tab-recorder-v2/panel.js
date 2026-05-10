import {
  getRecordingsDirectoryHandle,
  pickRecordingsDirectory,
  readRecordingFile,
  probeAudioDuration,
  setCachedDuration,
  getDurationCache,
  ensureWritable,
  enumerateRecordings,
  writeRecordingArtifact,
  removeRecordingArtifact,
  readArtifactText
} from "./lib/audioFs.js";
import { getSelectedModelId, getAutoTranscribePreference } from "./lib/whisperModel.js";
import { mergeSessionSources } from "./lib/sessionMerge.js";

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
const monitorToggle = document.getElementById("monitor-toggle");
const monitorToggleLive = document.getElementById("monitor-toggle-live");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const pauseButton = document.getElementById("pause-btn");
const changeTabButton = document.getElementById("change-tab-btn");
const openSettingsButton = document.getElementById("open-settings-btn");
const loadingSplashEl = document.getElementById("loading-splash");
const recordingsSectionEl = document.getElementById("recordings-section");
const recordingsListEl = document.getElementById("recordings-list");
const refreshRecordingsButton = document.getElementById("refresh-recordings-btn");
const folderNameEl = document.getElementById("folder-name");
const pickFolderButton = document.getElementById("pick-folder-btn");

const MIC_DEVICE_ID_KEY = "selectedMicDeviceId";
const MONITOR_KEY = "monitorTabAudio";
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
let monitorEnabled = true;
let changeInProgress = false;
let cachedMicDevices = [];
let pauseStartedAt = null;
let totalPausedMs = 0;

let graph = freshGraph();

function freshGraph() {
  return {
    context: null,
    recordDestination: null,
    monitorGain: null,
    tab: emptyNodeGroup(),
    mic: emptyNodeGroup()
  };
}

function emptyNodeGroup() {
  return { stream: null, source: null, gain: null, analyser: null, endedHandler: null };
}

init();

async function init() {
  if (!meetingLabelInput.value) {
    meetingLabelInput.value = defaultTimestampLabel();
  }

  const stored = await chrome.storage.local.get([MIC_DEVICE_ID_KEY, MONITOR_KEY]).catch(() => ({}));
  monitorEnabled = stored?.[MONITOR_KEY] !== false;
  monitorToggle.checked = monitorEnabled;
  monitorToggleLive.checked = monitorEnabled;

  await populateMicSelectors(stored?.[MIC_DEVICE_ID_KEY]);
  hideLoadingSplash();

  micSelect.addEventListener("change", () => onMicSelectChange(micSelect.value));
  micSelectLive.addEventListener("change", () => onMicSelectChange(micSelectLive.value));
  monitorToggle.addEventListener("change", () => onMonitorToggle(monitorToggle.checked));
  monitorToggleLive.addEventListener("change", () => onMonitorToggle(monitorToggleLive.checked));

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
  openSettingsButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  navigator.mediaDevices.addEventListener("devicechange", () => {
    refreshMicSelectors().catch(() => {});
  });

  refreshRecordingsButton?.addEventListener("click", () => {
    loadAndRenderSessions().catch(() => {});
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
    if (area === "local" && (changes.v2Sessions || changes.v2DurationCache)) {
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

function onMonitorToggle(enabled) {
  monitorEnabled = enabled;
  if (monitorToggle.checked !== enabled) monitorToggle.checked = enabled;
  if (monitorToggleLive.checked !== enabled) monitorToggleLive.checked = enabled;
  chrome.storage.local.set({ [MONITOR_KEY]: enabled }).catch(() => {});
  applyMonitorSetting();
}

function applyMonitorSetting() {
  if (!graph.monitorGain || !graph.context) return;
  const target = monitorEnabled ? 1.0 : 0.0;
  rampGain(graph.monitorGain, target, FADE_SECONDS);
}

async function onStartRecording() {
  if (mediaRecorder) return;
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
  // Echo cancellation matters when tab audio is monitored through speakers
  // (the mic would otherwise re-capture it). Noise suppression also helps.
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
  graph.monitorGain = graph.context.createGain();
  graph.monitorGain.gain.value = monitorEnabled ? 1.0 : 0.0;
  graph.monitorGain.connect(graph.context.destination);
}

function attachTabStream(stream) {
  const ctx = graph.context;
  const source = ctx.createMediaStreamSource(stream);
  const gain = ctx.createGain();
  gain.gain.value = 0;
  source.connect(gain);
  gain.connect(graph.recordDestination);
  gain.connect(graph.monitorGain);

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
  meetingLabelInput.value = defaultTimestampLabel();
  elapsedEl.textContent = "00:00";
  tabLevelEl.style.width = "0%";
  micLevelEl.style.width = "0%";
  micLevelEl.parentElement.parentElement.style.opacity = "1";
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

  cachedMergedSessions = mergeSessionSources(stored, downloadOrphans, fsFiles);

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

  const top = document.createElement("div");
  top.className = "recording-item-top";

  const title = document.createElement("div");
  title.className = "recording-item-title";
  title.textContent = session.meetingLabel || session.tabTitle || "Untitled";
  top.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "recording-item-meta";
  const metaParts = [];
  const dateLabel = formatSessionDate(session.startedAt);
  if (dateLabel) metaParts.push(dateLabel);
  if (Number(session.durationMs) > 0) metaParts.push(formatDurationHuman(session.durationMs));
  if (session.transcriptText || session._fsTxtPath) metaParts.push("transcribed");
  if (session.mp3FileName) metaParts.push("MP3 saved");
  metaParts.forEach((part, idx) => {
    if (idx > 0) meta.appendChild(makeDot());
    meta.appendChild(textNode(part));
  });
  top.appendChild(meta);

  row.appendChild(top);

  const actions = document.createElement("div");
  actions.className = "recording-item-actions";

  const hasTranscript = !!(session.transcriptText || session._fsTxtPath);
  if (!hasTranscript) {
    const transcribeBtn = document.createElement("button");
    transcribeBtn.type = "button";
    transcribeBtn.className = "row-action";
    transcribeBtn.dataset.action = "transcribe";
    transcribeBtn.textContent = "Transcribe";
    actions.appendChild(transcribeBtn);
  }

  if (!session.mp3FileName) {
    const mp3Btn = document.createElement("button");
    mp3Btn.type = "button";
    mp3Btn.className = "row-action";
    mp3Btn.dataset.action = "convert-mp3";
    mp3Btn.textContent = "Convert to MP3";
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

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "row-action is-danger";
  deleteBtn.dataset.action = "delete";
  deleteBtn.textContent = "Delete";
  actions.appendChild(deleteBtn);

  row.appendChild(actions);

  const progress = document.createElement("div");
  progress.className = "recording-item-progress hidden";
  progress.dataset.role = "progress";
  const labelRow = document.createElement("div");
  labelRow.className = "progress-label";
  const labelText = document.createElement("span");
  labelText.dataset.role = "progress-label";
  labelText.textContent = "Working";
  const percentText = document.createElement("span");
  percentText.className = "progress-percent";
  percentText.dataset.role = "progress-percent";
  percentText.textContent = "0%";
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

function setRowProgress(row, { label, fraction, visible } = {}) {
  if (!row) return;
  const progress = row.querySelector('[data-role="progress"]');
  if (!progress) return;
  if (visible === false) {
    progress.classList.add("hidden");
    return;
  }
  progress.classList.remove("hidden");
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
          await removeRecordingArtifact(handle, session.fileName, { extensions: ["webm", "mp3", "txt"] });
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
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
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
  setCachedDuration(session.fileName, durationMs).catch(() => {});

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

  setRowProgress(row, { label: "Reading", fraction: 0 });
  clearTranscriptPreview(row);

  let file;
  try {
    file = await readRecordingFile(handle, session.fileName);
  } catch (error) {
    statusEl.textContent = `Could not open file: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Decoding", fraction: 0.1 });
  let pcm16k;
  let durationMs;
  try {
    const audioCtx = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    audioCtx.close();
    durationMs = Math.round(audioBuffer.duration * 1000);
    setCachedDuration(session.fileName, durationMs).catch(() => {});
    pcm16k = await resampleToMono16k(audioBuffer);
  } catch (error) {
    statusEl.textContent = `Decode failed: ${error?.message || error}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Loading model", fraction: 0.2 });
  const totalMs = Math.max(1, Number(durationMs) || 1);
  const modelId = await getSelectedModelId();

  let result;
  try {
    result = await runWhisperWorker(pcm16k, {
      modelId,
      onStage: (stage) => setRowProgress(row, { label: stage }),
      onDownloadProgress: ({ progress }) => {
        // Map model download progress onto 20-30% so we leave room for transcribe.
        const fraction = 0.2 + (Number(progress) || 0) / 100 * 0.1;
        setRowProgress(row, { label: "Loading model", fraction });
      },
      onEngine: (device) => {
        setRowProgress(row, {
          label: device === "webgpu" ? "Transcribing (WebGPU)" : "Transcribing (CPU)",
          fraction: 0.3
        });
      },
      onSegment: (segment) => {
        appendTranscriptSegment(row, segment);
        const segEnd = Number(segment.end != null ? segment.end : segment.start);
        const segFraction = Math.min(1, Math.max(0, segEnd / totalMs));
        setRowProgress(row, { fraction: 0.3 + segFraction * 0.65 });
      }
    });
  } catch (error) {
    const msg = String(error?.message || error);
    console.error("[panel] transcription failed", error);
    statusEl.textContent = `Transcription failed: ${msg}`;
    restore();
    return;
  }

  setRowProgress(row, { label: "Saving", fraction: 0.95 });
  // Write transcript next to the webm so the file lives in the same folder.
  if (result.text) {
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

  setRowProgress(row, { label: "Done", fraction: 1 });
  statusEl.textContent = "Transcript saved.";
  await loadAndRenderSessions();
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
    const cache = await getDurationCache();
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "get-sessions" });
    } catch (_) {
      return;
    }
    if (!response?.ok) return;
    const sessions = response.sessions || [];
    let updated = false;
    for (const session of sessions) {
      if (!session?.fileName) continue;
      if (Number(session.durationMs) > 0) continue;
      if (cache[session.fileName]) continue;
      try {
        const file = await readRecordingFile(handle, session.fileName);
        const ms = await probeAudioDuration(file);
        if (ms > 0) {
          await setCachedDuration(session.fileName, ms);
          cache[session.fileName] = ms;
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
