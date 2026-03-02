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
  debounce
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
