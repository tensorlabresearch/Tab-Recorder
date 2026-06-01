import { describe, it, expect } from "vitest";
import {
  serializeSummary,
  parseSummary,
  summaryPathFor,
} from "../extension/lib/summaryFile.js";

describe("serializeSummary", () => {
  it("writes frontmatter + body in the expected layout", () => {
    const out = serializeSummary({
      description: "Team standup covering deploys.",
      summary: "## Summary\n- a\n- b",
      model: "gemini-nano",
      generatedAt: "2026-06-01T17:00:00.000Z",
    });
    expect(out).toBe(
      [
        "---",
        "description: Team standup covering deploys.",
        "generated-at: 2026-06-01T17:00:00.000Z",
        "model: gemini-nano",
        "---",
        "",
        "## Summary",
        "- a",
        "- b",
        "",
      ].join("\n"),
    );
  });

  it("quotes values that would break YAML scalar parsing", () => {
    const out = serializeSummary({
      description: 'Notes: "tricky" stuff and: colons',
      summary: "x",
      model: "gemini-nano",
      generatedAt: "2026-06-01T00:00:00Z",
    });
    // Should be quoted because of `: ` and `"`
    expect(out).toMatch(/^description: ".*"$/m);
  });

  it("defaults generatedAt to now when missing", () => {
    const before = Date.now();
    const out = serializeSummary({ description: "d", summary: "s", model: "m" });
    const after = Date.now();
    const match = out.match(/generated-at: (\S+)/);
    expect(match).toBeTruthy();
    const t = Date.parse(match[1]);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(after + 1000);
  });

  it("emits an empty body when summary is missing", () => {
    const out = serializeSummary({ description: "d", model: "m", generatedAt: "t" });
    expect(out.endsWith("---\n")).toBe(true);
  });
});

describe("parseSummary", () => {
  it("round-trips serializeSummary losslessly", () => {
    const input = {
      description: "A meeting about the Q3 roadmap.",
      summary: "## Summary\n- Item 1\n- Item 2",
      model: "gemini-nano",
      generatedAt: "2026-06-01T12:00:00.000Z",
    };
    const text = serializeSummary(input);
    const parsed = parseSummary(text);
    expect(parsed.description).toBe(input.description);
    expect(parsed.summary).toBe(input.summary);
    expect(parsed.model).toBe(input.model);
    expect(parsed.generatedAt).toBe(input.generatedAt);
  });

  it("round-trips tricky scalar values", () => {
    const input = {
      description: 'Has "quotes" and: colons in it',
      summary: "body",
      model: "gemini-nano",
      generatedAt: "2026-06-01T00:00:00Z",
    };
    const parsed = parseSummary(serializeSummary(input));
    expect(parsed.description).toBe(input.description);
  });

  it("returns the whole text as summary when frontmatter is absent", () => {
    const text = "## Summary\n- only a body";
    expect(parseSummary(text)).toEqual({
      description: "",
      summary: "## Summary\n- only a body",
      model: "",
      generatedAt: "",
    });
  });

  it("returns the whole text when frontmatter is unterminated", () => {
    const text = "---\ndescription: orphan\nno-fence-here";
    const parsed = parseSummary(text);
    expect(parsed.description).toBe("");
    expect(parsed.summary).toContain("orphan");
  });

  it("handles empty input gracefully", () => {
    expect(parseSummary("")).toEqual({
      description: "",
      summary: "",
      model: "",
      generatedAt: "",
    });
  });

  it("ignores unknown frontmatter keys", () => {
    const text = [
      "---",
      "description: d",
      "random-key: junk",
      "model: gemini-nano",
      "---",
      "body",
    ].join("\n");
    const parsed = parseSummary(text);
    expect(parsed.description).toBe("d");
    expect(parsed.model).toBe("gemini-nano");
    expect(parsed.summary).toBe("body");
  });
});

describe("summaryPathFor", () => {
  it("appends .summary.md to the basename", () => {
    expect(summaryPathFor("2026-06-01/standup")).toBe(
      "2026-06-01/standup.summary.md",
    );
  });
});
