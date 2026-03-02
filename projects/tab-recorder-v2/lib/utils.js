export function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatMmSs(atMs) {
  const total = Math.max(0, Math.floor(Number(atMs || 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function notesBodyToHighlights(notesBody, previousHighlights) {
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

export function computeRms(byteData) {
  if (!byteData?.length) return 0;
  let sum = 0;
  for (let i = 0; i < byteData.length; i += 1) {
    const centered = (byteData[i] - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / byteData.length);
}

export function formatTimestamp(date) {
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

export function sanitizeName(value) {
  const cleaned = String(value || "meeting")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || "meeting";
}

export function formatNoteTime(atMs) {
  const total = Math.max(0, Math.floor(atMs / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function buildNotesContent(sessionMeta) {
  const label = sessionMeta?.meetingLabel || sessionMeta?.tabTitle || "Untitled meeting";
  const tabUrl = sessionMeta?.tabUrl || "";
  const startedAt = sessionMeta?.startedAt ? new Date(sessionMeta.startedAt).toISOString() : "";
  const notesBody = String(sessionMeta?.notesBody || "");
  const noteEvents = Array.isArray(sessionMeta?.noteEvents) ? sessionMeta.noteEvents : [];
  const lines = [
    `# ${label}`,
    "",
    `- Source: ${tabUrl || "N/A"}`,
    `- Started: ${startedAt || "N/A"}`,
    "",
    "## Notes",
    notesBody.trim() || "No notes captured.",
    "",
    "## Note Events",
    ""
  ];

  if (!noteEvents.length) {
    lines.push("- None");
  } else {
    for (const item of noteEvents) {
      const kind = String(item.kind || "edit");
      const chars = Number(item.chars || 0);
      lines.push(`- [${formatNoteTime(item.atMs || 0)}] ${kind} (${chars} chars)`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function debounce(callback, delayMs) {
  let timer = null;
  return function debounced() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => callback().catch(() => {}), delayMs);
  };
}
