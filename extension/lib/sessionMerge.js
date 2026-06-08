export function pathKey(fileName) {
  if (!fileName) return null;
  return String(fileName).replace(/^Tab Recorder[\\/]/, "").toLowerCase();
}

export function synthesizeSessionFromFs(fsFile) {
  const rawBase = String(fsFile?.baseName || "")
    .replace(/_\d{2}-\d{2}$/, "");
  // Folder names derived from the default timestamp label collapse to the
  // shape "YYYY-MM-DD-HHMM" on disk. Restore them to "YYYY-MM-DD HH:MM"
  // instead of mangling every dash into a space.
  const tsMatch = rawBase.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})$/);
  const baseLabel = tsMatch
    ? `${tsMatch[1]} ${tsMatch[2]}:${tsMatch[3]}`
    : rawBase.replace(/[-_]/g, " ").trim() || "Recording";
  // durationMs / startedAt come from the on-disk .meta.json sidecar when present
  // (written by whichever browser last knew the duration), making the duration
  // visible even in a browser that never recorded this file.
  const durationMs = Number(fsFile?.durationMs) > 0 ? Math.round(Number(fsFile.durationMs)) : 0;
  const startedAt = Number(fsFile?.startedAt) > 0
    ? Number(fsFile.startedAt)
    : (fsFile?.lastModified || Date.now());
  return {
    id: `fs-${String(fsFile?.path || "").replace(/[^a-z0-9]/gi, "")}`,
    meetingLabel: baseLabel,
    tabTitle: baseLabel,
    startedAt,
    endedAt: startedAt + durationMs,
    durationMs,
    fileName: fsFile?.path,
    downloadId: null,
    audioFormat: "webm",
    audioMimeType: "audio/webm",
    transcriptText: "",
    transcriptWords: [],
    mp3DownloadId: null,
    mp3FileName: fsFile?.mp3Path || "",
    _fsTxtPath: fsFile?.txtPath || null,
    _fsSummaryPath: fsFile?.summaryPath || null,
    _fsSegmentsJsonPath: fsFile?.segmentsJsonPath || null,
    _fsDiarizedTxtPath: fsFile?.diarizedTxtPath || null,
    _fsDiarizedJsonPath: fsFile?.diarizedJsonPath || null,
    description: fsFile?.description || ""
  };
}

/**
 * Merge three sources of recording records into a single sorted list.
 *
 * Precedence by relative file path (case-folded, "Tab Recorder/" prefix stripped):
 *   stored > download orphan > FS scan
 *
 * When the same file is found in stored AND in the FS scan, the stored record
 * is augmented (mp3FileName, _fsTxtPath, startedAt fallback) but never
 * overwritten.
 *
 * @param {Array} stored
 * @param {Array} downloadOrphans
 * @param {Array} fsFiles
 * @returns {Array} sorted newest-first
 */
export function mergeSessionSources(stored = [], downloadOrphans = [], fsFiles = []) {
  const map = new Map();

  for (const s of stored) {
    const k = pathKey(s?.fileName);
    if (!k) continue;
    map.set(k, { ...s });
  }

  for (const orphan of downloadOrphans) {
    const k = pathKey(orphan?.fileName);
    if (!k || map.has(k)) continue;
    map.set(k, { ...orphan });
  }

  for (const fsFile of fsFiles) {
    const k = pathKey(fsFile?.path);
    if (!k) continue;
    if (map.has(k)) {
      const existing = map.get(k);
      existing._fsHasMeta = !!fsFile.hasMeta;
      if (Number(fsFile.durationMs) > 0 && !(Number(existing.durationMs) > 0)) {
        existing.durationMs = Math.round(Number(fsFile.durationMs));
        if (!(Number(existing.endedAt) > 0) && Number(existing.startedAt) > 0) {
          existing.endedAt = Number(existing.startedAt) + existing.durationMs;
        }
      }
      if (fsFile.mp3Path && !existing.mp3FileName) existing.mp3FileName = fsFile.mp3Path;
      if (fsFile.txtPath && !existing.transcriptText) existing._fsTxtPath = fsFile.txtPath;
      if (fsFile.summaryPath) existing._fsSummaryPath = fsFile.summaryPath;
      if (fsFile.segmentsJsonPath) existing._fsSegmentsJsonPath = fsFile.segmentsJsonPath;
      if (fsFile.diarizedTxtPath) existing._fsDiarizedTxtPath = fsFile.diarizedTxtPath;
      if (fsFile.diarizedJsonPath) existing._fsDiarizedJsonPath = fsFile.diarizedJsonPath;
      if (fsFile.description && !existing.description) existing.description = fsFile.description;
      if (fsFile.lastModified && !existing.startedAt) existing.startedAt = fsFile.lastModified;
      continue;
    }
    map.set(k, synthesizeSessionFromFs(fsFile));
  }

  return Array.from(map.values()).sort(
    (a, b) => Number(b?.startedAt || 0) - Number(a?.startedAt || 0)
  );
}
