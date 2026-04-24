import {
  isLocalSaveEnabled,
  getSaveFolder,
  saveSessionAudio,
  saveSessionTranscript
} from "./lib/fileStorage.js";

const sessionsEl = document.getElementById("sessions");
const searchEl = document.getElementById("search");
const uploadMediaButton = document.getElementById("upload-media");
const uploadMediaInput = document.getElementById("upload-media-input");
const refreshButton = document.getElementById("refresh");
const recorderSyncEl = document.getElementById("recorder-sync");
const statusEl = document.getElementById("status");
const transcriptionUiEnabled =
  document.querySelector(".page")?.getAttribute("data-transcription-ui") === "on";

let sessions = [];
let query = "";
let expandedSessionId = null;
let recorderState = null;
const audioStateBySessionId = new Map();
const OPENAI_API_KEY_STORAGE_KEY = "openaiApiKey";
const TRANSCRIPTION_MODEL = "gpt-4o-transcribe";
const TRANSCRIPTION_ESTIMATED_COST_PER_MIN = 0.006;
const SESSIONS_STORAGE_KEY = "v2Sessions";
const MIN_TRANSCRIBE_BYTES = 100 * 1024;
const MAX_TRANSCRIBE_BYTES = 250 * 1024 * 1024;
const notesSaveTimersBySessionId = new Map();

init().catch((error) => {
  sessionsEl.textContent = String(error);
});

async function init() {
  await loadSessions({ syncFromDrive: true });
  await refreshRecorderState();
  setInterval(() => {
    refreshRecorderState().catch(() => {});
  }, 2000);
  searchEl.addEventListener("input", () => {
    query = String(searchEl.value || "").trim().toLowerCase();
    renderSessions();
  });
  if (uploadMediaButton && uploadMediaInput) {
    uploadMediaButton.addEventListener("click", () => {
      uploadMediaInput.click();
    });
    uploadMediaInput.addEventListener("change", () => {
      onUploadMedia().catch((error) => {
        statusEl.textContent = String(error);
        uploadMediaInput.value = "";
      });
    });
  }
  refreshButton.addEventListener("click", () => {
    loadSessions({ syncFromDrive: true }).catch((error) => {
      statusEl.textContent = String(error);
    });
  });
}

async function onUploadMedia() {
  const file = uploadMediaInput.files?.[0];
  if (!file) return;
  statusEl.textContent = "Preparing uploaded media...";
  const durationMs = await getMediaDurationMs(file).catch(() => 0);
  const session = await createUploadSession(file.name, durationMs);
  upsertSession(session);
  sessions.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  const state = getAudioState(session.id);
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
  }
  state.objectUrl = URL.createObjectURL(file);
  state.audioBlob = file;
  state.error = "";
  state.loading = false;
  expandedSessionId = session.id;
  try {
    await sendSessionToDrive(session.id, file);
    statusEl.textContent = "Uploaded to Drive and ready to transcribe.";
  } catch (error) {
    statusEl.textContent = `Uploaded locally. Drive send failed: ${String(error)}`;
  }
  renderSessions();
  uploadMediaInput.value = "";
}

async function createUploadSession(fileName, durationMs) {
  try {
    const create = await chrome.runtime.sendMessage({
      type: "create-upload-session",
      fileName,
      durationMs
    });
    if (create?.ok && create.session) {
      return create.session;
    }
    if (create?.error) {
      throw new Error(create.error);
    }
  } catch (_error) {
    // Fall back to direct local storage write when background worker is unavailable/stale.
  }
  return createUploadSessionFallback(fileName, durationMs);
}

async function createUploadSessionFallback(fileName, durationMs) {
  const cleanName = String(fileName || "").trim() || "Uploaded media";
  const now = Date.now();
  const session = {
    id: makeLocalId(),
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
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) {
    throw new Error("Failed to create upload session.");
  }
  const stored = await localStorage.get(SESSIONS_STORAGE_KEY);
  const current = Array.isArray(stored?.[SESSIONS_STORAGE_KEY]) ? stored[SESSIONS_STORAGE_KEY] : [];
  current.unshift(session);
  await localStorage.set({ [SESSIONS_STORAGE_KEY]: current.slice(0, 300) });
  return session;
}

async function loadSessions({ syncFromDrive }) {
  const response = await chrome.runtime.sendMessage({ type: "get-sessions" });
  sessions = response?.ok && Array.isArray(response.sessions) ? response.sessions : [];
  cleanupAudioStateForMissingSessions();

  if (syncFromDrive) {
    statusEl.textContent = "Refreshing and syncing from Drive...";
    try {
      await syncNotesFromDrive();
    } catch (error) {
      statusEl.textContent = `Refresh done, Drive sync issue: ${String(error)}`;
    }
  }

  sessions.sort((a, b) => Number(b.startedAt || 0) - Number(a.startedAt || 0));
  renderSessions();
  renderRecorderSync();
  if (statusEl.textContent.startsWith("Refreshing") || !statusEl.textContent) {
    statusEl.textContent = `${sessions.length} sessions`;
  }
}

async function refreshRecorderState() {
  recorderState = await chrome.runtime.sendMessage({ type: "get-state" });
  renderRecorderSync();
}

function renderSessions() {
  sessionsEl.innerHTML = "";
  const filtered = sessions.filter((session) => {
    if (!query) return true;
    const haystack = `${session.meetingLabel || ""}\n${session.notesBody || ""}`.toLowerCase();
    return haystack.includes(query);
  });

  if (!filtered.length) {
    sessionsEl.textContent = "No sessions found.";
    return;
  }

  for (const session of filtered) {
    const card = document.createElement("article");
    card.className = "session";
    const isExpanded = session.id === expandedSessionId;
    if (isExpanded) card.classList.add("expanded");

    const header = document.createElement("div");
    header.className = "session-header";

    const toggle = document.createElement("button");
    toggle.className = "session-toggle";
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      toggleSessionExpanded(session);
    });

    const title = document.createElement("div");
    title.className = "title";
    title.textContent = session.meetingLabel || session.tabTitle || "Untitled Meeting";

    const deleteButton = document.createElement("button");
    deleteButton.className = "danger";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", async () => {
      const confirmed = confirm(`Delete "${title.textContent}" from the workspace?`);
      if (!confirmed) return;
      const remove = await chrome.runtime.sendMessage({ type: "delete-session", sessionId: session.id });
      if (!remove?.ok) {
        statusEl.textContent = remove?.error || "Delete failed.";
        return;
      }
      await loadSessions({ syncFromDrive: false });
    });

    const meta = document.createElement("div");
    meta.className = "meta";
    const started = session.startedAt ? new Date(session.startedAt).toLocaleString() : "unknown";
    const duration = formatDuration(session.durationMs || 0);
    meta.textContent = `${started} | ${duration}`;
    const headerText = document.createElement("div");
    headerText.className = "session-header-text";
    headerText.append(title, meta);

    const chevron = document.createElement("span");
    chevron.className = "session-chevron";
    chevron.textContent = isExpanded ? "▾" : "▸";
    toggle.append(headerText, chevron);

    const body = document.createElement("div");
    body.className = "session-body";
    const layout = document.createElement("div");
    layout.className = "session-layout";

    const left = document.createElement("div");
    left.className = "session-left";
    const player = makePlayer(session);
    const notesEditor = makeSessionNotesEditor(session);
    const transcriptPanel = transcriptionUiEnabled ? makeTranscriptPanel(session, player.audioEl) : null;
    const actions = document.createElement("div");
    actions.className = "actions";
    if (transcriptionUiEnabled && transcriptPanel) {
      const transcribeButton = document.createElement("button");
      transcribeButton.className = "transcribe";
      transcribeButton.textContent = transcribeButtonLabel(session, getAudioState(session.id));
      transcribeButton.addEventListener("click", async () => {
        transcribeButton.disabled = true;
        try {
          await transcribeSession(session.id, player.audioEl, transcriptPanel.wordsWrap, transcriptPanel.emptyEl);
        } catch (error) {
          statusEl.textContent = String(error?.message || error || "Transcription failed.");
        } finally {
          transcribeButton.disabled = false;
          const latest = sessions.find((item) => item.id === session.id) || session;
          transcribeButton.textContent = transcribeButtonLabel(latest, getAudioState(session.id));
        }
      });
      actions.append(transcribeButton);
    }
    const openDriveUrl = String(session?.drive?.folder?.webViewLink || "").trim();
    if (openDriveUrl) {
      const openDriveButton = makeOpenAction("Open Drive", openDriveUrl);
      if (openDriveButton) actions.append(openDriveButton);
    } else {
      const sendToDriveButton = document.createElement("button");
      sendToDriveButton.textContent = "Send to Drive";
      sendToDriveButton.addEventListener("click", async () => {
        sendToDriveButton.disabled = true;
        try {
          await sendSessionToDrive(session.id);
          statusEl.textContent = "Session sent to Drive.";
        } catch (error) {
          statusEl.textContent = String(error);
        } finally {
          sendToDriveButton.disabled = false;
          renderSessions();
        }
      });
      actions.append(sendToDriveButton);
    }

    // Add Save Locally button
    const saveLocallyButton = document.createElement("button");
    saveLocallyButton.textContent = "Save Locally";
    saveLocallyButton.className = "secondary";
    saveLocallyButton.addEventListener("click", async () => {
      saveLocallyButton.disabled = true;
      try {
        await saveSessionToLocal(session);
        statusEl.textContent = "Session saved locally.";
      } catch (error) {
        statusEl.textContent = String(error);
      } finally {
        saveLocallyButton.disabled = false;
      }
    });
    actions.append(saveLocallyButton);
    if (transcriptPanel) {
      left.append(player.wrap, notesEditor, transcriptPanel.wrap, actions);
    } else {
      left.append(player.wrap, notesEditor, actions);
    }

    const right = makeNotesPanel(session, player.audioEl);
    layout.append(left, right);
    body.append(layout);

    header.append(toggle, deleteButton);
    card.append(header, body);
    sessionsEl.append(card);
  }
}

function toggleSessionExpanded(session) {
  const nextId = expandedSessionId === session.id ? null : session.id;
  expandedSessionId = nextId;
  renderSessions();
  if (nextId) {
    ensureAudioLoaded(session).catch((error) => {
      const state = getAudioState(nextId);
      state.loading = false;
      state.error = String(error);
      renderSessions();
    });
  }
}

function renderRecorderSync() {
  if (!recorderSyncEl) return;
  if (recorderState?.recording) {
    recorderSyncEl.textContent = `Recording ${recorderState?.session?.meetingLabel || "meeting"}...`;
    return;
  }
  if (recorderState?.status === "stopping") {
    recorderSyncEl.textContent = "Uploading latest recording to Drive...";
    return;
  }
  recorderSyncEl.textContent = "";
}

function makePlayer(session) {
  const wrap = document.createElement("div");
  wrap.className = "player";
  const state = getAudioState(session.id);
  const audioFileId = resolveAudioFileId(session);
  const streamUrl = resolveAudioStreamUrl(session);

  const audioEl = document.createElement("audio");
  audioEl.controls = true;
  audioEl.preload = "metadata";
  audioEl.className = "audio";
  if (state.objectUrl) {
    audioEl.src = state.objectUrl;
  } else if (streamUrl) {
    audioEl.src = streamUrl;
  }
  audioEl.playbackRate = state.playbackRate;
  audioEl.addEventListener("error", () => {
    // Drive webContentLink can fail due auth/cookie restrictions; fall back to tokenized blob fetch.
    if (state.objectUrl || state.loading) return;
    ensureAudioLoaded(session).catch((error) => {
      state.loading = false;
      state.error = String(error);
      renderSessions();
    });
  });

  const controls = document.createElement("div");
  controls.className = "player-controls";

  const speedLabel = document.createElement("label");
  speedLabel.textContent = "Speed";
  const speedInput = document.createElement("input");
  speedInput.className = "speed-input";
  speedInput.type = "number";
  speedInput.min = "0.25";
  speedInput.max = "16.0";
  speedInput.step = "0.05";
  speedInput.inputMode = "decimal";
  speedInput.value = formatSpeedValue(state.playbackRate);
  speedInput.addEventListener("change", () => {
    const nextRate = clampPlaybackRate(speedInput.value);
    state.playbackRate = nextRate;
    audioEl.playbackRate = nextRate;
    speedInput.value = formatSpeedValue(nextRate);
  });
  speedLabel.append(speedInput);
  controls.append(speedLabel);

  if (!audioFileId && !streamUrl) {
    controls.append(makePlayerMessage("No audio file for this session."));
  } else if (state.loading) {
    controls.append(makePlayerMessage("Loading audio..."));
  } else if (state.error) {
    controls.append(makePlayerMessage(state.error));
  }

  wrap.append(audioEl, controls);
  return { wrap, audioEl };
}

async function syncNotesFromDrive() {
  const sessionsWithNotes = sessions.filter((session) => session?.drive?.notes?.id);
  if (!sessionsWithNotes.length) return;
  const token = await getAuthToken();
  let updatedCount = 0;

  for (const session of sessionsWithNotes) {
    const response = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(session.drive.notes.id)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!response.ok) continue;
    const markdown = await response.text();
    const parsedBody = parseNotesBodyFromMarkdown(markdown);
    if (parsedBody === String(session.notesBody || "")) continue;
    const update = await chrome.runtime.sendMessage({
      type: "update-session-notes",
      sessionId: session.id,
      notesBody: parsedBody
    });
    if (update?.ok && update.session) {
      const index = sessions.findIndex((item) => item.id === session.id);
      if (index >= 0) sessions[index] = update.session;
      updatedCount += 1;
    }
  }

  if (updatedCount > 0) {
    statusEl.textContent = `Synced ${updatedCount} sessions from Drive.`;
  }
}

async function ensureAudioLoaded(session) {
  const sessionId = String(session?.id || "");
  if (!sessionId) return;
  const state = getAudioState(sessionId);
  if (state.objectUrl || state.loading) return;
  const fileId = resolveAudioFileId(session);
  if (!fileId) return;
  state.loading = true;
  state.error = "";
  renderSessions();
  const token = await getAuthToken();
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Audio load failed: ${response.status} ${text}`);
  }
  const blob = await response.blob();
  const normalizedBlob =
    blob.type && blob.type !== "application/octet-stream"
      ? blob
      : new Blob([blob], { type: "audio/webm" });
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
  }
  state.objectUrl = URL.createObjectURL(normalizedBlob);
  state.audioBlob = normalizedBlob;
  state.loading = false;
  state.error = "";
  renderSessions();
}

function resolveAudioFileId(session) {
  return (
    String(session?.drive?.id || "").trim() ||
    String(session?.drive?.audio?.id || "").trim()
  );
}

function resolveAudioStreamUrl(session) {
  return (
    String(session?.drive?.webContentLink || "").trim() ||
    String(session?.drive?.audio?.webContentLink || "").trim()
  );
}

function getAudioState(sessionId) {
  const key = String(sessionId || "");
  if (!audioStateBySessionId.has(key)) {
    audioStateBySessionId.set(key, {
      objectUrl: "",
      audioBlob: null,
      loading: false,
      error: "",
      playbackRate: 1,
      transcribing: false
    });
  }
  return audioStateBySessionId.get(key);
}

function cleanupAudioStateForMissingSessions() {
  const liveIds = new Set(sessions.map((session) => String(session?.id || "")));
  for (const [sessionId, state] of audioStateBySessionId.entries()) {
    if (liveIds.has(sessionId)) continue;
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
    }
    audioStateBySessionId.delete(sessionId);
  }
  if (expandedSessionId && !liveIds.has(expandedSessionId)) {
    expandedSessionId = null;
  }
}

async function transcribeSession(sessionId, audioEl, wordsWrap, emptyEl) {
  const session = sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const state = getAudioState(sessionId);
  if (state.transcribing) return;
  const estimate = estimateTranscriptionCost(session.durationMs || 0);
  const proceed = confirm(
    `Transcribe this recording with ${TRANSCRIPTION_MODEL}?\nEstimated cost: ${estimate}.`
  );
  if (!proceed) return;

  state.transcribing = true;
  statusEl.textContent = `Transcribing (${estimate} est)...${transcriptionWaitHint(session.durationMs || 0)}`;
  try {
    const audioBlob = await getSessionAudioBlob(session);
    await validateTranscriptionMedia(audioBlob);
    const apiKey = await getOpenAIApiKey();
    const transcript = await requestTranscription(apiKey, audioBlob, session);
    const update = await chrome.runtime.sendMessage({
      type: "update-session-transcript",
      sessionId: session.id,
      transcriptText: transcript.text,
      transcriptWords: transcript.words
    });
    if (!update?.ok || !update.session) {
      throw new Error(update?.error || "Failed to save transcript.");
    }
    upsertSession(update.session);
    renderTranscriptWords(wordsWrap, emptyEl, update.session, audioEl?.currentTime || 0);
    statusEl.textContent = `Transcript ready (${estimate} est).`;
  } catch (error) {
    const mapped = mapTranscriptionError(error);
    statusEl.textContent = mapped;
    throw new Error(mapped);
  } finally {
    state.transcribing = false;
  }
}

async function getSessionAudioBlob(session) {
  const state = getAudioState(session.id);
  if (state.audioBlob) return state.audioBlob;
  await ensureAudioLoaded(session);
  if (state.audioBlob) return state.audioBlob;
  if (state.objectUrl) {
    const response = await fetch(state.objectUrl);
    if (!response.ok) throw new Error("Unable to read cached audio.");
    state.audioBlob = await response.blob();
    return state.audioBlob;
  }
  throw new Error("No audio found for this session.");
}

async function getOpenAIApiKey() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) throw new Error("Storage API unavailable.");
  const stored = await localStorage.get(OPENAI_API_KEY_STORAGE_KEY);
  const existing = String(stored?.[OPENAI_API_KEY_STORAGE_KEY] || "").trim();
  if (existing) return existing;
  const entered = prompt("Enter your OpenAI API key (sk-...) for transcription:");
  const apiKey = String(entered || "").trim();
  if (!apiKey) {
    throw new Error("Transcription canceled: missing API key.");
  }
  await localStorage.set({ [OPENAI_API_KEY_STORAGE_KEY]: apiKey });
  return apiKey;
}

async function requestTranscription(apiKey, audioBlob, session) {
  const firstTry = await runTranscriptionRequest(apiKey, audioBlob, session, {
    responseFormat: "verbose_json",
    includeWordTimestamps: true
  });
  if (firstTry.ok) {
    const payload = firstTry.payload;
    const text = String(payload?.text || "").trim();
    if (!text) throw new Error("Transcription returned empty text.");
    return {
      text,
      words: normalizeTranscriptWords(payload, session.durationMs || 0, text)
    };
  }

  const secondTry = await runTranscriptionRequest(apiKey, audioBlob, session, {
    responseFormat: "verbose_json",
    includeWordTimestamps: false
  });
  if (!secondTry.ok) {
    throw new Error(`Transcription failed: ${secondTry.status} ${secondTry.errorText}`);
  }
  const fallbackPayload = secondTry.payload;
  const fallbackText = String(fallbackPayload?.text || "").trim();
  if (!fallbackText) throw new Error("Transcription returned empty text.");
  return {
    text: fallbackText,
    words: normalizeTranscriptWords(fallbackPayload, session.durationMs || 0, fallbackText)
  };
}

async function runTranscriptionRequest(apiKey, audioBlob, session, options) {
  const file = new File([audioBlob], transcriptionFileName(session), {
    type: audioBlob.type || "audio/webm"
  });
  const form = new FormData();
  form.append("file", file);
  form.append("model", TRANSCRIPTION_MODEL);
  form.append("response_format", options.responseFormat);
  if (options.includeWordTimestamps) {
    form.append("timestamp_granularities[]", "word");
  }
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  });
  if (!response.ok) {
    const errorText = await response.text();
    return { ok: false, status: response.status, errorText };
  }
  const payload = await response.json();
  return { ok: true, payload };
}

async function validateTranscriptionMedia(blob) {
  const size = Number(blob?.size || 0);
  if (!size) {
    throw new Error("Transcription failed: media file is empty.");
  }
  if (size < MIN_TRANSCRIBE_BYTES) {
    throw new Error(
      "Transcription failed: recording file is too small/truncated. Re-record and verify the file plays fully."
    );
  }
  if (size > MAX_TRANSCRIBE_BYTES) {
    throw new Error(
      "Transcription failed: file is too large for current direct-upload flow. Split the lecture or use server-side processing."
    );
  }
  const durationMs = await probeMediaDurationMs(blob);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("Transcription failed: could not read media duration metadata.");
  }
}

async function probeMediaDurationMs(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const durationSec = await new Promise((resolve, reject) => {
      const media = document.createElement("audio");
      media.preload = "metadata";
      media.onloadedmetadata = () => {
        if (Number.isFinite(media.duration) && media.duration > 0) {
          resolve(media.duration);
        } else {
          reject(new Error("invalid-duration"));
        }
      };
      media.onerror = () => reject(new Error("media-metadata-read-failed"));
      media.src = objectUrl;
    });
    return Math.round(Number(durationSec) * 1000);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function mapTranscriptionError(error) {
  const raw = String(error?.message || error || "Transcription failed.");
  const lower = raw.toLowerCase();
  if (lower.includes("401") || lower.includes("invalid api key") || lower.includes("incorrect api key")) {
    return "Transcription failed: invalid OpenAI API key. Re-enter a valid key.";
  }
  if (lower.includes("413") || lower.includes("too large")) {
    return "Transcription failed: file too large for direct upload. Use a smaller clip or server-side pipeline.";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "Transcription failed: rate limited. Wait a moment and retry.";
  }
  if (lower.includes("unsupported") || lower.includes("invalid file format")) {
    return "Transcription failed: unsupported/corrupt media format. Export to standard mp4 or webm and retry.";
  }
  if (lower.includes("network") || lower.includes("failed to fetch")) {
    return "Transcription failed: network/upload issue. Check connection and retry.";
  }
  return raw;
}

function transcriptionFileName(session) {
  const label = String(session?.meetingLabel || session?.tabTitle || "meeting")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${label || "meeting"}.webm`;
}

function transcribeButtonLabel(session, state) {
  if (state?.transcribing) return "Transcribing...";
  const estimate = estimateTranscriptionCost(session?.durationMs || 0);
  return `Transcribe (${estimate} est)`;
}

function estimateTranscriptionCost(durationMs) {
  const minutes = Math.max(0, Number(durationMs || 0)) / 60000;
  if (!minutes) return "$0.00";
  const amount = minutes * TRANSCRIPTION_ESTIMATED_COST_PER_MIN;
  return formatUsd(amount);
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`;
}

function makeTranscriptPanel(session, audioEl) {
  const wrap = document.createElement("section");
  wrap.className = "transcript-panel";
  const title = document.createElement("div");
  title.className = "panel-title";
  title.textContent = "Transcript";

  const wordsWrap = document.createElement("div");
  wordsWrap.className = "karaoke-words";
  const emptyEl = document.createElement("div");
  emptyEl.className = "transcript-empty";
  wrap.append(title, wordsWrap, emptyEl);

  renderTranscriptWords(wordsWrap, emptyEl, session, audioEl?.currentTime || 0);
  audioEl.addEventListener("timeupdate", () => {
    renderKaraokeActiveWord(wordsWrap, transcriptWords(session), audioEl.currentTime || 0);
  });
  return { wrap, wordsWrap, emptyEl };
}

function renderTranscriptWords(wordsWrap, emptyEl, session, currentTimeSec) {
  const words = transcriptWords(session);
  wordsWrap.innerHTML = "";
  if (!words.length) {
    emptyEl.textContent = "No transcript yet. Click Transcribe to generate one.";
    return;
  }
  emptyEl.textContent = "";
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    const span = document.createElement("button");
    span.type = "button";
    span.className = "karaoke-word";
    span.textContent = word.text;
    span.dataset.index = String(i);
    span.addEventListener("click", () => {
      if (Number.isFinite(word.start)) {
        audioElSeek(wordsWrap, word.start);
      }
    });
    wordsWrap.append(span);
  }
  renderKaraokeActiveWord(wordsWrap, words, currentTimeSec);
}

function audioElSeek(wordsWrap, seconds) {
  const audioEl = wordsWrap.closest(".session-left")?.querySelector("audio");
  if (!audioEl) return;
  audioEl.currentTime = Math.max(0, Number(seconds || 0));
}

function renderKaraokeActiveWord(wordsWrap, words, currentTimeSec) {
  if (!words.length) return;
  const current = Math.max(0, Number(currentTimeSec || 0));
  const activeIdx = findActiveWordIndex(words, current);
  const nodes = wordsWrap.querySelectorAll(".karaoke-word");
  for (let i = 0; i < nodes.length; i += 1) {
    nodes[i].classList.toggle("active", i === activeIdx);
  }
  if (activeIdx >= 0 && nodes[activeIdx]) {
    nodes[activeIdx].scrollIntoView({ block: "nearest", inline: "center" });
  }
}

function makeNotesPanel(session, audioEl) {
  const panel = document.createElement("aside");
  panel.className = "notes-side-panel";

  const title = document.createElement("div");
  title.className = "panel-title";
  title.textContent = "Timestamped Playback Notes";

  const list = document.createElement("div");
  list.className = "timeline-list";
  renderTimelineNotes(list, session, audioEl);
  panel.append(title, list);
  audioEl.addEventListener("timeupdate", () => {
    updateActiveTimelineNote(list, Math.round(Number(audioEl.currentTime || 0) * 1000));
  });
  return panel;
}

function makeSessionNotesEditor(session) {
  const wrap = document.createElement("section");
  wrap.className = "notes-editor-panel";
  const label = document.createElement("div");
  label.className = "panel-title";
  label.textContent = "Notes";
  const hint = document.createElement("div");
  hint.className = "notes-editor-hint";
  hint.textContent = "These notes are plain notes (no timestamp).";

  const textarea = document.createElement("textarea");
  textarea.className = "notes-editor-input";
  textarea.placeholder = "Write notes here...";
  textarea.value = editableNotesBody(session);
  textarea.addEventListener("input", () => {
    queueSessionNotesSave(session.id, textarea.value);
  });
  textarea.addEventListener("blur", () => {
    flushSessionNotesSave(session.id, textarea.value);
  });
  wrap.append(label, hint, textarea);
  return wrap;
}

function queueSessionNotesSave(sessionId, notesBody) {
  const key = String(sessionId || "");
  if (!key) return;
  const existing = notesSaveTimersBySessionId.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    flushSessionNotesSave(key, notesBody).catch(() => {});
  }, 400);
  notesSaveTimersBySessionId.set(key, timer);
}

async function flushSessionNotesSave(sessionId, notesBody) {
  const key = String(sessionId || "");
  if (!key) return;
  const existing = notesSaveTimersBySessionId.get(key);
  if (existing) {
    clearTimeout(existing);
    notesSaveTimersBySessionId.delete(key);
  }
  const session = sessions.find((item) => item?.id === key);
  if (!session) return;
  const nextBody = normalizePlainNotesBody(String(notesBody || ""));
  if (String(session.notesBody || "") === nextBody) return;
  const response = await chrome.runtime.sendMessage({
    type: "update-session-notes",
    sessionId: key,
    notesBody: nextBody
  });
  if (!response?.ok || !response.session) {
    throw new Error(response?.error || "Failed to save note.");
  }
  upsertSession(response.session);
  syncSessionNotesToDrive(response.session).catch(() => {});
  statusEl.textContent = "Notes saved.";
}

function editableNotesBody(session) {
  return normalizePlainNotesBody(String(session?.notesBody || ""));
}

function normalizePlainNotesBody(text) {
  const value = String(text || "").trim();
  return isPlaceholderNoteText(value) ? "" : value;
}

function isPlaceholderNoteText(text) {
  return String(text || "").trim().toLowerCase() === "no notes captured.";
}

function renderTimelineNotes(listEl, session, audioEl) {
  listEl.innerHTML = "";
  const notes = timelineNotes(session);
  if (!notes.length) {
    const empty = document.createElement("div");
    empty.className = "timeline-empty";
    empty.textContent = "No timestamped notes yet.";
    listEl.append(empty);
    return;
  }
  for (const note of notes) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "timeline-note";
    row.dataset.atMs = String(note.atMs);
    row.innerHTML = `<span class="time">${formatDuration(note.atMs)}</span><span class="text">${escapeHtml(
      note.text
    )}</span>`;
    row.addEventListener("click", () => {
      audioEl.currentTime = Math.max(0, Number(note.atMs || 0) / 1000);
      audioEl.play().catch(() => {});
    });
    listEl.append(row);
  }
  updateActiveTimelineNote(listEl, Math.round(Number(audioEl.currentTime || 0) * 1000));
}

function updateActiveTimelineNote(listEl, currentMs) {
  const items = Array.from(listEl.querySelectorAll(".timeline-note"));
  if (!items.length) return;
  let active = -1;
  for (let i = 0; i < items.length; i += 1) {
    const noteAt = Number(items[i].dataset.atMs || 0);
    if (noteAt <= currentMs) {
      active = i;
    } else {
      break;
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    items[i].classList.toggle("active", i === active);
  }
}

function timelineNotes(session) {
  const fromHighlights = (Array.isArray(session?.highlights) ? session.highlights : [])
    .map((item) => ({
      atMs: Number(item?.atMs || 0),
      text: String(item?.text || "").trim()
    }))
    .filter((item) => item.text && !isPlaceholderNoteText(item.text));

  const events = Array.isArray(session?.noteEvents) ? session.noteEvents : [];
  const fromEvents = events
    .filter((event) =>
      event &&
      typeof event === "object" &&
      (String(event.kind || "") === "sent-note" || String(event.kind || "") === "append-line")
    )
    .map((event) => ({
      atMs: Number(event.atMs || 0),
      text: String(event.noteText || "").trim()
    }))
    .filter((item) => item.text && !isPlaceholderNoteText(item.text));

  const combined = [...fromHighlights, ...fromEvents];
  const deduped = [];
  const seen = new Set();
  for (const item of combined) {
    const key = `${item.atMs}|${item.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped.sort((a, b) => a.atMs - b.atMs);
}

function transcriptWords(session) {
  const words = Array.isArray(session?.transcriptWords) ? session.transcriptWords : [];
  return words
    .map((item) => ({
      text: String(item?.text || item?.word || "").trim(),
      start: Number(item?.start || 0),
      end: Number(item?.end || 0)
    }))
    .filter((item) => item.text);
}

function findActiveWordIndex(words, currentTimeSec) {
  if (!words.length) return -1;
  let lo = 0;
  let hi = words.length - 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const word = words[mid];
    const start = Number(word.start || 0);
    const end = Number(word.end || start);
    if (currentTimeSec < start) {
      hi = mid - 1;
    } else if (currentTimeSec > end) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.min(words.length - 1, Math.max(0, lo - 1));
}

function normalizeTranscriptWords(payload, durationMs, transcriptText) {
  const words = [];
  const payloadWords = Array.isArray(payload?.words) ? payload.words : [];
  for (const item of payloadWords) {
    const text = String(item?.word || item?.text || "").trim();
    if (!text) continue;
    words.push({
      text,
      start: Number(item?.start || 0),
      end: Number(item?.end || item?.start || 0)
    });
  }
  if (words.length) return words;

  const segments = Array.isArray(payload?.segments) ? payload.segments : [];
  for (const segment of segments) {
    const segmentWords = Array.isArray(segment?.words) ? segment.words : [];
    if (segmentWords.length) {
      for (const word of segmentWords) {
        const text = String(word?.word || word?.text || "").trim();
        if (!text) continue;
        words.push({
          text,
          start: Number(word?.start || 0),
          end: Number(word?.end || word?.start || 0)
        });
      }
    } else {
      words.push(...spreadWordsOverRange(String(segment?.text || ""), Number(segment?.start || 0), Number(segment?.end || 0)));
    }
  }
  if (words.length) return words;

  return spreadWordsOverRange(String(transcriptText || ""), 0, Math.max(1, Number(durationMs || 0) / 1000));
}

function spreadWordsOverRange(text, startSec, endSec) {
  const pieces = String(text || "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!pieces.length) return [];
  const start = Math.max(0, Number(startSec || 0));
  const end = Math.max(start + 0.01, Number(endSec || start + 1));
  const step = (end - start) / pieces.length;
  const out = [];
  for (let i = 0; i < pieces.length; i += 1) {
    const wordStart = start + i * step;
    out.push({
      text: pieces[i],
      start: wordStart,
      end: wordStart + step
    });
  }
  return out;
}

function upsertSession(session) {
  const index = sessions.findIndex((item) => item?.id === session?.id);
  if (index >= 0) {
    sessions[index] = session;
  } else {
    sessions.unshift(session);
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function makeLocalId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getMediaDurationMs(file) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const durationSec = await new Promise((resolve, reject) => {
      const media = document.createElement("audio");
      media.preload = "metadata";
      media.onloadedmetadata = () => resolve(Number(media.duration || 0));
      media.onerror = () => reject(new Error("Could not read media metadata."));
      media.src = objectUrl;
    });
    return Math.max(0, Math.round(durationSec * 1000));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function sendSessionToDrive(sessionId, preferredBlob) {
  const session = sessions.find((item) => item?.id === sessionId);
  if (!session) throw new Error("Session not found.");
  const state = getAudioState(sessionId);
  const blob = preferredBlob || state.audioBlob || (await getSessionAudioBlob(session));
  const token = await getAuthToken();
  const rootFolderId = await getConfiguredDriveFolderId();
  const sessionName = sanitizeName(session.meetingLabel || session.tabTitle || "Uploaded media");
  const folder = await createDriveFolder(token, sessionName, rootFolderId);
  const mediaFile = await uploadFileMultipart(
    token,
    {
      name: sanitizeUploadFileName(session, blob),
      mimeType: blob.type || "application/octet-stream",
      parents: [folder.id]
    },
    blob
  );
  const notesFile = await uploadFileMultipart(
    token,
    {
      name: `${sessionName}-notes.md`,
      mimeType: "text/markdown",
      parents: [folder.id]
    },
    new Blob([buildNotesContent(session)], { type: "text/markdown;charset=utf-8" })
  );
  const drive = {
    ...mediaFile,
    folder: {
      id: folder.id,
      name: folder.name,
      webViewLink: `https://drive.google.com/drive/folders/${folder.id}`
    },
    notes: notesFile
  };
  const update = await chrome.runtime.sendMessage({
    type: "update-session-drive",
    sessionId,
    drive
  });
  if (!update?.ok || !update.session) {
    throw new Error(update?.error || "Failed to save Drive link to session.");
  }
  upsertSession(update.session);
  return update.session;
}

async function getConfiguredDriveFolderId() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return "";
  const stored = await localStorage.get("driveFolderId");
  return String(stored?.driveFolderId || "").trim();
}

async function createDriveFolder(token, name, parentId) {
  const metadata = {
    name,
    mimeType: "application/vnd.google-apps.folder"
  };
  if (parentId) metadata.parents = [parentId];
  const response = await fetch("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(metadata)
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive folder create failed: ${response.status} ${text}`);
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
      headers: { Authorization: `Bearer ${token}` },
      body: form
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive upload failed: ${response.status} ${text}`);
  }
  return response.json();
}

function sanitizeName(value) {
  const cleaned = String(value || "meeting")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "meeting";
}

function sanitizeUploadFileName(session, blob) {
  const base = sanitizeName(session?.meetingLabel || session?.tabTitle || "uploaded-media").replace(/\s+/g, "-");
  return `${base}${inferExtensionFromMime(blob?.type)}`;
}

function inferExtensionFromMime(mimeType) {
  const lower = String(mimeType || "").toLowerCase();
  if (lower.includes("webm")) return ".webm";
  if (lower.includes("mp4")) return ".mp4";
  if (lower.includes("mpeg")) return ".mp3";
  if (lower.includes("wav")) return ".wav";
  if (lower.includes("aac")) return ".aac";
  if (lower.includes("m4a") || lower.includes("mp4a")) return ".m4a";
  return ".bin";
}

function parseNotesBodyFromMarkdown(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const notesIndex = lines.findIndex((line) => line.trim().toLowerCase() === "## notes");
  if (notesIndex < 0) return "";
  const eventsIndex = lines.findIndex(
    (line, index) => index > notesIndex && line.trim().toLowerCase() === "## note events"
  );
  const noteLines = lines.slice(notesIndex + 1, eventsIndex < 0 ? lines.length : eventsIndex);
  return normalizePlainNotesBody(noteLines.join("\n"));
}

async function syncSessionNotesToDrive(session) {
  const notesFileId = session?.drive?.notes?.id;
  if (!notesFileId) return;
  const token = await getAuthToken();
  const body = buildNotesContent(session);
  const response = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(notesFileId)}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/markdown"
      },
      body
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Drive notes sync failed: ${response.status} ${text}`);
  }
}

function buildNotesContent(session) {
  const label = session?.meetingLabel || session?.tabTitle || "Untitled meeting";
  const tabUrl = session?.tabUrl || "";
  const startedAt = session?.startedAt ? new Date(session.startedAt).toISOString() : "";
  const notesBody = String(session?.notesBody || "").trim();
  const noteEvents = Array.isArray(session?.noteEvents) ? session.noteEvents : [];
  const lines = [
    `# ${label}`,
    "",
    `- Source: ${tabUrl || "N/A"}`,
    `- Started: ${startedAt || "N/A"}`,
    "",
    "## Notes",
    notesBody || "No notes captured.",
    "",
    "## Note Events"
  ];
  if (!noteEvents.length) {
    lines.push("- None");
  } else {
    for (const event of noteEvents) {
      const noteText = String(event.noteText || "").trim();
      if (noteText) {
        lines.push(`- [${formatDuration(event.atMs || 0)}] sent-note: ${noteText}`);
      } else {
        lines.push(`- [${formatDuration(event.atMs || 0)}] ${event.kind || "edit"} (${event.chars || 0} chars)`);
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

function makeOpenAction(label, url) {
  if (!url) return null;
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", async () => {
    await chrome.tabs.create({ url });
  });
  return button;
}

async function getAuthToken() {
  const tokenResponse = await chrome.runtime.sendMessage({ type: "get-auth-token" });
  if (!tokenResponse?.ok || !tokenResponse?.token) {
    throw new Error(tokenResponse?.error || "Failed to get Google token.");
  }
  return tokenResponse.token;
}

function formatDuration(durationMs) {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function makePlayerMessage(text) {
  const status = document.createElement("span");
  status.className = "player-status";
  status.textContent = String(text || "");
  return status;
}

function clampPlaybackRate(value) {
  const parsed = Number.parseFloat(String(value || ""));
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(16, Math.max(0.25, parsed));
}

function transcriptionWaitHint(durationMs) {
  const minutes = Math.max(0, Number(durationMs || 0)) / 60000;
  if (minutes >= 60) return " Large file: this can take 10+ minutes.";
  if (minutes >= 30) return " This may take several minutes.";
  return "";
}

/**
 * Save a session's audio and transcript to local folder
 * @param {Object} session
 */
async function saveSessionToLocal(session) {
  const localSaveEnabled = await isLocalSaveEnabled();
  if (!localSaveEnabled) {
    throw new Error("Local file saving is not enabled. Go to Settings to enable it.");
  }

  const { handle } = await getSaveFolder();
  if (!handle) {
    throw new Error("No save folder selected. Go to Settings to choose a folder.");
  }

  // Get format preferences
  const localStorage = globalThis.chrome?.storage?.local;
  const stored = await localStorage?.get(["localAudioFormat", "localTranscriptFormat"]);
  const audioFormat = stored?.localAudioFormat || "webm";
  const transcriptFormat = stored?.localTranscriptFormat || "txt";

  // Get audio blob
  const state = getAudioState(session.id);
  let audioBlob = state.audioBlob;
  if (!audioBlob) {
    await ensureAudioLoaded(session);
    audioBlob = state.audioBlob;
  }

  // Save audio
  if (audioBlob && audioBlob.size > 0) {
    const result = await saveSessionAudio(session, audioBlob, audioFormat);
    if (!result.success) {
      throw new Error(`Failed to save audio: ${result.error}`);
    }
  }

  // Save transcript if available
  if (session?.transcriptText) {
    const result = await saveSessionTranscript(
      session,
      session.transcriptText,
      session.transcriptWords || [],
      transcriptFormat
    );
    if (!result.success) {
      throw new Error(`Failed to save transcript: ${result.error}`);
    }
  }
}

function formatSpeedValue(value) {
  return clampPlaybackRate(value).toFixed(2).replace(/\.?0+$/, "");
}
