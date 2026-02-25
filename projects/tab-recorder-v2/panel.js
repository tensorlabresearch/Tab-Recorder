import { debounce } from './lib/utils.js';

const statusEl = document.getElementById("status");
const preRecordEl = document.getElementById("pre-record");
const recordingEl = document.getElementById("recording");
const meetingLabelInput = document.getElementById("meeting-label");
const notesPad = document.getElementById("notes-pad");
const sendNoteButton = document.getElementById("send-note-btn");
const startButton = document.getElementById("start-btn");
const stopButton = document.getElementById("stop-btn");
const openNotesPageButton = document.getElementById("open-notes-page-btn");
const loadingSplashEl = document.getElementById("loading-splash");

let state = null;
let stopRequested = false;
const persistLabelDebounced = debounce(persistMeetingLabel, 250);

init().catch((error) => {
  hideLoadingSplash();
  statusEl.textContent = String(error);
});

async function init() {
  await refreshState();
  hideLoadingSplash();

  startButton.addEventListener("click", onStartRecording);
  stopButton.addEventListener("click", onStopRecording);
  sendNoteButton.addEventListener("click", onSendNote);
  openNotesPageButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("notes_page.html") });
  });
  meetingLabelInput.addEventListener("input", () => persistLabelDebounced());
  meetingLabelInput.addEventListener("blur", () => {
    persistMeetingLabel().catch(() => {});
  });
  notesPad.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSendNote().catch(() => {});
    }
  });
  notesPad.addEventListener("input", () => {
    sendNoteButton.disabled = !state?.recording || !String(notesPad.value || "").trim();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "state-changed") {
      state = message.payload;
      render();
    }
  });
}

function hideLoadingSplash() {
  loadingSplashEl?.classList.add("is-hidden");
}

async function refreshState() {
  state = await chrome.runtime.sendMessage({ type: "get-state" });
  render();
}

async function onStartRecording() {
  const tabId = await resolveCaptureTabId();
  if (!tabId) {
    statusEl.textContent = "Could not find active tab.";
    return;
  }
  let streamId;
  try {
    streamId = await getStreamId(tabId);
  } catch (error) {
    statusEl.textContent = String(error);
    return;
  }
  const response = await chrome.runtime.sendMessage({
    type: "start-recording-with-stream",
    tabId,
    streamId,
    meetingLabel: cleanMeetingLabel()
  });
  if (!response?.ok) {
    statusEl.textContent = response?.error || "Failed to start recording.";
    return;
  }
  await refreshState();
}

async function onStopRecording() {
  stopRequested = true;
  render();
  const response = await chrome.runtime.sendMessage({ type: "stop-recording" });
  if (!response?.ok) {
    stopRequested = false;
    render();
    statusEl.textContent = response?.error || "Failed to stop recording.";
    return;
  }
  await refreshState();
}

async function onSendNote() {
  if (!state?.recording) return;
  const text = String(notesPad.value || "").trim();
  if (!text) return;
  sendNoteButton.disabled = true;
  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: "add-highlight",
      text
    });
  } finally {
    sendNoteButton.disabled = !state?.recording || !String(notesPad.value || "").trim();
  }
  if (!response?.ok) {
    statusEl.textContent = response?.error || "Failed to send note.";
    return;
  }
  notesPad.value = "";
  statusEl.textContent = "Note sent with timestamp.";
}

async function persistMeetingLabel() {
  await chrome.runtime.sendMessage({
    type: "set-meeting-label",
    meetingLabel: cleanMeetingLabel()
  });
}

function cleanMeetingLabel() {
  const value = String(meetingLabelInput.value || "").trim();
  return value || "Untitled Meeting";
}

function render() {
  const isRecording = Boolean(state?.recording);
  preRecordEl.classList.toggle("hidden", isRecording);
  recordingEl.classList.toggle("hidden", !isRecording);
  if (!isRecording && state?.status !== "stopping") {
    stopRequested = false;
  }

  if (isRecording) {
    const warning = String(state?.lastError || "").trim();
    statusEl.textContent = warning
      ? `Recording ${state?.session?.meetingLabel || "meeting"}... (${warning})`
      : `Recording ${state?.session?.meetingLabel || "meeting"}...`;
  } else if (state?.status === "stopping") {
    statusEl.textContent = "Saving to Drive...";
  } else if (state?.status === "error") {
    statusEl.textContent = state?.lastError || "Recorder error.";
  } else {
    statusEl.textContent = "";
  }

  const label = isRecording ? state?.session?.meetingLabel : state?.lastMeetingLabel;
  if (label && meetingLabelInput.value !== label) {
    meetingLabelInput.value = label;
  }

  sendNoteButton.disabled = !isRecording || !String(notesPad.value || "").trim();
  const stopping = stopRequested || state?.status === "stopping";
  stopButton.disabled = Boolean(stopping);
  stopButton.textContent = stopping ? "Stopping..." : "Stop Recording";
}

function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError || !id) {
        reject(chrome.runtime.lastError?.message || "Could not start tab capture.");
        return;
      }
      resolve(id);
    });
  });
}

async function resolveCaptureTabId() {
  if (Number.isInteger(state?.invokedTabId)) {
    return state.invokedTabId;
  }
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return activeTab?.id || null;
}
