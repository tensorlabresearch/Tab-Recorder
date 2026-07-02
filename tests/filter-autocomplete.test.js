import { describe, it, expect } from "vitest";
import {
  getAutocompleteContext,
  applySuggestion,
  FIELD_SUGGESTIONS,
  OPERATOR_SUGGESTIONS,
} from "../extension/lib/filterAutocomplete.js";

describe("FIELD_SUGGESTIONS", () => {
  it("includes title, transcript, date, has", () => {
    const labels = FIELD_SUGGESTIONS.map((f) => f.label);
    expect(labels).toContain("title");
    expect(labels).toContain("transcript");
    expect(labels).toContain("date");
    expect(labels).toContain("has");
  });
});

describe("getAutocompleteContext - field phase", () => {
  it("returns field suggestions at start of empty input", () => {
    const ctx = getAutocompleteContext("", 0);
    expect(ctx.phase).toBe("field");
    expect(ctx.suggestions.length).toBe(5);
    expect(ctx.replaceStart).toBe(0);
    expect(ctx.replaceEnd).toBe(0);
  });

  it("filters field suggestions by typed prefix", () => {
    const ctx = getAutocompleteContext("ti", 2);
    expect(ctx.phase).toBe("field");
    expect(ctx.suggestions.length).toBe(1);
    expect(ctx.suggestions[0].label).toBe("title");
  });

  it("returns field suggestions after && operator", () => {
    const ctx = getAutocompleteContext('title.contains("test") && ', 26);
    expect(ctx.phase).toBe("field");
    expect(ctx.suggestions.length).toBe(5);
  });

  it("returns field suggestions after || operator", () => {
    const ctx = getAutocompleteContext('title.contains("a") || ', 23);
    expect(ctx.phase).toBe("field");
    expect(ctx.suggestions.length).toBe(5);
  });

  it("returns field suggestions after opening paren", () => {
    const ctx = getAutocompleteContext("(", 1);
    expect(ctx.phase).toBe("field");
    expect(ctx.suggestions.length).toBe(5);
  });

  it("returns none for mid-value position", () => {
    const ctx = getAutocompleteContext('title.contains("hel', 19);
    expect(ctx.phase).not.toBe("field");
  });
});

describe("getAutocompleteContext - operator phase", () => {
  it("returns operator suggestions after title.", () => {
    const ctx = getAutocompleteContext("title.", 6);
    expect(ctx.phase).toBe("operator");
    expect(ctx.field).toBe("title");
    expect(ctx.suggestions.length).toBe(2);
    expect(ctx.suggestions[0].label).toBe("contains");
    expect(ctx.suggestions[1].label).toBe("matches");
  });

  it("returns operator suggestions after transcript.", () => {
    const ctx = getAutocompleteContext("transcript.", 11);
    expect(ctx.phase).toBe("operator");
    expect(ctx.field).toBe("transcript");
    expect(ctx.suggestions.length).toBe(2);
  });

  it("returns operator suggestions after date.", () => {
    const ctx = getAutocompleteContext("date.", 5);
    expect(ctx.phase).toBe("operator");
    expect(ctx.field).toBe("date");
    expect(ctx.suggestions.length).toBe(3);
    const labels = ctx.suggestions.map((s) => s.label);
    expect(labels).toContain("after");
    expect(labels).toContain("before");
    expect(labels).toContain("range");
  });

  it("filters operators by typed prefix", () => {
    const ctx = getAutocompleteContext("date.af", 7);
    expect(ctx.phase).toBe("operator");
    expect(ctx.suggestions.length).toBe(1);
    expect(ctx.suggestions[0].label).toBe("after");
  });

  it("handles spaces around the dot", () => {
    const ctx = getAutocompleteContext("title . ", 8);
    expect(ctx.phase).toBe("operator");
  });
});

describe("getAutocompleteContext - has value phase", () => {
  it("returns value suggestions after has(\"", () => {
    const ctx = getAutocompleteContext('has("', 5);
    expect(ctx.phase).toBe("value");
    expect(ctx.field).toBe("has");
    expect(ctx.suggestions.length).toBe(3);
    expect(ctx.suggestions[0].label).toBe("transcript");
    expect(ctx.suggestions[1].label).toBe("mp3");
    expect(ctx.suggestions[2].label).toBe("summary");
  });

  it("filters value suggestions by typed prefix", () => {
    const ctx = getAutocompleteContext('has("tr', 7);
    expect(ctx.phase).toBe("value");
    expect(ctx.suggestions.length).toBe(1);
    expect(ctx.suggestions[0].label).toBe("transcript");
  });
});

describe("getAutocompleteContext - date phase", () => {
  it("detects cursor inside date.after argument", () => {
    const ctx = getAutocompleteContext('date.after("', 12);
    expect(ctx.phase).toBe("date");
    expect(ctx.field).toBe("date");
  });

  it("detects cursor inside date.before argument", () => {
    const ctx = getAutocompleteContext('date.before("2026', 17);
    expect(ctx.phase).toBe("date");
  });

  it("detects cursor inside date.range first argument", () => {
    const ctx = getAutocompleteContext('date.range("2026-01', 18);
    expect(ctx.phase).toBe("date");
  });

  it("does not trigger date phase after closing paren", () => {
    const ctx = getAutocompleteContext('date.after("2026-01-01") ', 25);
    expect(ctx.phase).not.toBe("date");
  });

  it("does not trigger date phase for title.contains", () => {
    const ctx = getAutocompleteContext('title.contains("2026', 20);
    expect(ctx.phase).not.toBe("date");
  });
});

describe("getAutocompleteContext - none phase", () => {
  it("returns none for plain text mid-word", () => {
    const ctx = getAutocompleteContext("standup meeting", 10);
    expect(ctx.phase).toBe("none");
  });

  it("returns none after closing paren of complete expression", () => {
    const ctx = getAutocompleteContext('title.contains("test")) ', 22);
    expect(ctx.phase).not.toBe("field");
  });

  it("returns null for invalid cursor position", () => {
    expect(getAutocompleteContext("test", -1)).toBeNull();
    expect(getAutocompleteContext("test", 100)).toBeNull();
  });
});

describe("applySuggestion", () => {
  it("inserts text at replacement range", () => {
    const result = applySuggestion("title.", 6, 6, 'contains("');
    expect(result.text).toBe('title.contains("');
    expect(result.cursorPos).toBe('title.contains("'.length);
  });

  it("replaces typed prefix", () => {
    const result = applySuggestion("ti", 0, 2, "title.");
    expect(result.text).toBe("title.");
    expect(result.cursorPos).toBe(6);
  });

  it("replaces operator prefix", () => {
    const result = applySuggestion("date.af", 5, 7, 'after("');
    expect(result.text).toBe('date.after("');
    expect(result.cursorPos).toBe('date.after("'.length);
  });
});

describe("OPERATOR_SUGGESTIONS", () => {
  it("has operators for title", () => {
    expect(OPERATOR_SUGGESTIONS.title).toBeDefined();
    expect(OPERATOR_SUGGESTIONS.title.length).toBe(2);
  });

  it("has operators for date", () => {
    expect(OPERATOR_SUGGESTIONS.date).toBeDefined();
    expect(OPERATOR_SUGGESTIONS.date.length).toBe(3);
  });

  it("has operators for has", () => {
    expect(OPERATOR_SUGGESTIONS.has).toBeDefined();
    expect(OPERATOR_SUGGESTIONS.has.length).toBe(2);
  });
});
