// Formatters that turn the output of diarize() into the two sidecar
// files persisted next to a recording's plain transcript:
//   *.diarized.txt   — human-readable markdown-ish transcript with
//                      "Speaker N:" labels and [HH:MM:SS] timestamps.
//   *.diarized.json  — machine-readable utterances array with speakerId
//                      per entry, for downstream consumption.

export function formatDiarizedText(utterances, opts = {}) {
  const speakerLabel = opts.speakerLabel || defaultSpeakerLabel;
  const safe = Array.isArray(utterances) ? utterances : [];
  const lines = [];
  let prevSpeaker = null;
  for (const u of safe) {
    if (!u) continue;
    const label = speakerLabel(u.speakerId);
    if (label !== prevSpeaker) {
      if (prevSpeaker !== null) lines.push("");
      lines.push(`${label}:`);
      prevSpeaker = label;
    }
    const ts = formatTimecode(u.startSec);
    lines.push(`[${ts}] ${String(u.text || "").trim()}`);
  }
  return lines.join("\n");
}

export function formatDiarizedJson(utterances, speakerCount, meta = {}) {
  const safe = Array.isArray(utterances) ? utterances : [];
  return JSON.stringify(
    {
      version: 1,
      speakerCount: Number(speakerCount) || 0,
      ...meta,
      utterances: safe.map((u) => ({
        startSec: round3(u?.startSec),
        endSec: round3(u?.endSec),
        speakerId: Number.isFinite(u?.speakerId) ? u.speakerId : 0,
        text: String(u?.text || "").trim()
      }))
    },
    null,
    2
  );
}

export function defaultSpeakerLabel(id) {
  const n = Number.isFinite(id) ? id : 0;
  return `Speaker ${n + 1}`;
}

export function formatTimecode(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function round3(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000) / 1000;
}
