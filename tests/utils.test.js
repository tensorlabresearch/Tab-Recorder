import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  makeId,
  formatMmSs,
  notesBodyToHighlights,
  computeRms,
  formatTimestamp,
  sanitizeName,
  formatNoteTime,
  buildNotesContent,
  debounce,
  parseHtml,
  extractLinks
} from '../projects/tab-recorder-v2/lib/utils.js';

describe('makeId', () => {
  it('returns a string', () => {
    expect(typeof makeId()).toBe('string');
  });

  it('produces unique values across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => makeId()));
    expect(ids.size).toBe(50);
  });

  it('matches the expected base36-dash-base36 format', () => {
    const id = makeId();
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
  });
});

describe('formatMmSs', () => {
  it('formats 0 as 00:00', () => {
    expect(formatMmSs(0)).toBe('00:00');
  });

  it('formats 61000 ms as 01:01', () => {
    expect(formatMmSs(61000)).toBe('01:01');
  });

  it('formats 3600000 ms (1 hour) as 60:00', () => {
    expect(formatMmSs(3600000)).toBe('60:00');
  });

  it('handles null/undefined by returning 00:00', () => {
    expect(formatMmSs(null)).toBe('00:00');
    expect(formatMmSs(undefined)).toBe('00:00');
  });

  it('handles negative values by clamping to 00:00', () => {
    expect(formatMmSs(-5000)).toBe('00:00');
  });
});

describe('computeRms', () => {
  it('returns 0 for silence (all 128 values)', () => {
    const silence = new Uint8Array(256).fill(128);
    expect(computeRms(silence)).toBe(0);
  });

  it('returns > 0 for non-silence', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      data[i] = i;
    }
    expect(computeRms(data)).toBeGreaterThan(0);
  });

  it('returns 0 for empty input', () => {
    expect(computeRms(new Uint8Array(0))).toBe(0);
  });

  it('returns 0 for null/undefined', () => {
    expect(computeRms(null)).toBe(0);
    expect(computeRms(undefined)).toBe(0);
  });
});

describe('formatTimestamp', () => {
  it('formats a known date to YYYYMMDD-HHMMSS', () => {
    const date = new Date(2025, 0, 15, 9, 5, 3);
    expect(formatTimestamp(date)).toBe('20250115-090503');
  });

  it('pads single-digit months and days', () => {
    const date = new Date(2024, 2, 3, 14, 30, 59);
    expect(formatTimestamp(date)).toBe('20240303-143059');
  });
});

describe('sanitizeName', () => {
  it('strips invalid filename characters', () => {
    expect(sanitizeName('my<meeting>test')).toBe('my meeting test');
  });

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeName(long).length).toBe(80);
  });

  it('returns "meeting" for empty input', () => {
    expect(sanitizeName('')).toBe('meeting');
  });

  it('returns "meeting" for null/undefined', () => {
    expect(sanitizeName(null)).toBe('meeting');
    expect(sanitizeName(undefined)).toBe('meeting');
  });

  it('collapses multiple spaces', () => {
    expect(sanitizeName('hello   world')).toBe('hello world');
  });
});

describe('formatNoteTime', () => {
  it('formats 0 as 00:00', () => {
    expect(formatNoteTime(0)).toBe('00:00');
  });

  it('formats 61000 ms as 01:01', () => {
    expect(formatNoteTime(61000)).toBe('01:01');
  });

  it('formats 3600000 ms as 60:00', () => {
    expect(formatNoteTime(3600000)).toBe('60:00');
  });
});

describe('buildNotesContent', () => {
  it('produces expected markdown structure with no notes', () => {
    const result = buildNotesContent({
      meetingLabel: 'Standup',
      tabUrl: 'https://meet.google.com/abc',
      startedAt: 1700000000000
    });
    expect(result).toContain('# Standup');
    expect(result).toContain('- Source: https://meet.google.com/abc');
    expect(result).toContain('- Started:');
    expect(result).toContain('No notes captured.');
    expect(result).toContain('- None');
  });

  it('includes notes body when present', () => {
    const result = buildNotesContent({
      meetingLabel: 'Review',
      notesBody: 'discussed the API changes'
    });
    expect(result).toContain('discussed the API changes');
    expect(result).not.toContain('No notes captured.');
  });

  it('formats note events with timestamps', () => {
    const result = buildNotesContent({
      meetingLabel: 'Demo',
      noteEvents: [
        { atMs: 61000, kind: 'edit', chars: 42 },
        { atMs: 120000, kind: 'append-line', chars: 10 }
      ]
    });
    expect(result).toContain('[01:01] edit (42 chars)');
    expect(result).toContain('[02:00] append-line (10 chars)');
  });

  it('handles null/undefined sessionMeta gracefully', () => {
    const result = buildNotesContent(null);
    expect(result).toContain('# Untitled meeting');
  });

  it('uses tabTitle as fallback when meetingLabel is absent', () => {
    const result = buildNotesContent({ tabTitle: 'My Tab' });
    expect(result).toContain('# My Tab');
  });
});

describe('notesBodyToHighlights', () => {
  it('splits lines into highlight objects', () => {
    const result = notesBodyToHighlights('line one\nline two\nline three', []);
    expect(result).toHaveLength(3);
    expect(result[0].text).toBe('line one');
    expect(result[1].text).toBe('line two');
    expect(result[2].text).toBe('line three');
  });

  it('assigns unique IDs to each highlight', () => {
    const result = notesBodyToHighlights('a\nb\nc', []);
    const ids = new Set(result.map((h) => h.id));
    expect(ids.size).toBe(3);
  });

  it('preserves previous atMs values when available', () => {
    const prev = [
      { atMs: 5000 },
      { atMs: 10000 }
    ];
    const result = notesBodyToHighlights('first\nsecond\nthird', prev);
    expect(result[0].atMs).toBe(5000);
    expect(result[1].atMs).toBe(10000);
    expect(result[2].atMs).toBe(2000); // index * 1000
  });

  it('filters out empty/whitespace-only lines', () => {
    const result = notesBodyToHighlights('hello\n  \n\nworld', []);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('hello');
    expect(result[1].text).toBe('world');
  });

  it('returns empty array for empty input', () => {
    expect(notesBodyToHighlights('', [])).toHaveLength(0);
    expect(notesBodyToHighlights(null, [])).toHaveLength(0);
  });
});

describe('debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls callback after the delay', async () => {
    const fn = vi.fn(() => Promise.resolve());
    const debounced = debounce(fn, 100);
    debounced();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('resets the timer on repeated calls', () => {
    const fn = vi.fn(() => Promise.resolve());
    const debounced = debounce(fn, 100);
    debounced();
    vi.advanceTimersByTime(50);
    debounced();
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('does not throw when callback rejects', () => {
    const fn = vi.fn(() => Promise.reject(new Error('fail')));
    const debounced = debounce(fn, 100);
    debounced();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(fn).toHaveBeenCalledOnce();
  });
});

describe('parseHtml', () => {
  it('extracts title from HTML', () => {
    const html = '<html><head><title>My Page Title</title></head><body></body></html>';
    const result = parseHtml(html);
    expect(result.title).toBe('My Page Title');
  });

  it('extracts headings with levels', () => {
    const html = `
      <h1>Main Title</h1>
      <h2>Subtitle</h2>
      <h3>Section</h3>
    `;
    const result = parseHtml(html);
    expect(result.headings).toHaveLength(3);
    expect(result.headings[0]).toEqual({ level: 1, text: 'Main Title' });
    expect(result.headings[1]).toEqual({ level: 2, text: 'Subtitle' });
    expect(result.headings[2]).toEqual({ level: 3, text: 'Section' });
  });

  it('extracts paragraphs', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const result = parseHtml(html);
    expect(result.paragraphs).toHaveLength(2);
    expect(result.paragraphs[0]).toBe('First paragraph.');
    expect(result.paragraphs[1]).toBe('Second paragraph.');
  });

  it('extracts links with href and text', () => {
    const html = '<a href="https://example.com">Visit Example</a>';
    const result = parseHtml(html);
    expect(result.links).toHaveLength(1);
    expect(result.links[0]).toEqual({ href: 'https://example.com', text: 'Visit Example' });
  });

  it('extracts images with src and alt', () => {
    const html = '<img src="/image.png" alt="Description"><img src="/logo.svg">';
    const result = parseHtml(html);
    expect(result.images).toHaveLength(2);
    expect(result.images[0]).toEqual({ src: '/image.png', alt: 'Description' });
    expect(result.images[1]).toEqual({ src: '/logo.svg', alt: '' });
  });

  it('returns empty arrays for null input', () => {
    const result = parseHtml(null);
    expect(result.headings).toHaveLength(0);
    expect(result.paragraphs).toHaveLength(0);
    expect(result.links).toHaveLength(0);
    expect(result.images).toHaveLength(0);
  });

  it('returns empty arrays for empty string input', () => {
    const result = parseHtml('');
    expect(result.headings).toHaveLength(0);
    expect(result.paragraphs).toHaveLength(0);
  });

  it('handles HTML with nested tags in headings', () => {
    const html = '<h1>Welcome <em>visitor</em></h1>';
    const result = parseHtml(html);
    expect(result.headings[0].text).toBe('Welcome visitor');
  });

  it('filters empty paragraphs', () => {
    const html = '<p>   </p><p>Content</p>';
    const result = parseHtml(html);
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0]).toBe('Content');
  });
});

describe('extractLinks', () => {
  it('extracts absolute URLs', () => {
    const html = '<a href="https://example.com/page">Link</a>';
    const result = extractLinks(html, 'https://example.com');
    expect(result).toContain('https://example.com/page');
  });

  it('resolves relative URLs against base URL', () => {
    const html = '<a href="/path/to/page">Link</a>';
    const result = extractLinks(html, 'https://example.com');
    expect(result).toContain('https://example.com/path/to/page');
  });

  it('resolves protocol-relative URLs', () => {
    const html = '<a href="//cdn.example.com/file.js">Link</a>';
    const result = extractLinks(html, 'https://example.com');
    expect(result).toContain('https://cdn.example.com/file.js');
  });

  it('deduplicates identical links', () => {
    const html = '<a href="https://example.com">Link 1</a><a href="https://example.com">Link 2</a>';
    const result = extractLinks(html, 'https://example.com');
    expect(result).toHaveLength(1);
  });

  it('excludes non-http URLs', () => {
    const html = '<a href="mailto:test@example.com">Email</a><a href="javascript:void(0)">JS</a>';
    const result = extractLinks(html, 'https://example.com');
    expect(result).toHaveLength(0);
  });

  it('returns empty array for null input', () => {
    const result = extractLinks(null, 'https://example.com');
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty string input', () => {
    const result = extractLinks('', 'https://example.com');
    expect(result).toHaveLength(0);
  });

  it('strips URL fragments', () => {
    const html = '<a href="https://example.com/page#section">Link</a>';
    const result = extractLinks(html, 'https://example.com');
    expect(result[0]).toBe('https://example.com/page');
  });

  it('handles multiple links', () => {
    const html = `
      <a href="/page1">Page 1</a>
      <a href="/page2">Page 2</a>
      <a href="https://external.com">External</a>
    `;
    const result = extractLinks(html, 'https://example.com');
    expect(result).toHaveLength(3);
  });

  it('resolves paths relative to current directory', () => {
    const html = '<a href="subdir/page.html">Link</a>';
    const result = extractLinks(html, 'https://example.com/folder/');
    expect(result[0]).toBe('https://example.com/folder/subdir/page.html');
  });
});
