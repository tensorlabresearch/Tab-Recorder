const statusEl = document.getElementById("status");
const recordingStatusEl = document.getElementById("recording-status");
const preRecordEl = document.getElementById("pre-record");
const recordingEl = document.getElementById("recording");
const meetingLabelInput = document.getElementById("meeting-label");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const openSettingsButton = document.getElementById("open-settings-btn");
const loadingSplashEl = document.getElementById("loading-splash");

let mediaRecorder = null;
let recordedChunks = [];
let audioContext = null;
let activeTracks = [];
let currentSession = null;

init();

function init() {
  if (!meetingLabelInput.value) {
    meetingLabelInput.value = defaultTimestampLabel();
  }
  hideLoadingSplash();

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
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
  } catch (_) {
    statusEl.textContent = "Mic unavailable; recording tab audio only.";
  }

  const mixed = mixStreams(displayStream, micStream);
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

  const tabSource = audioContext.createMediaStreamSource(tabStream);
  const monitorGain = audioContext.createGain();
  monitorGain.gain.value = 1;
  tabSource.connect(monitorGain);
  monitorGain.connect(audioContext.destination);
  tabSource.connect(destination);

  if (micStream && micStream.getAudioTracks().length) {
    const micSource = audioContext.createMediaStreamSource(micStream);
    micSource.connect(destination);
  }

  return destination.stream;
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

function makeId() {
  return Math.random().toString(36).slice(2, 10) + "-" + Date.now().toString(36);
}
