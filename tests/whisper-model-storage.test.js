import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installChromeStorageMock } from "./helpers/chrome-storage-mock.js";
import { installCachesMock } from "./helpers/caches-mock.js";
import * as mod from "../extension/lib/whisperModel.js";

let chromeMock;
let cachesMock;

beforeEach(() => {
  chromeMock = installChromeStorageMock();
  cachesMock = installCachesMock();
});

afterEach(() => {
  chromeMock.restore();
  cachesMock.restore();
});

describe("getSelectedModelId / setSelectedModelId", () => {
  it("returns the registry default when nothing has been stored", async () => {
    const id = await mod.getSelectedModelId();
    expect(id).toBe(mod.DEFAULT_WHISPER_MODEL_ID);
  });

  it("round-trips a registered model id", async () => {
    await mod.setSelectedModelId("Xenova/whisper-tiny.en");
    const id = await mod.getSelectedModelId();
    expect(id).toBe("Xenova/whisper-tiny.en");
  });

  it("falls back to the default when the stored id is no longer registered", async () => {
    await chromeMock.store; // touch
    await chrome.storage.local.set({ whisperModelId: "Xenova/whisper-fictional" });
    const id = await mod.getSelectedModelId();
    expect(id).toBe(mod.DEFAULT_WHISPER_MODEL_ID);
  });

  it("rejects setting an unknown model id", async () => {
    await expect(mod.setSelectedModelId("Xenova/whisper-fictional")).rejects.toThrow(/Unknown/);
  });

  it("survives chrome.storage being unavailable on read", async () => {
    chromeMock.restore();
    delete globalThis.chrome;
    const id = await mod.getSelectedModelId();
    expect(id).toBe(mod.DEFAULT_WHISPER_MODEL_ID);
  });
});

describe("getAutoTranscribePreference / setAutoTranscribePreference", () => {
  it("defaults to false when nothing has been set", async () => {
    expect(await mod.getAutoTranscribePreference()).toBe(false);
  });

  it("round-trips boolean true", async () => {
    await mod.setAutoTranscribePreference(true);
    expect(await mod.getAutoTranscribePreference()).toBe(true);
  });

  it("coerces truthy/falsy values to booleans on write", async () => {
    await mod.setAutoTranscribePreference("yes");
    expect(await mod.getAutoTranscribePreference()).toBe(true);
    await mod.setAutoTranscribePreference(0);
    expect(await mod.getAutoTranscribePreference()).toBe(false);
  });

  it("returns false when the stored value isn't strictly boolean true", async () => {
    await chrome.storage.local.set({ autoTranscribeOnStop: 1 });
    expect(await mod.getAutoTranscribePreference()).toBe(false);
    await chrome.storage.local.set({ autoTranscribeOnStop: "true" });
    expect(await mod.getAutoTranscribePreference()).toBe(false);
  });

  it("returns false if chrome.storage throws", async () => {
    chromeMock.restore();
    delete globalThis.chrome;
    expect(await mod.getAutoTranscribePreference()).toBe(false);
  });
});

describe("isModelCached", () => {
  it("returns false when the cache namespace has no entries", async () => {
    expect(await mod.isModelCached("Xenova/whisper-base.en")).toBe(false);
  });

  it("returns true when a cache entry contains the model id", async () => {
    cachesMock.addEntry(
      "transformers-cache",
      "https://huggingface.co/Xenova/whisper-base.en/resolve/main/config.json"
    );
    expect(await mod.isModelCached("Xenova/whisper-base.en")).toBe(true);
  });

  it("matches case-insensitively", async () => {
    cachesMock.addEntry(
      "transformers-cache",
      "https://hf.co/xenova/whisper-base.en/file"
    );
    expect(await mod.isModelCached("Xenova/Whisper-Base.en")).toBe(true);
  });

  it("returns false when only some other model is cached", async () => {
    cachesMock.addEntry(
      "transformers-cache",
      "https://huggingface.co/Xenova/whisper-tiny.en/file"
    );
    expect(await mod.isModelCached("Xenova/whisper-base.en")).toBe(false);
  });

  it("returns false if caches API is unavailable", async () => {
    cachesMock.restore();
    delete globalThis.caches;
    if (typeof self !== "undefined") delete self.caches;
    expect(await mod.isModelCached("Xenova/whisper-base.en")).toBe(false);
  });
});
