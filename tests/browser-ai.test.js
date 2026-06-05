import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { installChromeStorageMock } from "./helpers/chrome-storage-mock.js";
import {
  isAvailable,
  chunkText,
  takeHead,
  parseStructuredResponse,
  summarizeAndDescribe,
  getAutoSummarizePreference,
  setAutoSummarizePreference,
  getSummaryHeadChars,
  setSummaryHeadChars,
  BROWSER_AI,
} from "../extension/lib/browserAi.js";

function installLanguageModel({ status = "available", prompt }) {
  const session = {
    prompt: vi.fn(async (input, opts) => {
      if (typeof prompt === "function") return prompt(input, opts);
      return prompt ?? "";
    }),
    destroy: vi.fn(),
  };
  const api = {
    availability: vi.fn(async () => status),
    create: vi.fn(async () => session),
  };
  globalThis.LanguageModel = api;
  return { api, session };
}

let chromeMock;

beforeEach(() => {
  chromeMock = installChromeStorageMock();
});

afterEach(() => {
  chromeMock?.restore();
  delete globalThis.LanguageModel;
  vi.restoreAllMocks();
});

describe("isAvailable", () => {
  it("returns false when LanguageModel global is missing", async () => {
    delete globalThis.LanguageModel;
    expect(await isAvailable()).toBe(false);
  });

  it("returns false when availability() reports 'unavailable'", async () => {
    installLanguageModel({ status: "unavailable" });
    expect(await isAvailable()).toBe(false);
  });

  it("returns false when status is 'downloadable' (prevents 4 GB download)", async () => {
    installLanguageModel({ status: "downloadable" });
    expect(await isAvailable()).toBe(false);
  });

  it("returns false when status is 'downloading'", async () => {
    installLanguageModel({ status: "downloading" });
    expect(await isAvailable()).toBe(false);
  });

  it("returns true only when status is exactly 'available'", async () => {
    installLanguageModel({ status: "available" });
    expect(await isAvailable()).toBe(true);
  });

  it("returns false if availability() throws", async () => {
    globalThis.LanguageModel = {
      availability: vi.fn(async () => {
        throw new Error("nope");
      }),
    };
    expect(await isAvailable()).toBe(false);
  });
});

describe("auto-summarize preference", () => {
  it("defaults to false", async () => {
    expect(await getAutoSummarizePreference()).toBe(false);
  });

  it("round-trips via chrome.storage.local", async () => {
    await setAutoSummarizePreference(true);
    expect(await getAutoSummarizePreference()).toBe(true);
    await setAutoSummarizePreference(false);
    expect(await getAutoSummarizePreference()).toBe(false);
  });

  it("coerces truthy/falsy to boolean", async () => {
    await setAutoSummarizePreference("yes");
    expect(await getAutoSummarizePreference()).toBe(true);
    await setAutoSummarizePreference(0);
    expect(await getAutoSummarizePreference()).toBe(false);
  });
});

describe("summary head-chars preference", () => {
  it("defaults to SUMMARY_HEAD_CHARS (500)", async () => {
    expect(await getSummaryHeadChars()).toBe(BROWSER_AI.SUMMARY_HEAD_CHARS);
    expect(BROWSER_AI.SUMMARY_HEAD_CHARS).toBe(500);
  });

  it("round-trips a preset value", async () => {
    await setSummaryHeadChars(1000);
    expect(await getSummaryHeadChars()).toBe(1000);
  });

  it("accepts 0 (entire transcript)", async () => {
    await setSummaryHeadChars(0);
    expect(await getSummaryHeadChars()).toBe(0);
  });

  it("floors fractional values", async () => {
    await setSummaryHeadChars(750.9);
    expect(await getSummaryHeadChars()).toBe(750);
  });

  it("rejects negative or non-numeric values", async () => {
    await expect(setSummaryHeadChars(-1)).rejects.toThrow(/Invalid/);
    await expect(setSummaryHeadChars("abc")).rejects.toThrow(/Invalid/);
  });

  it("falls back to the default when a bogus value is stored", async () => {
    await chrome.storage.local.set({ summaryHeadChars: -5 });
    expect(await getSummaryHeadChars()).toBe(BROWSER_AI.SUMMARY_HEAD_CHARS);
  });
});

describe("chunkText", () => {
  it("returns an empty array for empty input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   ")).toEqual([]);
    expect(chunkText(null)).toEqual([]);
  });

  it("returns the whole text in one chunk when under the limit", () => {
    const text = "Hello world. This fits.";
    expect(chunkText(text, 100)).toEqual([text]);
  });

  it("splits on sentence boundaries when over the limit", () => {
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence ${i + 1}.`);
    const text = sentences.join(" ");
    const chunks = chunkText(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should end on a sentence boundary (terminal punctuation).
    for (const c of chunks) {
      expect(c).toMatch(/[.!?]$/);
    }
    // Reassembled chunks should match the source (modulo whitespace).
    expect(chunks.join(" ").replace(/\s+/g, " ").trim()).toBe(
      text.replace(/\s+/g, " ").trim(),
    );
  });

  it("hard-splits a single sentence longer than the limit", () => {
    const long = "a".repeat(50) + ".";
    const chunks = chunkText(long, 20);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(20);
  });
});

describe("parseStructuredResponse", () => {
  it("parses pure JSON", () => {
    const r = parseStructuredResponse('{"description":"D","summary":"## S\\n- a"}');
    expect(r.description).toBe("D");
    expect(r.summary).toBe("## S\n- a");
  });

  it("extracts JSON embedded in surrounding prose", () => {
    const r = parseStructuredResponse(
      'Sure! Here you go: {"description":"D","summary":"S"} — let me know if...',
    );
    expect(r.description).toBe("D");
    expect(r.summary).toBe("S");
  });

  it("returns the raw text as summary when JSON cannot be recovered", () => {
    const r = parseStructuredResponse("just some markdown bullets\n- a\n- b");
    expect(r.description).toBe("");
    expect(r.summary).toContain("- a");
  });

  it("handles empty input", () => {
    const r = parseStructuredResponse("");
    expect(r).toEqual({ description: "", summary: "" });
  });
});

describe("summarizeAndDescribe", () => {
  it("makes a single prompt for a short transcript", async () => {
    const { api, session } = installLanguageModel({
      prompt: '{"description":"a short chat","summary":"## Summary\\n- hi"}',
    });
    const out = await summarizeAndDescribe("Hello world. This is short.");
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(session.prompt).toHaveBeenCalledTimes(1);
    expect(session.destroy).toHaveBeenCalled();
    expect(out.description).toBe("a short chat");
    expect(out.summary).toContain("## Summary");
  });

  it("falls back to a plain prompt if responseConstraint throws", async () => {
    const session = {
      prompt: vi
        .fn()
        .mockRejectedValueOnce(new Error("responseConstraint unsupported"))
        .mockResolvedValueOnce('{"description":"d","summary":"s"}'),
      destroy: vi.fn(),
    };
    globalThis.LanguageModel = {
      availability: vi.fn(async () => "available"),
      create: vi.fn(async () => session),
    };
    const out = await summarizeAndDescribe("x. y. z.");
    expect(out.description).toBe("d");
    expect(session.prompt).toHaveBeenCalledTimes(2);
  });

  it("map-reduces a long transcript via chunk + final passes", async () => {
    const calls = [];
    const promptImpl = async (input, opts) => {
      calls.push({ input, opts });
      // The chunk system prompt produces bullets; the final one produces JSON.
      if (calls.length <= 3) return `- bullet from chunk ${calls.length}`;
      return '{"description":"long-thing","summary":"## Summary\\n- combined"}';
    };
    const { api } = installLanguageModel({ prompt: promptImpl });

    // 3 chunks: each sentence fits under maxChunkChars, but together overflow.
    const text = "Sentence one. Sentence two. Sentence three.";
    const out = await summarizeAndDescribe(text, { maxChunkChars: 20 });

    expect(api.create).toHaveBeenCalledTimes(2); // chunk session + final session
    expect(calls.length).toBe(4); // 3 chunk prompts + 1 final synthesize
    expect(out.description).toBe("long-thing");
    expect(out.summary).toContain("## Summary");
  });

  it("marks description as partial when chunks exceed maxChunks", async () => {
    const promptCalls = [];
    const promptImpl = async (input) => {
      promptCalls.push(input);
      if (promptCalls.length <= 2) return "- chunk bullet";
      return '{"description":"big recording","summary":"s"}';
    };
    installLanguageModel({ prompt: promptImpl });
    // 6 short sentences → 6 chunks at maxChunkChars=20.
    const text = Array.from({ length: 6 }, (_, i) => `Sentence ${i}.`).join(" ");
    const out = await summarizeAndDescribe(text, { maxChunkChars: 20, maxChunks: 2 });
    expect(out.description).toMatch(/\(partial\)\.$/);
    // 2 chunk prompts + 1 final synthesize = 3 calls
    expect(promptCalls.length).toBe(3);
  });

  it("only summarizes the first SUMMARY_HEAD_CHARS of a long transcript", async () => {
    let promptedInput = "";
    installLanguageModel({
      prompt: async (input) => {
        promptedInput = input;
        return '{"description":"d","summary":"## Summary\\n- s"}';
      },
    });
    // 5000 chars of distinct words; only the opening ~1000 should be sent.
    const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    await summarizeAndDescribe(text);
    expect(promptedInput.length).toBeLessThanOrEqual(BROWSER_AI.SUMMARY_HEAD_CHARS);
    expect(text.startsWith(promptedInput)).toBe(true);
  });

  it("summarizes the whole transcript when headChars: 0", async () => {
    let promptedInput = "";
    installLanguageModel({
      prompt: async (input) => {
        promptedInput = input;
        return '{"description":"d","summary":"s"}';
      },
    });
    const text = Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" ");
    await summarizeAndDescribe(text, { headChars: 0 });
    expect(promptedInput.length).toBe(text.length);
  });

  it("throws when LanguageModel is missing", async () => {
    delete globalThis.LanguageModel;
    await expect(summarizeAndDescribe("x")).rejects.toThrow(/LanguageModel/);
  });

  it("returns empty fields for empty input", async () => {
    installLanguageModel({ prompt: "{}" });
    expect(await summarizeAndDescribe("")).toEqual({ description: "", summary: "" });
    expect(await summarizeAndDescribe("   ")).toEqual({ description: "", summary: "" });
  });
});

describe("takeHead", () => {
  it("returns the input unchanged when shorter than the cap", () => {
    expect(takeHead("short text", 1000)).toBe("short text");
  });

  it("returns empty/whitespace input as empty string", () => {
    expect(takeHead("", 1000)).toBe("");
    expect(takeHead("   ", 1000)).toBe("");
    expect(takeHead(null, 1000)).toBe("");
  });

  it("caps to at most maxChars", () => {
    const text = Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ");
    expect(takeHead(text, 50).length).toBeLessThanOrEqual(50);
  });

  it("backs off to a word boundary (no mid-word cut)", () => {
    const out = takeHead("alpha beta gamma delta epsilon", 14);
    expect(out).toBe("alpha beta"); // hard cut at 14 lands mid-"gamma"
  });

  it("treats maxChars <= 0 as no cap", () => {
    const text = "a b c d e f g h i j";
    expect(takeHead(text, 0)).toBe(text);
    expect(takeHead(text, -5)).toBe(text);
  });
});

describe("BROWSER_AI constants", () => {
  it("exposes the constants the panel needs", () => {
    expect(BROWSER_AI.MODEL_LABEL).toBe("gemini-nano");
    expect(BROWSER_AI.MAX_CHUNK_CHARS).toBeGreaterThan(0);
    expect(BROWSER_AI.MAX_CHUNKS).toBeGreaterThan(0);
    expect(BROWSER_AI.SUMMARY_HEAD_CHARS).toBeGreaterThan(0);
  });
});
