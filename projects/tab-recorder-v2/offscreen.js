import { computeRms, formatTimestamp, sanitizeName, formatNoteTime, buildNotesContent } from './lib/utils.js';

let mediaRecorder = null;
let currentStream = null;
let currentTabStream = null;
let currentMicStream = null;
let currentAudioContext = null;
let recordedChunks = [];
let currentSessionId = null;
let currentMimeType = "audio/webm";
let currentSessionMeta = null;
let currentChunkIndex = 0;
let chunkWriteQueue = Promise.resolve();

const CHUNK_CACHE_DB_NAME = "tabRecorderV2Cache";
const CHUNK_CACHE_DB_VERSION = 1;
const CHUNK_STORE_NAME = "audioChunks";
const MAX_RECOVERY_ATTEMPTS = 4;
const RECOVERY_BASE_DELAY_MS = 800;
const SILENCE_CHECK_INTERVAL_MS = 2000;
const SILENCE_RECOVERY_THRESHOLD_MS = 12000;
const SILENCE_RMS_THRESHOLD = 0.004;

let currentStreamId = null;
let currentIncludeMic = true;
let suppressUploadOnStop = false;
let suppressStopResolver = null;
let recoveryInProgress = false;
let recoveryAttempts = 0;
let currentTabTrack = null;
let tabMuteTimeout = null;
let silenceIntervalId = null;
let silenceAnalyser = null;
let silenceData = null;
let silenceSourceNode = null;
let silentForMs = 0;

const AUDIO_OPTIONAL_CONSTRAINTS = [
  { echoCancellation: false },
  { noiseSuppression: false },
  { autoGainControl: false },
  { channelCount: 2 },
  { sampleRate: 48000 }
];

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "offscreen-start") {
    startRecording(
      message.payload?.streamId,
      message.payload?.sessionId,
      Boolean(message.payload?.includeMic),
      message.payload?.sourceType || "tab"
    );
  }

  if (message.type === "offscreen-pick-and-start") {
    pickAndStart(
      message.payload?.sessionId,
      Boolean(message.payload?.includeMic)
    );
  }

  if (message.type === "offscreen-stop") {
    stopRecording(message.payload?.session || null);
  }
});

let currentSourceType = "tab";

async function pickAndStart(sessionId, includeMic) {
  let streamId;
  try {
    streamId = await new Promise((resolve, reject) => {
      chrome.desktopCapture.chooseDesktopMedia(["tab", "audio"], (id) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
        else resolve(id || null);
      });
    });
  } catch (error) {
    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: { event: "recording-error", error: String(error), sessionId }
    });
    return;
  }
  if (!streamId) {
    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: { event: "recording-canceled", sessionId }
    });
    return;
  }
  await startRecording(streamId, sessionId, includeMic, "desktop");
}

async function startRecording(streamId, sessionId, includeMic, sourceType) {
  if (!streamId) return;

  if (mediaRecorder) {
    await stopRecording();
  }

  currentSessionId = sessionId || null;
  currentSessionMeta = null;
  currentStreamId = streamId;
  currentIncludeMic = includeMic;
  currentSourceType = sourceType || "tab";
  recordedChunks = [];
  currentChunkIndex = 0;
  chunkWriteQueue = Promise.resolve();
  recoveryInProgress = false;
  recoveryAttempts = 0;
  await clearCachedChunks(currentSessionId).catch(() => {});

  try {
    await setupCapture(streamId, includeMic, currentSourceType);
    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: { event: "recording-started", data: { sessionId } }
    });
  } catch (error) {
    stopTracks();
    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: { event: "recording-error", error: String(error), sessionId }
    });
  }
}

async function stopRecording(sessionMeta) {
  if (!mediaRecorder) return;
  currentSessionMeta = sessionMeta || null;
  recoveryInProgress = false;
  if (mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
}

async function setupCapture(streamId, includeMic, sourceType) {
  const isDesktop = sourceType === "desktop";
  const mediaSource = isDesktop ? "desktop" : "tab";
  // Desktop capture often requires video constraints too — request it but discard the track
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: mediaSource,
        chromeMediaSourceId: streamId
      },
      optional: AUDIO_OPTIONAL_CONSTRAINTS
    },
    video: isDesktop
      ? { mandatory: { chromeMediaSource: mediaSource, chromeMediaSourceId: streamId } }
      : false
  };
  const tabStream = await navigator.mediaDevices.getUserMedia(constraints);

  if (!tabStream.getAudioTracks().length) {
    throw new Error("No audio track in shared tab. Make sure 'Share tab audio' is checked in the picker.");
  }
  // Drop video tracks immediately to free resources
  for (const videoTrack of tabStream.getVideoTracks()) {
    videoTrack.stop();
    tabStream.removeTrack(videoTrack);
  }
  currentTabStream = tabStream;
  currentMicStream = includeMic ? await getMicStreamSafe() : null;
  currentStream = await buildMixedAudioStream(tabStream, currentMicStream);
  const mimeType = pickMimeType();
  currentMimeType = mimeType || "audio/webm";
  mediaRecorder = new MediaRecorder(currentStream, {
    mimeType: currentMimeType,
    audioBitsPerSecond: 128000
  });
  attachTrackHealthMonitors(tabStream);
  startSilenceWatch(tabStream);

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
      const chunkIndex = currentChunkIndex;
      currentChunkIndex += 1;
      chunkWriteQueue = chunkWriteQueue
        .then(() => cacheChunk(currentSessionId, chunkIndex, event.data, currentMimeType))
        .catch(() => {});
    }
  };

  mediaRecorder.onstop = async () => {
    if (suppressUploadOnStop) {
      suppressUploadOnStop = false;
      stopTracks();
      if (typeof suppressStopResolver === "function") {
        suppressStopResolver();
      }
      suppressStopResolver = null;
      return;
    }

    const sessionIdSnapshot = currentSessionId;
    const sessionMetaSnapshot = currentSessionMeta;
    await chunkWriteQueue.catch(() => {});
    const cachedChunks = await loadCachedChunks(sessionIdSnapshot).catch(() => []);
    const chunksForUpload = cachedChunks.length ? cachedChunks : recordedChunks;
    if (!chunksForUpload.length) {
      chrome.runtime.sendMessage({
        type: "offscreen-status",
        payload: {
          event: "upload-error",
          error: "Recording failed: no audio chunks were captured.",
          sessionId: sessionIdSnapshot
        }
      });
      recordedChunks = [];
      currentSessionMeta = null;
      stopTracks();
      return;
    }
    const blob = new Blob(chunksForUpload, { type: currentMimeType });
    recordedChunks = [];
    currentSessionMeta = null;
    stopTracks();

    let driveData = null;
    let driveError = null;
    try {
      const fileInfo = await uploadToDrive(blob, currentMimeType, sessionMetaSnapshot);
      driveData = { ...fileInfo, sizeBytes: blob.size, mimeType: currentMimeType, sessionId: sessionIdSnapshot };
    } catch (error) {
      driveError = String(error);
    }
    await clearCachedChunks(sessionIdSnapshot).catch(() => {});
    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: {
        event: "upload-complete",
        data: driveData,
        driveError,
        audioBlob: blob,
        sessionId: sessionIdSnapshot
      }
    });
  };

  mediaRecorder.start(1000);
}

function openChunkCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CHUNK_CACHE_DB_NAME, CHUNK_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE_NAME)) {
        const store = db.createObjectStore(CHUNK_STORE_NAME, {
          keyPath: ["sessionId", "index"]
        });
        store.createIndex("bySessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Chunk cache DB open failed"));
  });
}

async function cacheChunk(sessionId, index, blob, mimeType) {
  const sid = String(sessionId || "").trim();
  if (!sid) return;
  const db = await openChunkCacheDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE_NAME, "readwrite");
    tx.objectStore(CHUNK_STORE_NAME).put({
      sessionId: sid,
      index,
      blob,
      mimeType: mimeType || "audio/webm",
      createdAt: Date.now()
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Chunk cache write failed"));
  });
  db.close();
}

async function loadCachedChunks(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return [];
  const db = await openChunkCacheDb();
  const chunks = await new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE_NAME, "readonly");
    const store = tx.objectStore(CHUNK_STORE_NAME);
    const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
    const request = store.getAll(range);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : []);
    request.onerror = () => reject(request.error || new Error("Chunk cache read failed"));
  });
  db.close();
  return chunks
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0))
    .map((item) => item.blob)
    .filter(Boolean);
}

async function clearCachedChunks(sessionId) {
  const sid = String(sessionId || "").trim();
  if (!sid) return;
  const db = await openChunkCacheDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(CHUNK_STORE_NAME, "readwrite");
    const store = tx.objectStore(CHUNK_STORE_NAME);
    const range = IDBKeyRange.bound([sid, 0], [sid, Number.MAX_SAFE_INTEGER]);
    const cursorReq = store.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error("Chunk cache clear failed"));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Chunk cache clear failed"));
  });
  db.close();
}

function stopTracks() {
  stopSilenceWatch();
  clearTimeout(tabMuteTimeout);
  tabMuteTimeout = null;
  currentTabTrack = null;
  if (currentStream) {
    for (const track of currentStream.getTracks()) {
      track.stop();
    }
    currentStream = null;
  }
  if (currentTabStream) {
    for (const track of currentTabStream.getTracks()) {
      track.stop();
    }
    currentTabStream = null;
  }
  if (currentMicStream) {
    for (const track of currentMicStream.getTracks()) {
      track.stop();
    }
    currentMicStream = null;
  }
  if (currentAudioContext) {
    currentAudioContext.close().catch(() => {});
    currentAudioContext = null;
  }
}

function attachTrackHealthMonitors(tabStream) {
  const [track] = tabStream.getAudioTracks();
  currentTabTrack = track || null;
  if (!track) return;
  track.onended = () => triggerRecovery("Audio track ended");
  track.onmute = () => {
    clearTimeout(tabMuteTimeout);
    tabMuteTimeout = setTimeout(() => {
      if (track.muted) {
        triggerRecovery("Audio track remained muted");
      }
    }, 5000);
  };
  track.onunmute = () => {
    clearTimeout(tabMuteTimeout);
    tabMuteTimeout = null;
  };
  tabStream.oninactive = () => triggerRecovery("Captured tab stream became inactive");
}

function startSilenceWatch(tabStream) {
  stopSilenceWatch();
  if (!currentAudioContext) return;
  const track = tabStream.getAudioTracks()[0];
  if (!track) return;
  silenceSourceNode = currentAudioContext.createMediaStreamSource(new MediaStream([track]));
  silenceAnalyser = currentAudioContext.createAnalyser();
  silenceAnalyser.fftSize = 2048;
  silenceData = new Uint8Array(silenceAnalyser.fftSize);
  silenceSourceNode.connect(silenceAnalyser);
  silentForMs = 0;
  silenceIntervalId = setInterval(() => {
    if (!mediaRecorder || mediaRecorder.state !== "recording" || recoveryInProgress) return;
    silenceAnalyser.getByteTimeDomainData(silenceData);
    const rms = computeRms(silenceData);
    if (rms < SILENCE_RMS_THRESHOLD) {
      silentForMs += SILENCE_CHECK_INTERVAL_MS;
      if (silentForMs >= SILENCE_RECOVERY_THRESHOLD_MS) {
        triggerRecovery("No tab audio signal detected");
      }
    } else {
      silentForMs = 0;
    }
  }, SILENCE_CHECK_INTERVAL_MS);
}

function stopSilenceWatch() {
  if (silenceIntervalId) {
    clearInterval(silenceIntervalId);
    silenceIntervalId = null;
  }
  silenceAnalyser = null;
  silenceData = null;
  silenceSourceNode = null;
  silentForMs = 0;
}

async function triggerRecovery(reason) {
  if (recoveryInProgress || !currentStreamId) return;
  recoveryInProgress = true;
  let lastError = String(reason || "Audio capture interrupted");
  while (recoveryAttempts < MAX_RECOVERY_ATTEMPTS) {
    recoveryAttempts += 1;
    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: {
        event: "capture-warning",
        error: `${lastError}. Recovery ${recoveryAttempts}/${MAX_RECOVERY_ATTEMPTS}...`,
        sessionId: currentSessionId
      }
    });
    await stopRecorderForRecovery();
    await delay(RECOVERY_BASE_DELAY_MS * recoveryAttempts);
    try {
      await setupCapture(currentStreamId, currentIncludeMic);
      recoveryAttempts = 0;
      recoveryInProgress = false;
      chrome.runtime.sendMessage({
        type: "offscreen-status",
        payload: {
          event: "capture-recovered",
          sessionId: currentSessionId
        }
      });
      return;
    } catch (error) {
      lastError = String(error);
    }
  }
  recoveryInProgress = false;
  chrome.runtime.sendMessage({
    type: "offscreen-status",
    payload: {
      event: "recording-error",
      error: `Audio capture failed: ${lastError}. Recovery attempts exhausted.`,
      sessionId: currentSessionId
    }
  });
}

async function stopRecorderForRecovery() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    suppressUploadOnStop = true;
    await new Promise((resolve) => {
      suppressStopResolver = resolve;
      mediaRecorder.stop();
      mediaRecorder = null;
      setTimeout(resolve, 3000);
    });
    suppressStopResolver = null;
    return;
  }
  stopTracks();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function getMicStreamSafe() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    return stream.getAudioTracks().length ? stream : null;
  } catch (_error) {
    return null;
  }
}

async function buildMixedAudioStream(tabStream, micStream) {
  const context = new AudioContext();
  const destination = context.createMediaStreamDestination();
  currentAudioContext = context;

  const tabSource = context.createMediaStreamSource(new MediaStream(tabStream.getAudioTracks()));
  const monitorGain = context.createGain();
  monitorGain.gain.value = 1;
  // Keep tab audio audible to the user while recording.
  tabSource.connect(monitorGain);
  monitorGain.connect(context.destination);
  tabSource.connect(destination);

  if (micStream && micStream.getAudioTracks().length) {
    const micSource = context.createMediaStreamSource(new MediaStream(micStream.getAudioTracks()));
    micSource.connect(destination);
  }

  return new MediaStream(destination.stream.getAudioTracks());
}

async function uploadToDrive(blob, mimeType, sessionMeta) {
  const token = await getAuthToken();
  const driveFolderId = await getDriveFolderId();
  const sessionName = sanitizeName(
    sessionMeta?.meetingLabel || sessionMeta?.tabTitle || `meeting-${formatTimestamp(new Date())}`
  );
  const folder = await createDriveFolder(token, sessionName, driveFolderId);
  const audioFile = await uploadFileMultipart(
    token,
    {
      name: `${sessionName}.webm`,
      mimeType: mimeType || "audio/webm",
      parents: [folder.id]
    },
    blob
  );
  const notesBlob = new Blob([buildNotesContent(sessionMeta)], {
    type: "text/markdown;charset=utf-8"
  });
  const notesFile = await uploadFileMultipart(
    token,
    {
      name: `${sessionName}-notes.md`,
      mimeType: "text/markdown",
      parents: [folder.id]
    },
    notesBlob
  );

  return {
    ...audioFile,
    folder: {
      id: folder.id,
      name: folder.name,
      webViewLink: `https://drive.google.com/drive/folders/${folder.id}`
    },
    notes: notesFile
  };
}

async function getDriveFolderId() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return "";
  try {
    const { driveFolderId } = await localStorage.get("driveFolderId");
    return String(driveFolderId || "").trim();
  } catch (_error) {
    return "";
  }
}

function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "get-auth-token" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(chrome.runtime.lastError.message);
        return;
      }
      if (!response?.ok || !response.token) {
        reject(response?.error || "Failed to get auth token");
        return;
      }
      resolve(response.token);
    });
  });
}

async function createDriveFolder(token, name, parentId) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentId) {
    metadata.parents = [parentId];
  }
  const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(metadata)
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Drive folder create failed: ${response.status} ${errorText}`);
  }
  return response.json();
}

async function uploadFileMultipart(token, metadata, blob) {
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink,mimeType",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`
      },
      body: form
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Drive upload failed: ${response.status} ${errorText}`);
  }
  return response.json();
}

