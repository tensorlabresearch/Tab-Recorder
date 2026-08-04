/**
 * CEL-like filter expression parser for recordings.
 *
 * Supported expressions:
 *   title.contains("text")              — case-insensitive substring on title/description
 *   title.matches("regex")              — case-insensitive regex on title/description
 *   transcript.contains("text")         — case-insensitive substring on transcript
 *   transcript.matches("regex")         — case-insensitive regex on transcript
 *   summary.contains("text")            — case-insensitive substring on summary description
 *   summary.matches("regex")            — case-insensitive regex on summary description
 *   date.after("YYYY-MM-DD")            — startedAt strictly after midnight of that day
 *   date.before("YYYY-MM-DD")           — startedAt strictly before midnight of that day
 *   date.range("start","end")           — startedAt within [start, end) (end exclusive)
 *   has("transcript")                   — session has a transcript
 *   has("mp3")                          — session has an MP3
 *   has("summary")                      — session has a summary
 *   has("tag")                          — session has at least one tag
 *   tag("name")                         — session has the exact tag (case-insensitive);
 *                                         multiple args are OR'd: tag("a","b")
 *   tags.contains("text")               — case-insensitive substring over tags
 *   tags.matches("regex")               — case-insensitive regex over tags
 *
 * Combine with && (AND) and || (OR), and parentheses for grouping.
 * Plain text with no CEL operators falls back to substring match on
 * title/description/transcript (backward compatible).
 */

/**
 * @typedef {Object} SessionLike
 * @property {string} [meetingLabel]
 * @property {string} [tabTitle]
 * @property {string} [description]
 * @property {string} [transcriptText]
 * @property {string|number} [startedAt]
 * @property {boolean} [_fsHasMp3]
 * @property {string} [_fsMp3Path]
 * @property {string} [_fsTxtPath]
 * @property {string} [_fsDiarizedTxtPath]
 * @property {string[]} [tags]
 */

// ── Tokenizer ─────────────────────────────────────────────

/**
 * @typedef {{type: string, value: string}} Token
 */

/**
 * @param {string} input
 * @returns {Token[]}
 */
function tokenize(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") { i++; continue; }
    if (ch === "(" ) { tokens.push({ type: "LPAREN", value: ch }); i++; continue; }
    if (ch === ")" ) { tokens.push({ type: "RPAREN", value: ch }); i++; continue; }
    if (ch === "," ) { tokens.push({ type: "COMMA",  value: ch }); i++; continue; }
    if (ch === "&" && input[i + 1] === "&") { tokens.push({ type: "AND", value: "&&" }); i += 2; continue; }
    if (ch === "|" && input[i + 1] === "|") { tokens.push({ type: "OR",  value: "||" }); i += 2; continue; }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = "";
      i++;
      while (i < input.length && input[i] !== quote) {
        if (input[i] === "\\" && i + 1 < input.length) { str += input[i + 1]; i += 2; }
        else { str += input[i]; i++; }
      }
      i++;
      tokens.push({ type: "STRING", value: str });
      continue;
    }
    let ident = "";
    while (i < input.length && /[a-zA-Z0-9_.\-]/.test(input[i])) { ident += input[i]; i++; }
    if (ident) { tokens.push({ type: "IDENT", value: ident }); continue; }
    i++;
  }
  return tokens;
}

// ── Parser (recursive descent) ────────────────────────────

/**
 * @typedef {Object} AstNode
 * @property {string} type
 * @property {*} [value]
 * @property {AstNode} [left]
 * @property {AstNode} [right]
 * @property {AstNode[]} [args]
 * @property {string} [field]
 * @property {string} [op]
 * @property {string} [arg]
 */

function parse(tokens) {
  if (tokens.length === 0) return null;
  let pos = 0;

  function peek() { return tokens[pos]; }
  function next()  { return tokens[pos++]; }
  function expect(type) {
    const t = next();
    if (!t || t.type !== type) throw new Error(`Expected ${type} but got ${t ? t.type : "EOF"}`);
    return t;
  }

  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === "OR") {
      next();
      const right = parseAnd();
      left = { type: "OR", left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseUnary();
    while (peek() && peek().type === "AND") {
      next();
      const right = parseUnary();
      left = { type: "AND", left, right };
    }
    return left;
  }

  function parseUnary() {
    const t = peek();
    if (!t) throw new Error("Unexpected end of input");
    if (t.type === "LPAREN") {
      next();
      const node = parseOr();
      expect("RPAREN");
      return node;
    }
    return parseCall();
  }

  function parseCall() {
    const ident = next();
    if (!ident || ident.type !== "IDENT") throw new Error(`Expected identifier but got ${ident ? ident.type : "EOF"}`);
    const parts = ident.value.split(".");

    if (peek() && peek().type === "LPAREN") {
      next();
      const args = [];
      if (peek() && peek().type !== "RPAREN") {
        args.push(parseArg());
        while (peek() && peek().type === "COMMA") { next(); args.push(parseArg()); }
      }
      expect("RPAREN");
      return { type: "CALL", field: parts[0], op: parts[1] || "", args };
    }

    return { type: "IDENT", value: ident.value };
  }

  function parseArg() {
    const t = next();
    if (!t) throw new Error("Expected argument");
    if (t.type === "STRING") return { type: "STRING", value: t.value };
    if (t.type === "IDENT")  return { type: "IDENT",  value: t.value };
    throw new Error(`Expected string or ident argument but got ${t.type}`);
  }

  return parseOr();
}

// ── Evaluator ─────────────────────────────────────────────

/**
 * @param {Date|string} input
 * @returns {number|null} epoch ms at midnight local, or null
 */
function parseDateToMs(input) {
  if (input instanceof Date) return input.getTime();
  if (typeof input !== "string") return null;
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (Number.isNaN(d.getTime())) return null;
  return d.getTime();
}

/**
 * @param {AstNode} node
 * @param {SessionLike} session
 * @returns {boolean}
 */
function evaluate(node, session) {
  if (!node) return true;

  if (node.type === "OR")  return evaluate(node.left, session) || evaluate(node.right, session);
  if (node.type === "AND") return evaluate(node.left, session) && evaluate(node.right, session);

  if (node.type === "CALL") {
    return evaluateCall(node, session);
  }

  if (node.type === "IDENT") {
    return plainMatch(node.value, session);
  }

  return false;
}

/**
 * @param {AstNode} node
 * @param {SessionLike} session
 * @returns {boolean}
 */
function evaluateCall(node, session) {
  const { field, op, args } = node;
  const arg0 = args[0]?.value ?? "";

  if (field === "title") {
    const titleText = [session.meetingLabel, session.tabTitle, session.description]
      .filter(Boolean).join(" ").toLowerCase();
    if (op === "contains") return titleText.includes(String(arg0).toLowerCase());
    if (op === "matches") {
      try { return new RegExp(arg0, "i").test(titleText); }
      catch (_) { return false; }
    }
    return false;
  }

  if (field === "transcript") {
    const text = String(session.transcriptText || "").toLowerCase();
    if (op === "contains") return text.includes(String(arg0).toLowerCase());
    if (op === "matches") {
      try { return new RegExp(arg0, "i").test(text); }
      catch (_) { return false; }
    }
    return false;
  }

  if (field === "summary") {
    const text = String(session.description || "").toLowerCase();
    if (op === "contains") return text.includes(String(arg0).toLowerCase());
    if (op === "matches") {
      try { return new RegExp(arg0, "i").test(text); }
      catch (_) { return false; }
    }
    return false;
  }

  if (field === "date") {
    const ts = Number(session.startedAt || 0);
    if (op === "after")  { const d = parseDateToMs(String(arg0)); return d !== null && ts >= d + 86400000; }
    if (op === "before") { const d = parseDateToMs(String(arg0)); return d !== null && ts < d; }
    if (op === "range")  {
      const start = parseDateToMs(String(arg0));
      const end   = parseDateToMs(String(args[1]?.value ?? ""));
      if (start === null || end === null) return false;
      return ts >= start && ts < end + 86400000;
    }
    return false;
  }

  if (field === "has") {
    if (arg0 === "transcript") return !!(session.transcriptText || session._fsTxtPath || session._fsDiarizedTxtPath);
    if (arg0 === "mp3")        return !!(session._fsHasMp3 || session._fsMp3Path);
    if (arg0 === "summary")    return !!(session._fsSummaryPath || session.description);
    if (arg0 === "tag")        return Array.isArray(session.tags) && session.tags.length > 0;
    return false;
  }

  if (field === "tag") {
    const sessionTags = Array.isArray(session.tags) ? session.tags : [];
    const lowered = sessionTags.map((t) => String(t).toLowerCase());
    if (args.length === 0) return sessionTags.length > 0;
    return args.some((a) => lowered.includes(String(a?.value ?? "").toLowerCase()));
  }

  if (field === "tags") {
    const text = (Array.isArray(session.tags) ? session.tags : []).join(" ").toLowerCase();
    if (op === "contains") return text.includes(String(arg0).toLowerCase());
    if (op === "matches") {
      try { return new RegExp(arg0, "i").test(text); }
      catch (_) { return false; }
    }
    return false;
  }

  return false;
}

/**
 * @param {string} text
 * @param {SessionLike} session
 * @returns {boolean}
 */
function plainMatch(text, session) {
  const q = text.toLowerCase();
  const blob = [
    session.meetingLabel,
    session.tabTitle,
    session.description,
    session.transcriptText,
  ].filter(Boolean).join(" ").toLowerCase();
  return blob.includes(q);
}

// ── Public API ────────────────────────────────────────────

const CEL_PATTERN = /^\s*\(?\s*(title|transcript|summary|date|has|tag|tags)\s*[.(]/;

/**
 * Returns true if the input looks like a CEL expression (vs plain text).
 * @param {string} input
 * @returns {boolean}
 */
export function isCelExpression(input) {
  return CEL_PATTERN.test(input.trim());
}

/**
 * Parse a filter expression into an AST. Returns null for empty input.
 * Throws on malformed CEL. Returns null for plain text (non-CEL).
 * @param {string} input
 * @returns {AstNode|null}
 */
export function parseFilterExpression(input) {
  if (!input || !input.trim()) return null;
  if (!isCelExpression(input)) return null;
  const tokens = tokenize(input);
  return parse(tokens);
}

/**
 * Compile a filter expression into a predicate function.
 * For plain text, returns a substring-match predicate.
 * For CEL, returns a predicate that evaluates the AST.
 * For invalid CEL, returns a predicate that matches nothing.
 * @param {string} input
 * @returns {(session: SessionLike) => boolean}
 */
export function compileFilter(input) {
  const trimmed = (input || "").trim();
  if (!trimmed) return () => true;

  if (!isCelExpression(trimmed)) {
    const q = trimmed.toLowerCase();
    return (session) => {
      const blob = [
        session?.meetingLabel,
        session?.tabTitle,
        session?.description,
        session?.transcriptText,
      ].filter(Boolean).join(" ").toLowerCase();
      return blob.includes(q);
    };
  }

  let ast;
  try { ast = parseFilterExpression(trimmed); }
  catch (_) { return () => false; }
  if (!ast) return () => true;
  return (session) => {
    try { return evaluate(ast, session); }
    catch (_) { return false; }
  };
}
