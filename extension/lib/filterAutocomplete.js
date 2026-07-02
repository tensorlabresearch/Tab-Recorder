/**
 * Autocomplete context engine for the CEL filter input.
 *
 * Given the current text and cursor position, determines what kind of
 * suggestion to show (field name, operator, date argument) and returns
 * the relevant suggestions plus the text range to replace.
 */

export const FIELD_SUGGESTIONS = [
  { label: "title",      insert: "title.",      detail: "Match on recording title or description" },
  { label: "transcript", insert: "transcript.", detail: "Match on transcript text" },
  { label: "summary",    insert: "summary.",    detail: "Match on AI summary description" },
  { label: "date",       insert: "date.",       detail: "Filter by recording date" },
  { label: "has",        insert: 'has("',       detail: "Filter by artifact presence (transcript, mp3, summary)" },
];

export const OPERATOR_SUGGESTIONS = {
  title: [
    { label: "contains", insert: 'contains("', detail: "Case-insensitive substring match" },
    { label: "matches",  insert: 'matches("',  detail: "Case-insensitive regex match" },
  ],
  transcript: [
    { label: "contains", insert: 'contains("', detail: "Case-insensitive substring match" },
    { label: "matches",  insert: 'matches("',  detail: "Case-insensitive regex match" },
  ],
  summary: [
    { label: "contains", insert: 'contains("', detail: "Case-insensitive substring match on summary" },
    { label: "matches",  insert: 'matches("',  detail: "Case-insensitive regex match on summary" },
  ],
  date: [
    { label: "after",  insert: 'after("',  detail: "Recordings strictly after this date" },
    { label: "before", insert: 'before("', detail: "Recordings strictly before this date" },
    { label: "range",  insert: 'range("',  detail: "Date range (start, end)" },
  ],
  has: [
    { label: "transcript", insert: 'transcript")', detail: "Has a transcript" },
    { label: "mp3",        insert: 'mp3")',        detail: "Has an MP3" },
  ],
};

export const HAS_VALUE_SUGGESTIONS = [
  { label: "transcript", insert: 'transcript")', detail: "Has a transcript" },
  { label: "mp3",        insert: 'mp3")',        detail: "Has an MP3" },
  { label: "summary",    insert: 'summary")',    detail: "Has a summary" },
];

/**
 * @typedef {Object} AutocompleteContext
 * @property {string} phase      - "field" | "operator" | "value" | "date" | "none"
 * @property {Array}  suggestions - Array of {label, insert, detail}
 * @property {number} replaceStart - Start index of text to replace
 * @property {number} replaceEnd   - End index of text to replace
 * @property {string} field        - Current field name (for operator/value phase)
 */

/**
 * Analyze the filter input at the given cursor position and return
 * autocomplete context.
 *
 * @param {string} text - Full filter input text
 * @param {number} cursorPos - Cursor position (0-based index into text)
 * @returns {AutocompleteContext|null}
 */
export function getAutocompleteContext(text, cursorPos) {
  if (cursorPos < 0 || cursorPos > text.length) return null;

  const before = text.slice(0, cursorPos);

  if (isInDateArgument(before)) {
    return {
      phase: "date",
      suggestions: [],
      replaceStart: findArgStart(before),
      replaceEnd: cursorPos,
      field: "date",
    };
  }

  const fieldMatch = before.match(/(title|transcript|summary|date|has)\s*\.\s*([a-zA-Z]*)$/);
  if (fieldMatch) {
    const field = fieldMatch[1];
    const typed = fieldMatch[2];
    const ops = OPERATOR_SUGGESTIONS[field] || [];
    const filtered = typed ? ops.filter((o) => o.label.startsWith(typed)) : ops;
    const dotIndex = before.lastIndexOf(".");
    return {
      phase: "operator",
      suggestions: filtered,
      replaceStart: dotIndex + 1,
      replaceEnd: cursorPos,
      field,
    };
  }

  const hasOpenMatch = before.match(/has\s*\(\s*"([a-zA-Z]*)$/);
  if (hasOpenMatch) {
    const typed = hasOpenMatch[1];
    const filtered = typed ? HAS_VALUE_SUGGESTIONS.filter((s) => s.label.startsWith(typed)) : HAS_VALUE_SUGGESTIONS;
    const quoteIndex = before.lastIndexOf('"');
    return {
      phase: "value",
      suggestions: filtered,
      replaceStart: quoteIndex + 1,
      replaceEnd: cursorPos,
      field: "has",
    };
  }

  const fieldStartMatch = before.match(/(^|\(|\|\||&&)\s*([a-zA-Z]*)$/);
  if (fieldStartMatch) {
    const typed = fieldStartMatch[2];
    const filtered = typed
      ? FIELD_SUGGESTIONS.filter((f) => f.label.startsWith(typed))
      : FIELD_SUGGESTIONS;
    const replaceStart = cursorPos - typed.length;
    return {
      phase: "field",
      suggestions: filtered,
      replaceStart,
      replaceEnd: cursorPos,
      field: "",
    };
  }

  return { phase: "none", suggestions: [], replaceStart: cursorPos, replaceEnd: cursorPos, field: "" };
}

function isInDateArgument(before) {
  const dateCallMatch = before.match(/date\.\s*(after|before|range)\s*\(\s*"/);
  if (!dateCallMatch) return false;

  const callStart = before.lastIndexOf("date.");
  const afterCallStart = before.slice(callStart);
  const closeParens = (afterCallStart.match(/\)/g) || []).length;
  const openParens = (afterCallStart.match(/\(/g) || []).length;
  if (closeParens >= openParens) return false;

  const lastQuote = before.lastIndexOf('"');
  if (lastQuote === -1) return false;
  const afterQuote = before.slice(lastQuote + 1);
  if (afterQuote.includes(')')) return false;

  return true;
}

function findArgStart(before) {
  const lastQuote = before.lastIndexOf('"');
  if (lastQuote >= 0) return lastQuote + 1;
  return before.length;
}

/**
 * Apply a suggestion to the text at the given position.
 *
 * @param {string} text - Full text
 * @param {number} replaceStart - Start of replacement
 * @param {number} replaceEnd - End of replacement
 * @param {string} insertText - Text to insert
 * @returns {{text: string, cursorPos: number}}
 */
export function applySuggestion(text, replaceStart, replaceEnd, insertText) {
  const newText = text.slice(0, replaceStart) + insertText + text.slice(replaceEnd);
  return { text: newText, cursorPos: replaceStart + insertText.length };
}
