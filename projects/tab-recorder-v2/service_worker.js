const OFFSCREEN_URL = "offscreen.html";
const STORAGE_KEYS = {
  STATE: "v2State",
  SESSIONS: "v2Sessions",
  FOLDER: "driveFolderId",
  LAST_MEETING_LABEL: "lastMeetingLabel"
};

const STATE = {
  status: "idle",
  recording: false,
  session: null,
  lastError: null,
  lastUpload: null,
  includeMic: true,
  lastMeetingLabel: "",
  lastSessionId: null,
  invokedTabId: null
};

configureSidePanelBehavior();

chrome.runtime.onInstalled.addListener(() => {
  configureSidePanelBehavior();
});

chrome.runtime.onStartup.addListener(() => {
  configureSidePanelBehavior();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !tab?.windowId) return;
  STATE.invokedTabId = tab.id;
  await persistState();
  notifyStateChanged();
  if (chrome.sidePanel?.setOptions) {
    await chrome.sidePanel
      .setOptions({
        tabId: tab.id,
        path: "panel.html",
        enabled: true
      })
      .catch(() => {});
  }
});

async function configureSidePanelBehavior() {
  if (!chrome.sidePanel?.setPanelBehavior) return;
  await chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "get-state") {
    sendResponse(getStatePayload());
    return;
  }

  if (message.type === "get-sessions") {
    getSessions()
      .then((sessions) => sendResponse({ ok: true, sessions }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "start-recording") {
    startRecording(message.tabId, message.meetingLabel, message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "start-recording-with-stream") {
    startRecording(message.tabId, message.meetingLabel, message.streamId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "stop-recording") {
    stopRecording("popup")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "add-highlight") {
    addHighlight(message.text)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "set-notes-body") {
    setNotesBody(message.notesBody)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "set-drive-folder") {
    setDriveFolder(message.folderId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "set-include-mic") {
    STATE.includeMic = Boolean(message.enabled);
    const localStorage = globalThis.chrome?.storage?.local;
    if (localStorage) {
      localStorage.set({ includeMic: STATE.includeMic }).catch(() => {});
    }
    notifyStateChanged();
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "set-meeting-label") {
    setMeetingLabel(message.meetingLabel)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "update-session-highlights") {
    updateSessionHighlights(message.sessionId, message.highlights)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "update-session-notes") {
    updateSessionNotes(message.sessionId, message.notesBody)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "update-session-transcript") {
    updateSessionTranscript(message.sessionId, message.transcriptText, message.transcriptWords)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "add-session-note") {
    addSessionNote(message.sessionId, message.text, message.atMs)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "create-upload-session") {
    createUploadSession(message.fileName, message.durationMs)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "update-session-drive") {
    updateSessionDrive(message.sessionId, message.drive)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "delete-session") {
    deleteSession(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "offscreen-status") {
    handleOffscreenStatus(message.payload).catch((error) => {
      STATE.status = "error";
      STATE.recording = false;
      STATE.lastError = String(error);
      notifyStateChanged();
    });
    return;
  }

  if (message.type === "get-auth-token") {
    getAuthToken()
      .then((token) => sendResponse({ ok: true, token }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (STATE.recording && STATE.session?.tabId === tabId) {
    stopRecording("tab-closed").catch(() => {});
  }
});

async function ensureOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    if (contexts.length > 0) return;
  }

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["USER_MEDIA"],
    justification: "Record tab audio to build searchable session history"
  });
}

async function startRecording(tabId, meetingLabel, providedStreamId) {
  if (STATE.recording) {
    throw new Error("Already recording");
  }

  const tab = await chrome.tabs.get(tabId);
  const streamId =
    providedStreamId || (await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }));

  const cleanLabel = String(meetingLabel || "").trim();
  const session = {
    id: makeId(),
    tabId,
    tabTitle: tab.title || "Untitled tab",
    meetingLabel: cleanLabel || tab.title || "Untitled meeting",
    tabUrl: tab.url || "",
    startedAt: Date.now(),
    endedAt: null,
    status: "recording",
    notesBody: "",
    noteEvents: [],
    highlights: [],
    drive: null,
    durationMs: null
  };

  STATE.recording = true;
  STATE.status = "starting";
  STATE.session = session;
  STATE.lastMeetingLabel = cleanLabel;
  STATE.lastError = null;
  const localStorage = globalThis.chrome?.storage?.local;
  if (localStorage) {
    localStorage.set({ [STORAGE_KEYS.LAST_MEETING_LABEL]: STATE.lastMeetingLabel }).catch(() => {});
  }
  await persistState();
  notifyStateChanged();

  await ensureOffscreenDocument();
  chrome.runtime.sendMessage({
    type: "offscreen-start",
    payload: {
      streamId,
      sessionId: session.id,
      includeMic: STATE.includeMic
    }
  });
}

async function stopRecording(reason) {
  if (!STATE.recording) return;

  STATE.status = "stopping";
  await persistState();
  notifyStateChanged();

  chrome.runtime.sendMessage({
    type: "offscreen-stop",
    payload: {
      reason,
      session: STATE.session
    }
  });
}

async function addHighlight(text) {
  if (!STATE.session || !STATE.recording) {
    throw new Error("No active recording session");
  }

  const cleanText = String(text || "").trim();
  if (!cleanText) {
    throw new Error("Highlight text is required");
  }

  const atMs = Date.now() - STATE.session.startedAt;
  const entry = {
    id: makeId(),
    text: cleanText,
    atMs
  };
  STATE.session.highlights.push(entry);
  STATE.session.noteEvents.push({
    id: makeId(),
    atMs,
    kind: "append-line",
    chars: cleanText.length,
    noteText: cleanText
  });

  await persistState();
  notifyStateChanged();
}

async function setNotesBody(notesBody) {
  const body = String(notesBody || "");
  const now = Date.now();
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }

  if (STATE.recording && STATE.session) {
    if (STATE.session.notesBody !== body) {
      const atMs = Math.max(0, now - Number(STATE.session.startedAt || now));
      STATE.session.notesBody = body;
      STATE.session.noteEvents.push({
        id: makeId(),
        atMs,
        kind: "edit",
        chars: body.length
      });
      await persistState();
      notifyStateChanged();
    }
    return;
  }

  const sessions = await getSessions();
  const sessionId = STATE.lastSessionId || sessions[0]?.id;
  if (!sessionId) return;
  const index = sessions.findIndex((item) => item?.id === sessionId);
  if (index < 0) return;
  const session = sessions[index];
  if (session.notesBody === body) return;
  const atMs = Number(session.durationMs || 0);
  const noteEvents = Array.isArray(session.noteEvents) ? session.noteEvents.slice() : [];
  noteEvents.push({
    id: makeId(),
    atMs,
    kind: "post-edit",
    chars: body.length
  });
  sessions[index] = {
    ...session,
    notesBody: body,
    noteEvents
  };
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });
}

async function setDriveFolder(folderId) {
  const value = String(folderId || "").trim();
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.FOLDER]: value });
}

async function setMeetingLabel(label) {
  const cleanLabel = String(label || "").trim() || "Untitled Meeting";
  STATE.lastMeetingLabel = cleanLabel;
  if (STATE.session) {
    STATE.session.meetingLabel = cleanLabel;
  }
  const localStorage = globalThis.chrome?.storage?.local;
  if (localStorage) {
    await localStorage.set({ [STORAGE_KEYS.LAST_MEETING_LABEL]: cleanLabel });
  }
  await persistState();
  notifyStateChanged();
}

async function getSessions() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    return [];
  }
  const { [STORAGE_KEYS.SESSIONS]: sessions } = await localStorage.get(STORAGE_KEYS.SESSIONS);
  return Array.isArray(sessions) ? sessions : [];
}

async function saveSession(session) {
  const sessions = await getSessions();
  sessions.unshift(session);
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });
  STATE.lastSessionId = session.id;
}

async function updateSessionHighlights(sessionId, highlights) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");
  if (!Array.isArray(highlights)) throw new Error("Highlights must be an array");

  const sessions = await getSessions();
  const index = sessions.findIndex((item) => item?.id === id);
  if (index < 0) throw new Error("Session not found");

  const session = sessions[index];
  const sanitized = highlights
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || makeId()),
      text: String(item.text || "").trim(),
      atMs: Number(item.atMs || 0)
    }))
    .filter((item) => item.text);

  sessions[index] = { ...session, highlights: sanitized };
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });

  if (STATE.session?.id === id) {
    STATE.session.highlights = sanitized;
    await persistState();
    notifyStateChanged();
  }
  return sessions[index];
}

async function updateSessionNotes(sessionId, notesBody) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");
  const body = String(notesBody || "");
  const sessions = await getSessions();
  const index = sessions.findIndex((item) => item?.id === id);
  if (index < 0) throw new Error("Session not found");
  const session = sessions[index];
  if (String(session.notesBody || "") === body) {
    return session;
  }

  const noteEvents = Array.isArray(session.noteEvents) ? session.noteEvents.slice() : [];
  const atMs = Number(session.durationMs || 0);
  noteEvents.push({
    id: makeId(),
    atMs,
    kind: "page-edit",
    chars: body.length
  });

  sessions[index] = {
    ...session,
    notesBody: body,
    noteEvents
  };

  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });
  return sessions[index];
}

async function updateSessionTranscript(sessionId, transcriptText, transcriptWords) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");
  const text = String(transcriptText || "").trim();
  const words = Array.isArray(transcriptWords) ? transcriptWords : [];

  const sessions = await getSessions();
  const index = sessions.findIndex((item) => item?.id === id);
  if (index < 0) throw new Error("Session not found");
  const session = sessions[index];

  const sanitizedWords = words
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      text: String(item.text || item.word || "").trim(),
      start: Number(item.start || 0),
      end: Number(item.end || 0)
    }))
    .filter((item) => item.text.length);

  sessions[index] = {
    ...session,
    transcriptText: text,
    transcriptWords: sanitizedWords
  };
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });
  return sessions[index];
}

async function addSessionNote(sessionId, text, atMs) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");
  const noteText = String(text || "").trim();
  if (!noteText) throw new Error("Note text is required");
  const noteAtMs = Math.max(0, Number(atMs || 0));

  const sessions = await getSessions();
  const index = sessions.findIndex((item) => item?.id === id);
  if (index < 0) throw new Error("Session not found");
  const session = sessions[index];
  const noteEvents = Array.isArray(session.noteEvents) ? session.noteEvents.slice() : [];
  noteEvents.push({
    id: makeId(),
    atMs: noteAtMs,
    kind: "sent-note",
    chars: noteText.length,
    noteText
  });

  sessions[index] = {
    ...session,
    noteEvents,
    highlights: Array.isArray(session.highlights) ? session.highlights : []
  };

  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });
  return sessions[index];
}

async function createUploadSession(fileName, durationMs) {
  const cleanName = String(fileName || "").trim() || "Uploaded media";
  const now = Date.now();
  const session = {
    id: makeId(),
    tabId: null,
    tabTitle: cleanName,
    meetingLabel: cleanName,
    tabUrl: "local-upload://media",
    startedAt: now,
    endedAt: now,
    status: "uploaded",
    notesBody: "",
    noteEvents: [],
    highlights: [],
    drive: null,
    durationMs: Math.max(0, Number(durationMs || 0)),
    source: "upload"
  };
  await saveSession(session);
  return session;
}

async function updateSessionDrive(sessionId, drive) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");
  if (!drive || typeof drive !== "object") throw new Error("Drive payload is required");
  const sessions = await getSessions();
  const index = sessions.findIndex((item) => item?.id === id);
  if (index < 0) throw new Error("Session not found");
  sessions[index] = { ...sessions[index], drive };
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) throw new Error("Storage API unavailable in service worker");
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: sessions.slice(0, 300) });
  return sessions[index];
}

async function deleteSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");

  const sessions = await getSessions();
  const filtered = sessions.filter((item) => item?.id !== id);
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: filtered.slice(0, 300) });
}

async function handleOffscreenStatus(payload) {
  if (!payload) return;

  if (payload.event === "recording-started") {
    STATE.status = "recording";
    await persistState();
    notifyStateChanged();
    return;
  }

  if (payload.event === "recording-error") {
    STATE.status = "error";
    STATE.recording = false;
    STATE.lastError = payload.error || "Recording failed";
    if (STATE.session) {
      STATE.session.status = "failed";
      STATE.session.endedAt = Date.now();
      STATE.session.durationMs = STATE.session.endedAt - STATE.session.startedAt;
      await saveSession(STATE.session);
    }
    STATE.session = null;
    await persistState();
    notifyStateChanged();
    return;
  }

  if (payload.event === "capture-warning") {
    STATE.lastError = payload.error || "Audio capture warning";
    await persistState();
    notifyStateChanged();
    return;
  }

  if (payload.event === "capture-recovered") {
    STATE.lastError = null;
    await persistState();
    notifyStateChanged();
    return;
  }

  if (payload.event === "upload-complete") {
    const data = payload.data || null;
    if (STATE.session) {
      const finalized = {
        ...STATE.session,
        endedAt: Date.now(),
        status: "complete",
        durationMs: Date.now() - STATE.session.startedAt,
        drive: data
      };
      await saveSession(finalized);
      STATE.lastUpload = data;
    }
    STATE.recording = false;
    STATE.status = "idle";
    STATE.session = null;
    STATE.lastError = null;
    await persistState();
    notifyStateChanged();
    return;
  }

  if (payload.event === "upload-error") {
    STATE.status = "error";
    STATE.recording = false;
    STATE.lastError = payload.error || "Upload failed";
    if (STATE.session) {
      const failed = {
        ...STATE.session,
        endedAt: Date.now(),
        status: "upload_error",
        durationMs: Date.now() - STATE.session.startedAt
      };
      await saveSession(failed);
    }
    STATE.session = null;
    await persistState();
    notifyStateChanged();
  }
}

function getStatePayload() {
  return {
    status: STATE.status,
    recording: STATE.recording,
    session: STATE.session,
    lastError: STATE.lastError,
    lastUpload: STATE.lastUpload,
    includeMic: STATE.includeMic,
    lastMeetingLabel: STATE.lastMeetingLabel,
    lastSessionId: STATE.lastSessionId,
    invokedTabId: STATE.invokedTabId
  };
}

async function persistState() {
  await chrome.storage.session.set({ [STORAGE_KEYS.STATE]: getStatePayload() });
}

function notifyStateChanged() {
  chrome.runtime.sendMessage({
    type: "state-changed",
    payload: getStatePayload()
  });
}

function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(chrome.runtime.lastError?.message || "Failed to get auth token");
        return;
      }
      resolve(token);
    });
  });
}

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

(async function restoreState() {
  const { [STORAGE_KEYS.STATE]: state } = await chrome.storage.session.get(STORAGE_KEYS.STATE);
  if (state) {
    STATE.status = state.status || "idle";
    STATE.recording = Boolean(state.recording);
    STATE.session = state.session || null;
    STATE.lastError = state.lastError || null;
    STATE.lastUpload = state.lastUpload || null;
    if (typeof state.includeMic === "boolean") {
      STATE.includeMic = state.includeMic;
    }
    if (typeof state.lastMeetingLabel === "string") {
      STATE.lastMeetingLabel = state.lastMeetingLabel;
    }
    if (typeof state.lastSessionId === "string") {
      STATE.lastSessionId = state.lastSessionId;
    }
    if (Number.isInteger(state.invokedTabId)) {
      STATE.invokedTabId = state.invokedTabId;
    }
  }
  const localStorage = globalThis.chrome?.storage?.local;
  if (localStorage) {
    const { includeMic, [STORAGE_KEYS.LAST_MEETING_LABEL]: lastMeetingLabel } = await localStorage.get([
      "includeMic",
      STORAGE_KEYS.LAST_MEETING_LABEL
    ]);
    if (typeof includeMic === "boolean") {
      STATE.includeMic = includeMic;
    } else {
      await localStorage.set({ includeMic: true });
    }
    if (typeof lastMeetingLabel === "string") {
      STATE.lastMeetingLabel = lastMeetingLabel;
    }
  }
  notifyStateChanged();
})();

function notesBodyToHighlights(notesBody, previousHighlights) {
  const lines = String(notesBody || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const prev = Array.isArray(previousHighlights) ? previousHighlights : [];
  return lines.map((text, index) => ({
    id: makeId(),
    text,
    atMs: prev[index]?.atMs ?? index * 1000
  }));
}

function formatMmSs(atMs) {
  const total = Math.max(0, Math.floor(Number(atMs || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
