import { describe, it, expect } from "vitest";
import {
  isCelExpression,
  parseFilterExpression,
  compileFilter,
} from "../extension/lib/filterExpression.js";

function makeSession(overrides = {}) {
  return {
    id: "test-1",
    meetingLabel: "Weekly Standup",
    tabTitle: "Google Meet - standup room",
    description: "Team sync meeting",
    transcriptText: "Hello everyone, let's start the standup.",
    startedAt: new Date(2026, 5, 15, 10, 0, 0).getTime(),
    ...overrides,
  };
}

describe("isCelExpression", () => {
  it("returns false for plain text", () => {
    expect(isCelExpression("standup")).toBe(false);
    expect(isCelExpression("hello world")).toBe(false);
  });

  it("returns true for title.* expressions", () => {
    expect(isCelExpression('title.contains("foo")')).toBe(true);
    expect(isCelExpression('title.matches("foo.*")')).toBe(true);
  });

  it("returns true for transcript.* expressions", () => {
    expect(isCelExpression('transcript.contains("foo")')).toBe(true);
  });

  it("returns true for date.* expressions", () => {
    expect(isCelExpression('date.after("2026-01-01")')).toBe(true);
    expect(isCelExpression('date.before("2026-01-01")')).toBe(true);
    expect(isCelExpression('date.range("2026-01-01","2026-01-31")')).toBe(true);
  });

  it("returns true for summary.* expressions", () => {
    expect(isCelExpression('summary.contains("foo")')).toBe(true);
    expect(isCelExpression('summary.matches("foo.*")')).toBe(true);
  });

  it("returns true for has() expressions", () => {
    expect(isCelExpression('has("transcript")')).toBe(true);
    expect(isCelExpression('has("mp3")')).toBe(true);
    expect(isCelExpression('has("summary")')).toBe(true);
  });

  it("returns false for empty input", () => {
    expect(isCelExpression("")).toBe(false);
    expect(isCelExpression("   ")).toBe(false);
  });
});

describe("parseFilterExpression", () => {
  it("returns null for empty input", () => {
    expect(parseFilterExpression("")).toBeNull();
    expect(parseFilterExpression("   ")).toBeNull();
  });

  it("returns null for plain text (non-CEL)", () => {
    expect(parseFilterExpression("standup")).toBeNull();
  });

  it("parses title.contains", () => {
    const ast = parseFilterExpression('title.contains("standup")');
    expect(ast.type).toBe("CALL");
    expect(ast.field).toBe("title");
    expect(ast.op).toBe("contains");
    expect(ast.args[0].value).toBe("standup");
  });

  it("parses title.matches", () => {
    const ast = parseFilterExpression('title.matches("stand.*up")');
    expect(ast.type).toBe("CALL");
    expect(ast.field).toBe("title");
    expect(ast.op).toBe("matches");
    expect(ast.args[0].value).toBe("stand.*up");
  });

  it("parses date.range with two args", () => {
    const ast = parseFilterExpression('date.range("2026-01-01","2026-01-31")');
    expect(ast.type).toBe("CALL");
    expect(ast.field).toBe("date");
    expect(ast.op).toBe("range");
    expect(ast.args).toHaveLength(2);
    expect(ast.args[0].value).toBe("2026-01-01");
    expect(ast.args[1].value).toBe("2026-01-31");
  });

  it("parses AND expressions", () => {
    const ast = parseFilterExpression('title.contains("a") && title.contains("b")');
    expect(ast.type).toBe("AND");
    expect(ast.left.field).toBe("title");
    expect(ast.right.field).toBe("title");
  });

  it("parses OR expressions", () => {
    const ast = parseFilterExpression('title.contains("a") || title.contains("b")');
    expect(ast.type).toBe("OR");
  });

  it("parses parenthesized expressions", () => {
    const ast = parseFilterExpression('(title.contains("a") || title.contains("b")) && date.after("2026-01-01")');
    expect(ast.type).toBe("AND");
    expect(ast.left.type).toBe("OR");
  });

  it("handles escaped quotes in strings", () => {
    const ast = parseFilterExpression('title.contains("it\'s a test")');
    expect(ast.args[0].value).toBe("it's a test");
  });

  it("throws on malformed CEL", () => {
    expect(() => parseFilterExpression('title.contains(')).toThrow();
    expect(() => parseFilterExpression('title.contains("foo"')).toThrow();
  });

  it("returns null for expressions starting with operators (treated as plain text)", () => {
    expect(parseFilterExpression('&& title.contains("foo")')).toBeNull();
  });
});

describe("compileFilter - plain text", () => {
  it("matches substring in title", () => {
    const pred = compileFilter("standup");
    expect(pred(makeSession())).toBe(true);
  });

  it("matches substring in description", () => {
    const pred = compileFilter("team sync");
    expect(pred(makeSession())).toBe(true);
  });

  it("matches substring in transcript", () => {
    const pred = compileFilter("standup");
    expect(pred(makeSession())).toBe(true);
  });

  it("returns false when no match", () => {
    const pred = compileFilter("nonexistent text");
    expect(pred(makeSession())).toBe(false);
  });

  it("is case-insensitive", () => {
    const pred = compileFilter("STANDUP");
    expect(pred(makeSession())).toBe(true);
  });

  it("empty filter matches everything", () => {
    const pred = compileFilter("");
    expect(pred(makeSession())).toBe(true);
  });
});

describe("compileFilter - title.contains", () => {
  it("matches title substring", () => {
    const pred = compileFilter('title.contains("standup")');
    expect(pred(makeSession())).toBe(true);
  });

  it("matches description substring", () => {
    const pred = compileFilter('title.contains("sync")');
    expect(pred(makeSession())).toBe(true);
  });

  it("does not match transcript", () => {
    const pred = compileFilter('title.contains("everyone")');
    expect(pred(makeSession())).toBe(false);
  });

  it("is case-insensitive", () => {
    const pred = compileFilter('title.contains("STANDUP")');
    expect(pred(makeSession())).toBe(true);
  });
});

describe("compileFilter - title.matches", () => {
  it("matches regex on title", () => {
    const pred = compileFilter('title.matches("stand.*")');
    expect(pred(makeSession())).toBe(true);
  });

  it("matches regex on tab title", () => {
    const pred = compileFilter('title.matches("google.*room")');
    expect(pred(makeSession())).toBe(true);
  });

  it("returns false when regex doesn't match", () => {
    const pred = compileFilter('title.matches("foobar")');
    expect(pred(makeSession())).toBe(false);
  });

  it("handles invalid regex gracefully", () => {
    const pred = compileFilter('title.matches("[invalid")');
    expect(pred(makeSession())).toBe(false);
  });
});

describe("compileFilter - transcript.contains", () => {
  it("matches transcript substring", () => {
    const pred = compileFilter('transcript.contains("standup")');
    expect(pred(makeSession())).toBe(true);
  });

  it("does not match title", () => {
    const pred = compileFilter('transcript.contains("weekly")');
    expect(pred(makeSession())).toBe(false);
  });
});

describe("compileFilter - transcript.matches", () => {
  it("matches regex on transcript", () => {
    const pred = compileFilter('transcript.matches("hello.*standup")');
    expect(pred(makeSession())).toBe(true);
  });

  it("returns false when regex doesn't match transcript", () => {
    const pred = compileFilter('transcript.matches("nonexistent")');
    expect(pred(makeSession())).toBe(false);
  });
});

describe("compileFilter - date.after", () => {
  it("matches sessions after the date", () => {
    const pred = compileFilter('date.after("2026-06-01")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(true);
  });

  it("does not match sessions on the same day (exclusive)", () => {
    const pred = compileFilter('date.after("2026-06-15")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15, 10, 0, 0).getTime() }))).toBe(false);
  });

  it("does not match sessions before the date", () => {
    const pred = compileFilter('date.after("2026-07-01")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(false);
  });

  it("handles invalid date format", () => {
    const pred = compileFilter('date.after("not-a-date")');
    expect(pred(makeSession())).toBe(false);
  });
});

describe("compileFilter - date.before", () => {
  it("matches sessions before the date", () => {
    const pred = compileFilter('date.before("2026-07-01")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(true);
  });

  it("does not match sessions on the same day", () => {
    const pred = compileFilter('date.before("2026-06-15")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15, 10, 0, 0).getTime() }))).toBe(false);
  });

  it("does not match sessions after the date", () => {
    const pred = compileFilter('date.before("2026-01-01")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(false);
  });
});

describe("compileFilter - date.range", () => {
  it("matches sessions within the range", () => {
    const pred = compileFilter('date.range("2026-06-01","2026-06-30")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(true);
  });

  it("matches sessions on the start date (inclusive)", () => {
    const pred = compileFilter('date.range("2026-06-15","2026-06-30")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15, 10, 0, 0).getTime() }))).toBe(true);
  });

  it("matches sessions on the end date (inclusive of full day)", () => {
    const pred = compileFilter('date.range("2026-06-01","2026-06-15")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15, 23, 59, 0).getTime() }))).toBe(true);
  });

  it("does not match sessions before the range", () => {
    const pred = compileFilter('date.range("2026-07-01","2026-07-31")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(false);
  });

  it("does not match sessions after the range", () => {
    const pred = compileFilter('date.range("2026-01-01","2026-01-31")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(false);
  });

  it("handles invalid dates in range", () => {
    const pred = compileFilter('date.range("bad","2026-06-30")');
    expect(pred(makeSession())).toBe(false);
  });
});

describe("compileFilter - has", () => {
  it("matches sessions with transcript", () => {
    const pred = compileFilter('has("transcript")');
    expect(pred(makeSession())).toBe(true);
  });

  it("matches sessions with fs transcript path", () => {
    const pred = compileFilter('has("transcript")');
    expect(pred(makeSession({ transcriptText: undefined, _fsTxtPath: "/path/to/transcript.txt" }))).toBe(true);
  });

  it("does not match sessions without transcript", () => {
    const pred = compileFilter('has("transcript")');
    expect(pred(makeSession({ transcriptText: undefined, _fsTxtPath: undefined, _fsDiarizedTxtPath: undefined }))).toBe(false);
  });

  it("matches sessions with mp3", () => {
    const pred = compileFilter('has("mp3")');
    expect(pred(makeSession({ _fsHasMp3: true }))).toBe(true);
  });

  it("does not match sessions without mp3", () => {
    const pred = compileFilter('has("mp3")');
    expect(pred(makeSession({ _fsHasMp3: false, _fsMp3Path: undefined }))).toBe(false);
  });

  it("matches sessions with summary path", () => {
    const pred = compileFilter('has("summary")');
    expect(pred(makeSession({ _fsSummaryPath: "/path/to/summary.md", description: "" }))).toBe(true);
  });

  it("matches sessions with description but no summary file", () => {
    const pred = compileFilter('has("summary")');
    expect(pred(makeSession({ _fsSummaryPath: null, description: "A summary" }))).toBe(true);
  });

  it("does not match sessions without summary", () => {
    const pred = compileFilter('has("summary")');
    expect(pred(makeSession({ _fsSummaryPath: null, description: "" }))).toBe(false);
  });
});

describe("compileFilter - summary.contains", () => {
  it("matches description substring", () => {
    const pred = compileFilter('summary.contains("sync")');
    expect(pred(makeSession({ description: "Team sync meeting" }))).toBe(true);
  });

  it("is case-insensitive", () => {
    const pred = compileFilter('summary.contains("SYNC")');
    expect(pred(makeSession({ description: "Team sync meeting" }))).toBe(true);
  });

  it("does not match title", () => {
    const pred = compileFilter('summary.contains("standup")');
    expect(pred(makeSession({ description: "Team sync", meetingLabel: "Weekly Standup" }))).toBe(false);
  });

  it("returns false for empty description", () => {
    const pred = compileFilter('summary.contains("anything")');
    expect(pred(makeSession({ description: "" }))).toBe(false);
  });
});

describe("compileFilter - summary.matches", () => {
  it("matches regex on description", () => {
    const pred = compileFilter('summary.matches("team.*meeting")');
    expect(pred(makeSession({ description: "Team sync meeting" }))).toBe(true);
  });

  it("is case-insensitive", () => {
    const pred = compileFilter('summary.matches("TEAM")');
    expect(pred(makeSession({ description: "Team sync" }))).toBe(true);
  });

  it("returns false when regex doesn't match", () => {
    const pred = compileFilter('summary.matches("nonexistent")');
    expect(pred(makeSession({ description: "Team sync" }))).toBe(false);
  });

  it("handles invalid regex gracefully", () => {
    const pred = compileFilter('summary.matches("[invalid")');
    expect(pred(makeSession({ description: "test" }))).toBe(false);
  });
});

describe("compileFilter - compound expressions", () => {
  it("AND: both must match", () => {
    const pred = compileFilter('title.contains("standup") && date.after("2026-06-01")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(true);
  });

  it("AND: one fails → false", () => {
    const pred = compileFilter('title.contains("standup") && date.after("2027-01-01")');
    expect(pred(makeSession())).toBe(false);
  });

  it("OR: one matches → true", () => {
    const pred = compileFilter('title.contains("nonexistent") || title.contains("standup")');
    expect(pred(makeSession())).toBe(true);
  });

  it("OR: both fail → false", () => {
    const pred = compileFilter('title.contains("nope1") || title.contains("nope2")');
    expect(pred(makeSession())).toBe(false);
  });

  it("parenthesized grouping with AND/OR", () => {
    const pred = compileFilter('(title.contains("standup") || title.contains("retro")) && date.range("2026-06-01","2026-06-30")');
    expect(pred(makeSession({ startedAt: new Date(2026, 5, 15).getTime() }))).toBe(true);
  });

  it("complex nested expression", () => {
    const pred = compileFilter('(title.contains("standup") && has("transcript")) || date.before("2025-01-01")');
    expect(pred(makeSession())).toBe(true);
  });
});

describe("compileFilter - error handling", () => {
  it("returns false predicate for malformed CEL", () => {
    const pred = compileFilter('title.contains(');
    expect(pred(makeSession())).toBe(false);
  });

  it("returns true predicate for empty string", () => {
    const pred = compileFilter("");
    expect(pred(makeSession())).toBe(true);
  });

  it("returns true predicate for whitespace-only", () => {
    const pred = compileFilter("   ");
    expect(pred(makeSession())).toBe(true);
  });

  it("evaluates safely with null session", () => {
    const pred = compileFilter('title.contains("test")');
    expect(pred(null)).toBe(false);
  });

  it("evaluates safely with undefined session", () => {
    const pred = compileFilter('title.contains("test")');
    expect(pred(undefined)).toBe(false);
  });
});
