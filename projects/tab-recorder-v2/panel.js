const statusEl = document.getElementById("status");
const recordingStatusEl = document.getElementById("recording-status");
const elapsedEl = document.getElementById("elapsed");
const tabLevelEl = document.getElementById("tab-level");
const micLevelEl = document.getElementById("mic-level");
const preRecordEl = document.getElementById("pre-record");
const recordingEl = document.getElementById("recording");
const meetingLabelInput = document.getElementById("meeting-label");
const micSelect = document.getElementById("mic-select");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const openSettingsButton = document.getElementById("open-settings-btn");
const loadingSplashEl = document.getElementById("loading-splash");

const MIC_DEVICE_ID_KEY = "selectedMicDeviceId";

const MIC_GAIN = 2.0;
const TAB_GAIN = 0.8;

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let activeTracks = [];
let currentSession = null;
let elapsedTimerId = null;
let levelRafId = null;
let tabAnalyser = null;
let micAnalyser = null;
let analyserBuffer = null;

init();

async function init() {
  if (!meetingLabelInput.value) {
    meetingLabelInput.value = defaultTimestampLabel();
  }
  await populateMicSelector();
  hideLoadingSplash();

  micSelect.addEventListener("change", () => {
    chrome.storage.local.set({ [MIC_DEVICE_ID_KEY]: micSelect.value }).catch(() => {});
  });

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
  openSettingsButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  window.addEventListener("beforeunload", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try { mediaRecorder.stop(); } catch (_) {}
    }
  });
}

function hideLoadingSplash() {
  loadingSplashEl?.classList.add("is-hidden");
}

async function populateMicSelector() {
  // enumerateDevices returns labels only after the user has granted mic permission;
  // do a no-op getUserMedia first if needed to reveal labels
  let devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const hasLabels = devices.some(d => d.kind === "audioinput" && d.label);
  if (!hasLabels) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach(t => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (_) {
      // Permission denied — leave selector empty/disabled
    }
  }
  const mics = devices.filter(d => d.kind === "audioinput");

  const stored = await chrome.storage.local.get(MIC_DEVICE_ID_KEY).catch(() => ({}));
  const savedId = stored?.[MIC_DEVICE_ID_KEY];

  micSelect.innerHTML = "";
  if (mics.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No microphones detected";
    opt.disabled = true;
    micSelect.appendChild(opt);
    return;
  }

  for (const mic of mics) {
    const opt = document.createElement("option");
    opt.value = mic.deviceId;
    opt.textContent = mic.label || `Microphone ${mic.deviceId.slice(0, 6)}`;
    micSelect.appendChild(opt);
  }

  // Pick the saved mic if still available; else prefer a non-"Default" physical mic
  if (savedId && mics.some(m => m.deviceId === savedId)) {
    micSelect.value = savedId;
  } else {
    const physical = mics.find(m =>
      m.deviceId !== "default" &&
      !/nomachine|virtual|loopback|monitor/i.test(m.label || "")
    );
    micSelect.value = physical?.deviceId || mics[0].deviceId;
    chrome.storage.local.set({ [MIC_DEVICE_ID_KEY]: micSelect.value }).catch(() => {});
  }
}

async function onStartRecording() {
  if (mediaRecorder) return;
  startButton.disabled = true;
  statusEl.textContent = "Pick the tab to record...";

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

  let micStream = null;
  const chosenMicId = micSelect.value;
  try {
    const audioConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };
    if (chosenMicId && chosenMicId !== "default") {
      audioConstraints.deviceId = { exact: chosenMicId };
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false
    });
  } catch (error) {
    statusEl.textContent = `Mic unavailable: ${error?.message || error}`;
  }

  const { mixed, tabAnalyserNode, micAnalyserNode } = mixStreams(displayStream, micStream);
  tabAnalyser = tabAnalyserNode;
  micAnalyser = micAnalyserNode;
  analyserBuffer = new Uint8Array(Math.max(tabAnalyser.fftSize, micAnalyser ? micAnalyser.fftSize : 0));

  const mimeType = pickMimeType();

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(mixed, {
    mimeType,
    audioBitsPerSecond: 128000
  });
  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) recordedChunks.push(event.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mimeType });
    recordedChunks = [];
    cleanupTracks();
    stopMeters();
    try {
      await saveBlob(blob, currentSession);
      statusEl.textContent = `Saved: ${currentSession.fileName}`;
    } catch (error) {
      statusEl.textContent = `Save failed: ${error?.message || error}`;
    }
    currentSession = null;
    mediaRecorder = null;
    resetRecordingUI();
  };
  mediaRecorder.onerror = (event) => {
    statusEl.textContent = `Recorder error: ${event.error?.message || event.error}`;
  };

  audioTracks[0].addEventListener("ended", () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      try { mediaRecorder.stop(); } catch (_) {}
    }
  });

  activeTracks = [
    ...mixed.getTracks(),
    ...displayStream.getTracks(),
    ...(micStream ? micStream.getTracks() : [])
  ];

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
  recordingStatusEl.textContent = `Recording: ${meetingLabel}`;
  if (!micStream) {
    micLevelEl.parentElement.parentElement.style.opacity = "0.4";
  }
  startElapsedTimer();
  startMeterLoop();
  startButton.disabled = false;
}

async function onStopRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  stopButton.disabled = true;
  stopButton.textContent = "Saving...";
  recordingStatusEl.textContent = "Saving recording...";
  mediaRecorder.stop();
}

function resetRecordingUI() {
  preRecordEl.classList.remove("hidden");
  recordingEl.classList.add("hidden");
  stopButton.disabled = false;
  stopButton.textContent = "Stop Recording";
  startButton.disabled = false;
  meetingLabelInput.value = defaultTimestampLabel();
  elapsedEl.textContent = "00:00";
  tabLevelEl.style.width = "0%";
  micLevelEl.style.width = "0%";
  micLevelEl.parentElement.parentElement.style.opacity = "1";
}

function startElapsedTimer() {
  const start = currentSession?.startedAt || Date.now();
  const tick = () => {
    const elapsed = Date.now() - start;
    elapsedEl.textContent = formatElapsed(elapsed);
  };
  tick();
  elapsedTimerId = setInterval(tick, 500);
}

function startMeterLoop() {
  const update = () => {
    if (!tabAnalyser) return;
    const tabLevel = readLevel(tabAnalyser);
    tabLevelEl.style.width = `${Math.round(tabLevel * 100)}%`;
    if (micAnalyser) {
      const micLevel = readLevel(micAnalyser);
      micLevelEl.style.width = `${Math.round(micLevel * 100)}%`;
    }
    levelRafId = requestAnimationFrame(update);
  };
  update();
}

function readLevel(analyser) {
  if (!analyser || !analyserBuffer) return 0;
  const buf = analyserBuffer.length >= analyser.fftSize
    ? analyserBuffer.subarray(0, analyser.fftSize)
    : new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(buf);
  let sumSquares = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128;
    sumSquares += v * v;
  }
  const rms = Math.sqrt(sumSquares / buf.length);
  // RMS for typical voice ~0.05-0.15, so scale up so meters fill on normal levels
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
  tabAnalyser = null;
  micAnalyser = null;
  analyserBuffer = null;
}

function cleanupTracks() {
  for (const track of activeTracks) {
    try { track.stop(); } catch (_) {}
  }
  activeTracks = [];
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function mixStreams(tabStream, micStream) {
  audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();

  // Tab audio: gain-adjusted, monitored to speakers, sent to recorder
  const tabSource = audioContext.createMediaStreamSource(tabStream);
  const tabGain = audioContext.createGain();
  tabGain.gain.value = TAB_GAIN;
  tabSource.connect(tabGain);
  tabGain.connect(audioContext.destination); // play to user
  tabGain.connect(destination);               // record

  const tabAnalyserNode = audioContext.createAnalyser();
  tabAnalyserNode.fftSize = 512;
  tabGain.connect(tabAnalyserNode);

  let micAnalyserNode = null;
  if (micStream && micStream.getAudioTracks().length) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    const micGain = audioContext.createGain();
    micGain.gain.value = MIC_GAIN;
    micSource.connect(micGain);
    micGain.connect(destination); // mic only goes to recorder, not speakers (no echo)

    micAnalyserNode = audioContext.createAnalyser();
    micAnalyserNode.fftSize = 512;
    micGain.connect(micAnalyserNode);
  }

  return { mixed: destination.stream, tabAnalyserNode, micAnalyserNode };
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
    await chrome.downloads.download({
      url: blobUrl,
      filename: `Tab Recorder/${session.fileName}`,
      saveAs: false
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
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
