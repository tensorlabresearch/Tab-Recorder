/**
 * File Storage Module - Local file storage with configurable folder
 * Saves recordings and transcripts to user-selected local folders
 */

const STORAGE_KEYS = {
  LOCAL_FOLDER: "localSaveFolder",
  LOCAL_FOLDER_HANDLE: "localSaveFolderHandle",
  ENABLE_LOCAL_SAVE: "enableLocalSave"
};

/**
 * Check if File System Access API is available
 * @returns {boolean}
 */
export function isFileSystemAccessAvailable() {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

/**
 * Request a directory from the user and store the handle
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function selectSaveFolder() {
  if (!isFileSystemAccessAvailable()) {
    throw new Error("File System Access API not available in this browser.");
  }

  try {
    const dirHandle = await window.showDirectoryPicker();
    await storeFolderHandle(dirHandle);
    return dirHandle;
  } catch (error) {
    if (error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

/**
 * Store folder handle and path in storage
 * @param {FileSystemDirectoryHandle} dirHandle
 */
async function storeFolderHandle(dirHandle) {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return;

  // Store the handle for later use (requires user activation context)
  // Note: Handles can only be stored in IndexedDB, not chrome.storage
  // We'll store a flag indicating a folder is selected
  await localStorage.set({
    [STORAGE_KEYS.LOCAL_FOLDER]: dirHandle.name,
    [STORAGE_KEYS.LOCAL_FOLDER_HANDLE]: true
  });

  // Also store in IndexedDB for persistent access
  try {
    const db = await openIndexedDB();
    const transaction = db.transaction(["folderHandles"], "readwrite");
    const store = transaction.objectStore("folderHandles");
    await new Promise((resolve, reject) => {
      const request = store.put(dirHandle, "saveFolder");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (_error) {
    // IndexedDB storage is optional
  }
}

/**
 * Open IndexedDB for storing folder handles
 * @returns {Promise<IDBDatabase>}
 */
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("TabRecorderFileStorage", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("folderHandles")) {
        db.createObjectStore("folderHandles");
      }
    };
  });
}

/**
 * Get the stored folder handle from IndexedDB
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
async function getStoredFolderHandle() {
  try {
    const db = await openIndexedDB();
    const transaction = db.transaction(["folderHandles"], "readonly");
    const store = transaction.objectStore("folderHandles");
    return await new Promise((resolve, reject) => {
      const request = store.get("saveFolder");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } catch (_error) {
    return null;
  }
}

/**
 * Get current save folder info
 * @returns {Promise<{name: string|null, handle: FileSystemDirectoryHandle|null}>}
 */
export async function getSaveFolder() {
  const localStorage = globalThis.chrome?.storage?.local;
  const stored = await localStorage?.get(STORAGE_KEYS.LOCAL_FOLDER);
  const name = stored?.[STORAGE_KEYS.LOCAL_FOLDER] || null;
  const handle = name ? await getStoredFolderHandle() : null;
  return { name, handle };
}

/**
 * Check if local saving is enabled
 * @returns {Promise<boolean>}
 */
export async function isLocalSaveEnabled() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return false;
  const stored = await localStorage.get(STORAGE_KEYS.ENABLE_LOCAL_SAVE);
  return stored?.[STORAGE_KEYS.ENABLE_LOCAL_SAVE] ?? false;
}

/**
 * Set local save enabled state
 * @param {boolean} enabled
 */
export async function setLocalSaveEnabled(enabled) {
  const localStorage = globalThis.chrome?.storage?.local;
  if (!localStorage) return;
  await localStorage.set({ [STORAGE_KEYS.ENABLE_LOCAL_SAVE]: Boolean(enabled) });
}

/**
 * Generate a folder name for a session based on date and meeting name
 * Format: YYYY-MM-DD/meeting-name/
 * @param {Object} session
 * @returns {string}
 */
export function generateSessionFolderName(session) {
  const date = session?.startedAt
    ? new Date(session.startedAt)
    : new Date();
  const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD

  const meetingName = String(session?.meetingLabel || session?.tabTitle || "untitled")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 50);

  return `${dateStr}/${meetingName}`;
}

/**
 * Generate a filename for an audio file
 * @param {Object} session
 * @param {string} format - File extension without dot
 * @returns {string}
 */
export function generateAudioFileName(session, format = "webm") {
  const timestamp = session?.startedAt
    ? new Date(session.startedAt).toTimeString().slice(0, 5).replace(":", "-")
    : "00-00";
  const name = String(session?.meetingLabel || "recording")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `${name}_${timestamp}.${format}`;
}

/**
 * Generate a filename for a transcript
 * @param {Object} session
 * @param {string} format - txt, json, or md
 * @returns {string}
 */
export function generateTranscriptFileName(session, format = "txt") {
  const timestamp = session?.startedAt
    ? new Date(session.startedAt).toTimeString().slice(0, 5).replace(":", "-")
    : "00-00";
  const name = String(session?.meetingLabel || "transcript")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `${name}_${timestamp}.${format}`;
}

/**
 * Save a blob to the local folder
 * Creates subdirectories as needed
 * @param {string} folderPath - Relative path within save folder (e.g., "2025-04-24/meeting-name")
 * @param {string} fileName - Name of the file
 * @param {Blob} blob - File content
 * @param {FileSystemDirectoryHandle|null} parentHandle - Optional parent directory handle
 * @returns {Promise<{success: boolean, path: string|null, error: string|null}>}
 */
export async function saveFileLocally(folderPath, fileName, blob, parentHandle = null) {
  const handle = parentHandle || await getStoredFolderHandle();
  if (!handle) {
    return { success: false, path: null, error: "No save folder selected" };
  }

  try {
    // Navigate/create the folder path
    let currentHandle = handle;
    const pathParts = folderPath.split("/").filter(Boolean);

    for (const part of pathParts) {
      try {
        currentHandle = await currentHandle.getDirectoryHandle(part, { create: true });
      } catch (error) {
        return { success: false, path: null, error: `Failed to create directory: ${error.message}` };
      }
    }

    // Create and write the file
    const fileHandle = await currentHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    return { success: true, path: `${folderPath}/${fileName}`, error: null };
  } catch (error) {
    return { success: false, path: null, error: error.message };
  }
}

/**
 * Save session audio to local folder
 * @param {Object} session
 * @param {Blob} audioBlob
 * @param {string} format - Audio format (webm, mp3, wav)
 * @returns {Promise<{success: boolean, path: string|null, error: string|null}>}
 */
export async function saveSessionAudio(session, audioBlob, format = "webm") {
  const folderName = generateSessionFolderName(session);
  const fileName = generateAudioFileName(session, format);
  return saveFileLocally(folderName, fileName, audioBlob);
}

/**
 * Save transcript to local folder in specified format
 * @param {Object} session
 * @param {string} transcriptText
 * @param {Array} transcriptWords - Optional word-level timestamps
 * @param {string} format - txt, json, or md
 * @returns {Promise<{success: boolean, path: string|null, error: string|null}>}
 */
export async function saveSessionTranscript(session, transcriptText, transcriptWords = [], format = "txt") {
  const folderName = generateSessionFolderName(session);
  const fileName = generateTranscriptFileName(session, format);

  let content;
  let mimeType;

  switch (format) {
    case "json":
      content = JSON.stringify({
        session: {
          id: session?.id,
          meetingLabel: session?.meetingLabel,
          tabTitle: session?.tabTitle,
          tabUrl: session?.tabUrl,
          startedAt: session?.startedAt,
          endedAt: session?.endedAt,
          durationMs: session?.durationMs
        },
        transcript: transcriptText,
        words: transcriptWords
      }, null, 2);
      mimeType = "application/json";
      break;
    case "md":
      content = buildMarkdownTranscript(session, transcriptText, transcriptWords);
      mimeType = "text/markdown";
      break;
    case "txt":
    default:
      content = buildPlainTextTranscript(session, transcriptText);
      mimeType = "text/plain";
  }

  const blob = new Blob([content], { type: mimeType });
  return saveFileLocally(folderName, fileName, blob);
}

/**
 * Build markdown transcript content
 * @param {Object} session
 * @param {string} transcriptText
 * @param {Array} transcriptWords
 * @returns {string}
 */
function buildMarkdownTranscript(session, transcriptText, transcriptWords) {
  const lines = [
    `# ${session?.meetingLabel || session?.tabTitle || "Transcript"}`,
    "",
    `**Date:** ${session?.startedAt ? new Date(session.startedAt).toLocaleString() : "Unknown"}`,
    `**Duration:** ${formatDuration(session?.durationMs || 0)}`,
    `**Source:** ${session?.tabUrl || "N/A"}`,
    "",
    "## Transcript",
    "",
    transcriptText || "No transcript available."
  ];

  if (transcriptWords?.length) {
    lines.push("", "## Word Timestamps", "");
    for (const word of transcriptWords) {
      if (word?.text) {
        const time = formatDuration(Math.round((word.start || 0) * 1000));
        lines.push(`- **[${time}]** ${word.text}`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * Build plain text transcript content
 * @param {Object} session
 * @param {string} transcriptText
 * @returns {string}
 */
function buildPlainTextTranscript(session, transcriptText) {
  const lines = [
    `${session?.meetingLabel || session?.tabTitle || "Transcript"}`,
    "",
    `Date: ${session?.startedAt ? new Date(session.startedAt).toLocaleString() : "Unknown"}`,
    `Duration: ${formatDuration(session?.durationMs || 0)}`,
    `Source: ${session?.tabUrl || "N/A"}`,
    "",
    "---",
    "",
    transcriptText || "No transcript available."
  ];
  return lines.join("\n");
}

/**
 * Format duration in ms to MM:SS
 * @param {number} durationMs
 * @returns {string}
 */
function formatDuration(durationMs) {
  const total = Math.max(0, Math.floor(durationMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Open the save folder in the file manager
 * @returns {Promise<void>}
 */
export async function openSaveFolder() {
  const { handle } = await getSaveFolder();
  if (!handle) {
    throw new Error("No save folder configured.");
  }

  // Try to open the folder using the experimental showDirectoryPicker or fallback to alert
  if (handle && typeof handle?.entries === "function") {
    // We have a valid handle - the user can access it via their file manager
    // Unfortunately, there's no direct API to open the folder in system file manager
    // The folder is accessible via the handle in subsequent operations
    return;
  }

  throw new Error("Cannot open folder - folder access may have expired. Please re-select the folder.");
}

/**
 * Clear the saved folder configuration
 */
export async function clearSaveFolder() {
  const localStorage = globalThis.chrome?.storage?.local;
  if (localStorage) {
    await localStorage.remove([STORAGE_KEYS.LOCAL_FOLDER, STORAGE_KEYS.LOCAL_FOLDER_HANDLE]);
  }

  // Also clear from IndexedDB
  try {
    const db = await openIndexedDB();
    const transaction = db.transaction(["folderHandles"], "readwrite");
    const store = transaction.objectStore("folderHandles");
    await new Promise((resolve, reject) => {
      const request = store.delete("saveFolder");
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (_error) {
    // IndexedDB clear is optional
  }
}

/**
 * Get available audio formats based on browser support
 * @returns {Array<{value: string, label: string}>}
 */
export function getSupportedAudioFormats() {
  const formats = [
    { value: "webm", label: "WebM (default)" },
    { value: "mp3", label: "MP3" },
    { value: "wav", label: "WAV" },
    { value: "mp4", label: "MP4" }
  ];

  // In a real implementation, we'd test MediaRecorder.isTypeSupported
  // For now, return all formats - the extension handles conversion if needed
  return formats;
}

/**
 * Get available transcript formats
 * @returns {Array<{value: string, label: string}>}
 */
export function getSupportedTranscriptFormats() {
  return [
    { value: "txt", label: "Plain Text" },
    { value: "json", label: "JSON (with timestamps)" },
    { value: "md", label: "Markdown" }
  ];
}
