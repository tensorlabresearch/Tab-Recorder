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

/**
 * Parses HTML string and extracts structured content
 * @param {string} html - HTML string to parse
 * @returns {object} Parsed HTML structure with title, headings, paragraphs, and links
 */
export function parseHtml(html) {
  const result = {
    title: null,
    headings: [],
    paragraphs: [],
    links: [],
    images: []
  };

  if (!html || typeof html !== 'string') {
    return result;
  }

  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    result.title = titleMatch[1].replace(/\s+/g, ' ').trim();
  }

  // Extract headings (h1-h6)
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let headingMatch;
  while ((headingMatch = headingRegex.exec(html)) !== null) {
    result.headings.push({
      level: parseInt(headingMatch[1], 10),
      text: stripHtml(headingMatch[2]).trim()
    });
  }

  // Extract paragraphs
  const paraRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let paraMatch;
  while ((paraMatch = paraRegex.exec(html)) !== null) {
    const text = stripHtml(paraMatch[1]).trim();
    if (text.length > 0) {
      result.paragraphs.push(text);
    }
  }

  // Extract links with href and text
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    result.links.push({
      href: linkMatch[1].trim(),
      text: stripHtml(linkMatch[2]).trim()
    });
  }

  // Extract images with src and alt
  const imgRegex = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(html)) !== null) {
    const altMatch = imgMatch[0].match(/alt=["']([^"']*)["']/i);
    result.images.push({
      src: imgMatch[1].trim(),
      alt: altMatch ? altMatch[1] : ''
    });
  }

  return result;
}

/**
 * Strips HTML tags from content
 * @param {string} html - HTML content
 * @returns {string} Text content without tags
 */
function stripHtml(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extracts and resolves links from HTML
 * @param {string} html - HTML string
 * @param {string} baseUrl - Base URL for resolving relative URLs
 * @returns {string[]} Array of absolute URLs
 */
export function extractLinks(html, baseUrl) {
  if (!html || typeof html !== 'string') {
    return [];
  }

  const links = new Set();
  const linkRegex = /<a[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    try {
      const href = match[1].trim();
      // Skip non-HTTP schemes (mailto:, javascript:, data:, etc.)
      if (/^[a-z]+:/i.test(href) && !/^https?:/i.test(href)) {
        continue;
      }
      const resolved = resolveUrl(href, baseUrl);
      if (resolved && isHttpUrl(resolved)) {
        links.add(resolved);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  return Array.from(links);
}

/**
 * Resolves a relative URL against a base URL
 * @param {string} url - URL to resolve (may be relative)
 * @param {string} baseUrl - Base URL
 * @returns {string|null} Resolved absolute URL or null
 */
function resolveUrl(url, baseUrl) {
  if (!url || typeof url !== 'string') {
    return null;
  }

  // Already absolute
  if (url.match(/^https?:\/\//i)) {
    return normalizeUrl(url);
  }

  // Protocol-relative URL
  if (url.startsWith('//')) {
    const protocol = baseUrl.match(/^(https?:)/)?.[1] || 'https:';
    return normalizeUrl(protocol + url);
  }

  // Absolute path
  if (url.startsWith('/')) {
    const base = baseUrl.match(/^(https?:\/\/[^\/]+)/)?.[0];
    if (base) {
      return normalizeUrl(base + url);
    }
  }

  // Relative path
  try {
    const base = baseUrl.replace(/\/[^\/]*$/, '/');
    return normalizeUrl(base + url);
  } catch {
    return null;
  }
}

/**
 * Checks if URL is an HTTP(S) URL
 * @param {string} url - URL to check
 * @returns {boolean}
 */
function isHttpUrl(url) {
  return /^https?:\/\//i.test(url);
}

/**
 * Normalizes URL (removes fragments, trailing slashes, etc.)
 * @param {string} url - URL to normalize
 * @returns {string} Normalized URL
 */
function normalizeUrl(url) {
  if (!url) return url;
  return url
    .replace(/#.*$/, '') // Remove fragment
    .replace(/\/+$/, '') // Remove trailing slashes
    .replace(/\/\.\/+/g, '/'); // Simplify ./ paths
}
