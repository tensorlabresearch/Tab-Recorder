import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installChromeStorageMock } from "./helpers/chrome-storage-mock.js";
import { installCachesMock } from "./helpers/caches-mock.js";
import * as mod from "../extension/lib/speakerEmbedModel.js";

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

describe("getSelectedSpeakerEmbedModelId / setSelectedSpeakerEmbedModelId", () => {
  it("returns the registry default when nothing has been stored", async () => {
    const id = await mod.getSelectedSpeakerEmbedModelId();
    expect(id).toBe(mod.DEFAULT_SPEAKER_EMBED_MODEL_ID);
  });

  it("round-trips a registered model id", async () => {
    await mod.setSelectedSpeakerEmbedModelId("Xenova/unispeech-sat-base-plus-sv");
    const id = await mod.getSelectedSpeakerEmbedModelId();
    expect(id).toBe("Xenova/unispeech-sat-base-plus-sv");
  });

  it("falls back to the default when the stored id is no longer registered", async () => {
    await chrome.storage.local.set({ speakerEmbedModelId: "Xenova/mystery-model" });
    const id = await mod.getSelectedSpeakerEmbedModelId();
    expect(id).toBe(mod.DEFAULT_SPEAKER_EMBED_MODEL_ID);
  });

  it("rejects setting an unknown model id", async () => {
    await expect(
      mod.setSelectedSpeakerEmbedModelId("Xenova/mystery-model")
    ).rejects.toThrow(/Unknown/);
  });
});

describe("getAutoDiarizePreference / setAutoDiarizePreference", () => {
  it("defaults to false when nothing has been set", async () => {
    expect(await mod.getAutoDiarizePreference()).toBe(false);
  });

  it("round-trips boolean true", async () => {
    await mod.setAutoDiarizePreference(true);
    expect(await mod.getAutoDiarizePreference()).toBe(true);
  });

  it("coerces truthy/falsy values to booleans on write", async () => {
    await mod.setAutoDiarizePreference("yes");
    expect(await mod.getAutoDiarizePreference()).toBe(true);
    await mod.setAutoDiarizePreference(0);
    expect(await mod.getAutoDiarizePreference()).toBe(false);
  });

  it("returns false when chrome.storage is unavailable", async () => {
    chromeMock.restore();
    delete globalThis.chrome;
    expect(await mod.getAutoDiarizePreference()).toBe(false);
  });
});

describe("isSpeakerEmbedModelCached", () => {
  it("returns false on a fresh cache", async () => {
    expect(await mod.isSpeakerEmbedModelCached("Xenova/wavlm-base-plus-sv")).toBe(false);
  });

  it("returns true once an entry for the id has been seeded", async () => {
    const cache = await caches.open("transformers-cache");
    await cache.put(
      new Request("https://huggingface.co/Xenova/wavlm-base-plus-sv/resolve/main/onnx/model.onnx"),
      new Response("")
    );
    expect(await mod.isSpeakerEmbedModelCached("Xenova/wavlm-base-plus-sv")).toBe(true);
  });

  it("returns false when caches API is missing", async () => {
    cachesMock.restore();
    delete globalThis.caches;
    expect(await mod.isSpeakerEmbedModelCached("Xenova/wavlm-base-plus-sv")).toBe(false);
  });
});
