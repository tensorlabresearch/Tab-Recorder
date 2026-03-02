import { debounce } from './lib/utils.js';

const statusEl = document.getElementById("status");
const toggleButton = document.getElementById("record-toggle");
const noteInput = document.getElementById("note-input");
const noteHint = document.getElementById("note-hint");
const meetingLabelInput = document.getElementById("meeting-label");
const openNotesPageButton = document.getElementById("open-notes-page");

let state = null;
const persistLabelDebounced = debounce(persistMeetingLabel, 250);
const persistNotesDebounced = debounce(persistNotesBody, 350);

init().catch((error) => {
  statusEl.textContent = String(error);
});

async function init() {
  await refreshState();

  toggleButton.addEventListener("click", onToggleRecording);
  meetingLabelInput.addEventListener("input", () => {
    persistLabelDebounced();
  });
  meetingLabelInput.addEventListener("blur", () => {
    persistMeetingLabel().catch(() => {});
  });
  openNotesPageButton.addEventListener("click", async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("notes_page.html") });
  });
  noteInput.addEventListener("input", () => {
    persistNotesDebounced();
  });
  noteInput.addEventListener("blur", () => {
    persistNotesBody().catch(() => {});
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "state-changed") {
      state = message.payload;
      renderState();
    }
  });
}

async function refreshState() {
  state = await chrome.runtime.sendMessage({ type: "get-state" });
  renderState();
}

async function onToggleRecording() {
  if (state?.recording) {
    await chrome.runtime.sendMessage({ type: "stop-recording" });
    return;
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id) {
    statusEl.textContent = "Could not find active tab.";
    return;
  }

  const meetingLabel = cleanMeetingLabel();
  const response = await chrome.runtime.sendMessage({
    type: "start-recording",
    tabId: activeTab.id,
    meetingLabel
  });

  if (!response?.ok) {
    statusEl.textContent = response?.error || "Failed to start recording.";
    return;
  }

  await refreshState();
}

async function persistMeetingLabel() {
  const response = await chrome.runtime.sendMessage({
    type: "set-meeting-label",
    meetingLabel: cleanMeetingLabel()
  });
  if (!response?.ok) {
    statusEl.textContent = response?.error || "Failed to update meeting name.";
  }
}

async function persistNotesBody() {
  const response = await chrome.runtime.sendMessage({
    type: "set-notes-body",
    notesBody: String(noteInput.value || "")
  });
  if (!response?.ok) {
    statusEl.textContent = response?.error || "Failed to update notes.";
  }
}

function renderState() {
  const status = state?.status || "idle";
  if (status === "recording") {
    const title = state?.session?.meetingLabel || state?.session?.tabTitle || "current meeting";
    statusEl.textContent = `Recording ${title}.`;
  } else if (status === "starting") {
    statusEl.textContent = "Starting recording...";
  } else if (status === "stopping") {
    statusEl.textContent = "Saving audio and notes to Drive...";
  } else if (status === "error") {
    statusEl.textContent = state?.lastError || "Recorder error.";
  } else {
    statusEl.textContent = "Ready to record.";
  }

  const currentLabel = state?.recording
    ? state?.session?.meetingLabel
    : state?.lastMeetingLabel;
  if (currentLabel && meetingLabelInput.value !== currentLabel) {
    meetingLabelInput.value = currentLabel;
  }
  const nextNotesBody = state?.session?.notesBody || "";
  if (noteInput.value !== nextNotesBody) {
    noteInput.value = nextNotesBody;
  }

  toggleButton.textContent = state?.recording ? "Stop Recording" : "Start Recording Active Tab";
  toggleButton.classList.toggle("stop", Boolean(state?.recording));

  const canAddNotes = Boolean(state?.recording);
  noteInput.disabled = !canAddNotes;
  noteHint.textContent = canAddNotes
    ? "Notes are logged with timestamps behind the scenes for later analysis."
    : "Start recording to create notes.";
}

function cleanMeetingLabel() {
  const value = String(meetingLabelInput.value || "").trim();
  return value || "Untitled Meeting";
}

