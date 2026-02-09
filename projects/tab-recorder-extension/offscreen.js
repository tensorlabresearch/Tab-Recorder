let mediaRecorder = null;
let recordedChunks = [];
let currentStream = null;
let currentTabId = null;
let monitorEnabled = false;
let monitorAudio = null;

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "offscreen-start") {
    startRecording(message.payload?.streamId, message.payload?.tabId);
  }

  if (message.type === "offscreen-stop") {
    stopRecording(message.payload?.reason || "manual");
  }

  if (message.type === "offscreen-monitor") {
    monitorEnabled = Boolean(message.payload?.enabled);
    updateAudioMonitor();
  }
});

async function startRecording(streamId, tabId) {
  if (!streamId) return;
  if (mediaRecorder) {
    await stopRecording("restart");
  }

  currentTabId = tabId ?? null;
  recordedChunks = [];

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });

  currentStream = stream;
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    throw new Error("No tab audio track detected. Ensure the tab is playing audio and not muted.");
  }
  updateAudioMonitor();

  const mimeType = pickMimeType();
  mediaRecorder = new MediaRecorder(
    stream,
    mimeType
      ? { mimeType, audioBitsPerSecond: 128000, videoBitsPerSecond: 2500000 }
      : { audioBitsPerSecond: 128000, videoBitsPerSecond: 2500000 }
  );

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      recordedChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: "video/webm" });
    recordedChunks = [];
    stopStreamTracks();

    chrome.runtime.sendMessage({
      type: "offscreen-status",
      payload: { event: "recording-stopped" }
    });

    try {
      const fileInfo = await uploadToDrive(blob);
      chrome.runtime.sendMessage({
        type: "offscreen-status",
        payload: { event: "upload-complete", data: fileInfo }
      });
    } catch (error) {
      chrome.runtime.sendMessage({
        type: "offscreen-status",
        payload: { event: "upload-error", error: String(error) }
      });
    }
  };

  mediaRecorder.start(1000);

  chrome.runtime.sendMessage({
    type: "offscreen-status",
    payload: { event: "recording-started", data: { tabId: currentTabId } }
  });
}

async function stopRecording(_reason) {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === "recording") {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  stopAudioMonitor();
}

function stopStreamTracks() {
  if (!currentStream) return;
  for (const track of currentStream.getTracks()) {
    track.stop();
  }
  currentStream = null;
  currentTabId = null;
}

function updateAudioMonitor() {
  if (!currentStream || !monitorEnabled) {
    stopAudioMonitor();
    return;
  }

  if (!monitorAudio) {
    monitorAudio = new Audio();
    monitorAudio.autoplay = true;
    monitorAudio.muted = false;
    monitorAudio.controls = false;
    monitorAudio.style.display = "none";
    document.body.appendChild(monitorAudio);
  }

  const audioOnly = new MediaStream(currentStream.getAudioTracks());
  monitorAudio.srcObject = audioOnly;
  monitorAudio.play().catch(() => {});
}

function stopAudioMonitor() {
  if (!monitorAudio) return;
  monitorAudio.pause();
  monitorAudio.srcObject = null;
  monitorAudio.remove();
  monitorAudio = null;
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

async function uploadToDrive(blob) {
  const token = await getAuthToken();
  const timestamp = new Date();
  const filename = `tab-recording-${formatTimestamp(timestamp)}.webm`;
  const storage = globalThis.chrome?.storage?.sync || globalThis.chrome?.storage?.local || null;
  const { driveFolderId } = storage ? await storage.get("driveFolderId") : {};

  const metadata = {
    name: filename,
    mimeType: "video/webm"
  };

  if (driveFolderId) {
    metadata.parents = [driveFolderId];
  }

  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);

  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink",
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

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}
