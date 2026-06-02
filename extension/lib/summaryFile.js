// Read/write the .summary.md sidecar that lives next to each
// recording. Format: YAML frontmatter (a small key/value subset) +
// markdown body. We deliberately don't take a YAML dependency; the
// frontmatter only carries scalar string values produced by us, so a
// minimal hand-rolled serializer is enough.

const FRONTMATTER_FENCE = "---";

const FIELDS = ["description", "generated-at", "model"];

function escapeScalar(value) {
  const s = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
  // Double-quote if the value contains characters YAML treats as special
  // at the start, or a colon followed by space (which would be parsed as
  // a nested mapping). Otherwise emit bare.
  if (!s) return '""';
  if (/^[!&*?|>%@`]/.test(s) || /:\s/.test(s) || /["#]/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

function unescapeScalar(raw) {
  const s = String(raw ?? "").trim();
  if (s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return s;
}

// Serialize {description, summary, model, generatedAt} → markdown text.
// `summary` is treated as the body verbatim (already markdown). Missing
// fields are written as empty strings so the sidecar is self-describing.
export function serializeSummary({ description, summary, model, generatedAt } = {}) {
  const ts = generatedAt instanceof Date
    ? generatedAt.toISOString()
    : String(generatedAt || new Date().toISOString());
  const fm = [
    FRONTMATTER_FENCE,
    `description: ${escapeScalar(description)}`,
    `generated-at: ${escapeScalar(ts)}`,
    `model: ${escapeScalar(model || "")}`,
    FRONTMATTER_FENCE,
    "",
  ].join("\n");
  if (!summary) return fm;
  return fm + "\n" + String(summary).trim() + "\n";
}

// Parse a sidecar's text into {description, summary, model, generatedAt}.
// Tolerant: missing frontmatter returns the input as the summary body
// with empty metadata.
export function parseSummary(text) {
  const src = String(text || "");
  const empty = { description: "", summary: "", model: "", generatedAt: "" };
  if (!src.trim()) return empty;

  const lines = src.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { ...empty, summary: src.trim() };
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < 0) {
    return { ...empty, summary: src.trim() };
  }

  const meta = { description: "", generatedAt: "", model: "" };
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const val = unescapeScalar(line.slice(colon + 1));
    if (!FIELDS.includes(key)) continue;
    if (key === "generated-at") meta.generatedAt = val;
    else meta[key] = val;
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { ...empty, ...meta, summary: body };
}

// Convenience: derive the sidecar path for a recording webm path.
// Used by the panel layer; kept here so the convention lives in one place.
export function summaryPathFor(recordingBasename) {
  return `${recordingBasename}.summary.md`;
}
