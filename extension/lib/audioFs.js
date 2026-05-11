const HANDLE_DB_NAME = "tabRecorderHandles";
const HANDLE_DB_STORE = "handles";
const HANDLE_KEY = "recordingsDir";
const DURATION_CACHE_KEY = "v2DurationCache";

let cachedHandle = null;

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(HANDLE_DB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

async function readStoredHandle() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_DB_STORE, "readonly");
    const store = tx.objectStore(HANDLE_DB_STORE);
    const req = store.get(HANDLE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function writeStoredHandle(handle) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_DB_STORE, "readwrite");
    const store = tx.objectStore(HANDLE_DB_STORE);
    const req = store.put(handle, HANDLE_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function clearStoredHandle() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_DB_STORE, "readwrite");
    const store = tx.objectStore(HANDLE_DB_STORE);
    const req = store.delete(HANDLE_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function verifyHandlePermission(handle, mode = "read") {
  if (!handle) return false;
  const opts = { mode };
  let perm = await handle.queryPermission(opts);
  if (perm === "granted") return true;
  perm = await handle.requestPermission(opts);
  return perm === "granted";
}

export async function getRecordingsDirectoryHandle({ requireFresh = false, mode = "read" } = {}) {
  if (cachedHandle && !requireFresh) {
    if (await verifyHandlePermission(cachedHandle, mode)) return cachedHandle;
  }
  const stored = await readStoredHandle().catch(() => null);
  if (stored) {
    if (await verifyHandlePermission(stored, mode)) {
      cachedHandle = stored;
      return stored;
    }
  }
  return null;
}

export async function ensureWritable(handle) {
  return verifyHandlePermission(handle, "readwrite");
}

export async function pickRecordingsDirectory() {
  if (typeof window === "undefined" || !("showDirectoryPicker" in window)) {
    const isBrave =
      typeof navigator !== "undefined" &&
      typeof navigator.brave?.isBrave === "function";
    if (isBrave) {
      throw new Error(
        "File System Access API is disabled in Brave by default. " +
          "Open brave://flags/#file-system-access-api, set it to Enabled, " +
          "relaunch Brave, then re-open Tab Recorder and try Pick Folder again."
      );
    }
    throw new Error("File System Access API not available in this browser.");
  }
  const handle = await window.showDirectoryPicker({
    id: "tabRecorderDir",
    mode: "readwrite",
    startIn: "downloads"
  });
  await writeStoredHandle(handle).catch(() => {});
  cachedHandle = handle;
  return handle;
}

export async function forgetRecordingsDirectory() {
  cachedHandle = null;
  await clearStoredHandle().catch(() => {});
}

export async function readRecordingFile(handle, sessionFileName) {
  if (!handle) throw new Error("Recordings folder access not granted yet.");
  const original = String(sessionFileName || "");
  if (!original) throw new Error("Invalid recording filename.");

  for (const candidate of pathCandidates(handle, original)) {
    try {
      return await walkAndRead(handle, candidate);
    } catch (_) {}
  }

  // Final fallback: walk the whole granted tree looking for the basename.
  // Handles the case where files moved between subfolders, or where the saved
  // path simply doesn't match the on-disk layout.
  const basename = original.split(/[\/\\]/).pop();
  if (basename) {
    const found = await findFileByBasename(handle, basename);
    if (found) return found.file;
  }

  throw new Error(
    `File not found in selected folder: ${original}. Try Pick Folder to re-grant access to your recordings folder.`
  );
}

export async function findRelativePathByBasename(handle, basename) {
  const found = await findFileByBasename(handle, basename);
  if (!found) return null;
  return found.relativePath;
}

async function findFileByBasename(handle, basename) {
  if (!handle || !basename) return null;
  const target = String(basename).toLowerCase();
  const granted = await verifyHandlePermission(handle, "read");
  if (!granted) return null;
  return await searchTree(handle, [], target);
}

async function searchTree(dir, segments, targetLower) {
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === "file") {
      if (name.toLowerCase() === targetLower) {
        const file = await entry.getFile();
        return {
          file,
          relativePath: [...segments, name].join("/")
        };
      }
    } else if (entry.kind === "directory") {
      const inner = await searchTree(entry, [...segments, name], targetLower);
      if (inner) return inner;
    }
  }
  return null;
}

async function walkAndRead(handle, relativePath) {
  const parts = String(relativePath || "").split(/[\/\\]/).filter(Boolean);
  if (parts.length === 0) throw new Error("Invalid path");
  const fileName = parts.pop();
  let dir = handle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const fileHandle = await dir.getFileHandle(fileName);
  return await fileHandle.getFile();
}

export function pathCandidates(handle, sessionFileName) {
  const original = String(sessionFileName || "");
  if (!original) return [];
  const out = [];
  const seen = new Set();
  const push = (p) => {
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  };
  push(original);
  if (handle?.name) {
    const escaped = handle.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    push(original.replace(new RegExp("^" + escaped + "[\\\\/]"), ""));
  }
  push(original.replace(/^Tab Recorder[\\/]/, ""));
  return out;
}

async function resolvePath(handle, sessionFileName) {
  for (const candidate of pathCandidates(handle, sessionFileName)) {
    try {
      await walkAndRead(handle, candidate);
      return candidate;
    } catch (_) {}
  }
  // Try a basename search across the granted tree before giving up. This keeps the
  // MP3/transcript filename anchored to the actual webm even when subfolders moved.
  const basename = String(sessionFileName || "").split(/[\/\\]/).pop();
  if (basename) {
    const rel = await findRelativePathByBasename(handle, basename).catch(() => null);
    if (rel) return rel;
  }
  // Last resort: most-stripped variant. Used for brand-new artifacts whose source webm
  // may legitimately not exist yet (we won't reach here for MP3/transcript writes since
  // the source webm is required to be on disk).
  const candidates = pathCandidates(handle, sessionFileName);
  return candidates[candidates.length - 1] || sessionFileName;
}

export async function writeRecordingArtifact(handle, sessionFileName, blob, { extension }) {
  if (!handle) throw new Error("Recordings folder access not granted yet.");
  if (!blob) throw new Error("Blob required.");
  const writable = await ensureWritable(handle);
  if (!writable) throw new Error("Folder not writable.");

  const sourcePath = await resolvePath(handle, sessionFileName);
  const targetPath = sourcePath.replace(/\.[a-z0-9]+$/i, `.${extension}`);
  const parts = targetPath.split(/[\/\\]/).filter(Boolean);
  const fileName = parts.pop();

  let dir = handle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const stream = await fileHandle.createWritable();
  try {
    await stream.write(blob);
  } finally {
    await stream.close();
  }
  return { fileName: targetPath };
}

export async function removeRecordingArtifact(handle, sessionFileName, { extensions } = {}) {
  if (!handle) return;
  const writable = await ensureWritable(handle);
  if (!writable) return;
  const sourcePath = await resolvePath(handle, sessionFileName);
  const exts = Array.isArray(extensions) && extensions.length
    ? extensions
    : [(sourcePath.match(/\.([a-z0-9]+)$/i) || [, "webm"])[1]];

  for (const ext of exts) {
    const targetPath = sourcePath.replace(/\.[a-z0-9]+$/i, `.${ext}`);
    const parts = targetPath.split(/[\/\\]/).filter(Boolean);
    const fileName = parts.pop();
    let dir = handle;
    let ok = true;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part);
      } catch (_) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    try {
      await dir.removeEntry(fileName);
    } catch (_) {}
  }
}

export async function enumerateRecordings(handle) {
  if (!handle) return [];
  const granted = await verifyHandlePermission(handle, "read");
  if (!granted) return [];

  const out = [];
  const mp3PathsByBase = new Map();
  const txtPathsByBase = new Map();

  await walkDirectory(handle, [], async (file, segments) => {
    const name = file.name;
    const lower = name.toLowerCase();
    const dotIdx = lower.lastIndexOf(".");
    if (dotIdx < 0) return;
    const ext = lower.slice(dotIdx + 1);
    const base = name.slice(0, dotIdx);
    const baseKey = [...segments, base].join("/");
    const fullPath = [handle.name || "Tab Recorder", ...segments, name].join("/");

    if (ext === "webm") {
      const f = await file.getFile().catch(() => null);
      out.push({
        name,
        baseName: base,
        path: fullPath,
        relativePath: [...segments, name].join("/"),
        size: f ? f.size : 0,
        lastModified: f ? f.lastModified : 0
      });
    } else if (ext === "mp3") {
      mp3PathsByBase.set(baseKey, [handle.name || "Tab Recorder", ...segments, name].join("/"));
    } else if (ext === "txt") {
      txtPathsByBase.set(baseKey, [handle.name || "Tab Recorder", ...segments, name].join("/"));
    }
  });

  for (const entry of out) {
    const segments = entry.relativePath.split("/");
    segments.pop();
    const baseKey = [...segments, entry.baseName].join("/");
    entry.mp3Path = mp3PathsByBase.get(baseKey) || null;
    entry.txtPath = txtPathsByBase.get(baseKey) || null;
  }

  out.sort((a, b) => Number(b.lastModified || 0) - Number(a.lastModified || 0));
  return out;
}

async function walkDirectory(dir, segments, onFile) {
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind === "directory") {
      await walkDirectory(entry, [...segments, name], onFile);
    } else if (entry.kind === "file") {
      await onFile(entry, segments);
    }
  }
}

export async function readArtifactText(handle, fullPath) {
  if (!handle) return null;
  // fullPath includes the handle's folder name as the first segment.
  const parts = String(fullPath || "").split(/[\/\\]/).filter(Boolean);
  if (handle.name && parts[0] === handle.name) parts.shift();
  if (parts.length === 0) return null;
  const fileName = parts.pop();
  let dir = handle;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part);
  }
  const fileHandle = await dir.getFileHandle(fileName);
  const file = await fileHandle.getFile();
  return await file.text();
}

export async function probeAudioDuration(file) {
  if (!file) throw new Error("File required");

  // Decode via Web Audio. This is the same code path MP3 conversion uses,
  // so durations stay consistent across the lifecycle (and we sidestep the
  // MediaRecorder-webm/opus duration metadata bug that makes <audio>.duration
  // return Infinity until you seek past the end).
  if (typeof AudioContext === "function") {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const ctx = new AudioContext();
      try {
        const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
        const seconds = Number(audioBuffer.duration);
        if (Number.isFinite(seconds) && seconds > 0) {
          return Math.round(seconds * 1000);
        }
      } finally {
        ctx.close().catch(() => {});
      }
    } catch (_) {
      // Fall through to the <audio>-element fallback below.
    }
  }

  // Fallback: <audio> with the seek-to-end trick. Cheaper but flaky for
  // some MediaRecorder outputs.
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = document.createElement("audio");
    audio.preload = "metadata";
    let resolved = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      audio.src = "";
    };
    const finish = (ms) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(ms);
    };
    audio.onerror = () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(audio.error || new Error("Audio metadata load failed"));
    };
    audio.onloadedmetadata = () => {
      const seconds = Number(audio.duration);
      if (Number.isFinite(seconds) && seconds > 0) {
        finish(Math.round(seconds * 1000));
        return;
      }
      audio.ontimeupdate = () => {
        audio.ontimeupdate = null;
        const real = Number(audio.duration);
        finish(Number.isFinite(real) && real > 0 ? Math.round(real * 1000) : 0);
      };
      try {
        audio.currentTime = 1e9;
      } catch (_) {
        finish(0);
      }
    };
    audio.src = url;
  });
}

export async function getDurationCache() {
  try {
    const result = await chrome.storage.local.get(DURATION_CACHE_KEY);
    return result?.[DURATION_CACHE_KEY] || {};
  } catch (_) {
    return {};
  }
}

export async function setCachedDuration(fileName, durationMs) {
  if (!fileName || !Number.isFinite(durationMs) || durationMs <= 0) return;
  const cache = await getDurationCache();
  if (cache[fileName] === durationMs) return;
  cache[fileName] = durationMs;
  try {
    await chrome.storage.local.set({ [DURATION_CACHE_KEY]: cache });
  } catch (_) {}
}
