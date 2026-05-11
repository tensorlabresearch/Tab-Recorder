// Background service worker for Tab Recorder.
//
// The panel page does its own getDisplayMedia recording; the service worker
// only persists session metadata in chrome.storage.local, surfaces orphan
// .webm files Chrome's downloads tracked, and handles delete cleanup.

import { makeId } from "./lib/utils.js";

const STORAGE_KEYS = {
  SESSIONS: "v2Sessions"
};

const PANEL_URL = chrome.runtime.getURL("panel.html");

chrome.action.onClicked.addListener(async () => {
  await openOrFocusPanelTab();
});

async function openOrFocusPanelTab() {
  const existing = await chrome.tabs.query({ url: PANEL_URL });
  if (existing.length > 0) {
    const tab = existing[0];
    if (Number.isInteger(tab.windowId)) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    await chrome.tabs.update(tab.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url: PANEL_URL, active: true });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "get-sessions") {
    getSessions()
      .then((sessions) => sendResponse({ ok: true, sessions }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "get-orphan-downloads") {
    getOrphanDownloads()
      .then((orphans) => sendResponse({ ok: true, orphans }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "save-session") {
    saveSessionFromPanel(message.session)
      .then((session) => sendResponse({ ok: true, session }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "update-session-mp3") {
    updateSessionMp3(message.sessionId, message.mp3)
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

  if (message.type === "delete-session") {
    deleteSession(message.sessionId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
});

async function getSessions() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return [];
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
}

async function saveSessionFromPanel(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Session payload required");
  }
  const startedAt = Number(payload.startedAt) || Date.now();
  const endedAt = Number(payload.endedAt) || Date.now();
  const session = {
    id: String(payload.id || makeId()),
    tabId: null,
    tabTitle: String(payload.tabTitle || payload.meetingLabel || "Untitled"),
    meetingLabel: String(payload.meetingLabel || "Untitled"),
    tabUrl: String(payload.tabUrl || ""),
    startedAt,
    endedAt,
    durationMs: Math.max(0, Number(payload.durationMs || endedAt - startedAt)),
    status: "complete",
    fileName: String(payload.fileName || ""),
    downloadId: Number.isInteger(payload.downloadId) ? payload.downloadId : null,
    audioFormat: String(payload.audioFormat || "webm"),
    audioMimeType: String(payload.audioMimeType || ""),
    transcriptText: "",
    transcriptWords: [],
    mp3DownloadId: null,
    mp3FileName: ""
  };
  await saveSession(session);
  return session;
}

async function updateSessionMp3(sessionId, mp3) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");
  if (!mp3 || typeof mp3 !== "object") throw new Error("MP3 payload required");

  const sessions = await getSessions();
  const index = sessions.findIndex((item) => item?.id === id);
  if (index < 0) throw new Error("Session not found");

  sessions[index] = {
    ...sessions[index],
    mp3DownloadId: Number.isInteger(mp3.downloadId) ? mp3.downloadId : null,
    mp3FileName: String(mp3.fileName || "")
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

async function deleteSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id) throw new Error("Session ID is required");

  // Synthesized row backed only by a chrome.downloads entry (no session record)
  if (id.startsWith("dl-")) {
    const downloadId = Number(id.slice(3));
    if (Number.isInteger(downloadId)) {
      try { await chrome.downloads.removeFile(downloadId); } catch (_) {}
      try { await chrome.downloads.erase({ id: downloadId }); } catch (_) {}
    }
    return;
  }

  // Synthesized row backed only by a filesystem scan; the panel handles its files.
  if (id.startsWith("fs-")) return;

  const sessions = await getSessions();
  const session = sessions.find((item) => item?.id === id);
  const filtered = sessions.filter((item) => item?.id !== id);
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Storage API unavailable in service worker");
  }
  await localStorage.set({ [STORAGE_KEYS.SESSIONS]: filtered.slice(0, 300) });

  if (session) {
    const ids = [session.downloadId, session.mp3DownloadId].filter(Number.isInteger);
    for (const downloadId of ids) {
      try { await chrome.downloads.removeFile(downloadId); } catch (_) {}
      try { await chrome.downloads.erase({ id: downloadId }); } catch (_) {}
    }
  }
}

async function getOrphanDownloads() {
  const localStorage = globalThis.chrome?.storage?.local;
  const stored = await getSessions();
  let downloads = [];
  try {
    downloads = await chrome.downloads.search({
      filenameRegex: "Tab Recorder.*\\.webm$",
      orderBy: ["-startTime"],
      limit: 200
    });
  } catch (_) {
    downloads = [];
  }

  let durationCache = {};
  if (localStorage) {
    try {
      const result = await localStorage.get("v2DurationCache");
      durationCache = result?.v2DurationCache || {};
    } catch (_) {
      durationCache = {};
    }
  }

  const knownDownloadIds = new Set(
    stored.map((s) => s?.downloadId).filter(Number.isInteger)
  );

  return downloads
    .filter((it) => it && it.state === "complete" && it.exists !== false)
    .filter((it) => !knownDownloadIds.has(it.id))
    .map((download) => {
      const session = synthesizeSessionFromDownload(download);
      const cached = Number(durationCache[session.fileName]);
      if (Number.isFinite(cached) && cached > 0) {
        session.durationMs = cached;
      }
      return session;
    });
}

function synthesizeSessionFromDownload(download) {
  const fullPath = String(download.filename || "");
  const basename = fullPath.split(/[\/\\]/).pop() || "recording";
  let label = basename.replace(/\.[a-z0-9]+$/i, "");
  label = label.replace(/_\d{2}-\d{2}$/, "");
  label = label.replace(/[-_]/g, " ").trim() || "Recording";

  const tabRecorderIdx = fullPath.indexOf("Tab Recorder");
  const relativeName = tabRecorderIdx >= 0 ? fullPath.slice(tabRecorderIdx) : basename;

  const startedAt = download.startTime ? Date.parse(download.startTime) || Date.now() : Date.now();

  return {
    id: `dl-${download.id}`,
    tabId: null,
    tabTitle: label,
    meetingLabel: label,
    tabUrl: "",
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    status: "complete",
    fileName: relativeName,
    downloadId: download.id,
    audioFormat: "webm",
    audioMimeType: "audio/webm",
    transcriptText: "",
    transcriptWords: [],
    mp3DownloadId: null,
    mp3FileName: ""
  };
}
