import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  createWhisperWorkerClient,
  createWhisperChunkRunner,
  isRecoverableWhisperError,
  isAbortError
} from "../extension/lib/whisperClient.js";

/**
 * Stands in for the module Worker. Tests drive it directly: `emit` plays a
 * message back to the client, and `posted` records what the client sent.
 */
function makeFakeWorker() {
  const worker = {
    posted: [],
    transfers: [],
    terminated: 0,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(data, transfer) {
      worker.posted.push(data);
      worker.transfers.push(transfer);
    },
    terminate() {
      worker.terminated += 1;
    },
    emit(data) {
      worker.onmessage?.({ data });
    },
    /** Reply to the job the client most recently started. */
    emitForJob(payload) {
      const jobId = worker.posted[worker.posted.length - 1]?.jobId;
      worker.emit({ jobId, ...payload });
    }
  };
  return worker;
}

const PCM = () => new Float32Array([0.1, 0.2, 0.3, 0.4]);

let workers;
let createWorker;

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  createWorker = () => {
    const worker = makeFakeWorker();
    workers.push(worker);
    return worker;
  };
});

afterEach(() => {
  vi.useRealTimers();
});

/** Let queued promise callbacks run without advancing the fake clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("createWhisperWorkerClient", () => {
  it("resolves with the worker's transcript", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    await flush();

    workers[0].emitForJob({ type: "stage", stage: "Transcribing" });
    workers[0].emitForJob({
      type: "done",
      text: "hello there",
      segments: [{ text: "hello there", start: 0, end: 900 }],
      device: "webgpu"
    });

    await expect(promise).resolves.toEqual({
      text: "hello there",
      segments: [{ text: "hello there", start: 0, end: 900 }],
      device: "webgpu"
    });
  });

  it("sends the model's dtype ladder and transfers a copy of the PCM", async () => {
    const client = createWhisperWorkerClient({
      modelId: "onnx-community/whisper-large-v3-turbo",
      createWorker
    });
    const pcm = PCM();
    const promise = client.transcribe(pcm);
    await flush();

    const message = workers[0].posted[0];
    expect(message.modelId).toBe("onnx-community/whisper-large-v3-turbo");
    expect(message.dtypes[0]).toEqual({ encoder_model: "q4", decoder_model_merged: "q4" });
    // The caller's array must survive the transfer so a retry can reuse it.
    expect(pcm.length).toBe(4);
    expect(message.pcm).not.toBe(pcm);
    expect(Array.from(message.pcm)).toEqual(Array.from(pcm));
    expect(workers[0].transfers[0]).toEqual([message.pcm.buffer]);

    workers[0].emitForJob({ type: "done", text: "x", segments: [], device: "wasm" });
    await promise;
  });

  it("forwards stage, segment, engine and download progress callbacks", async () => {
    const onEngine = vi.fn();
    const onDownloadProgress = vi.fn();
    const onStage = vi.fn();
    const onSegment = vi.fn();
    const client = createWhisperWorkerClient({
      modelId: "Xenova/whisper-tiny.en",
      onEngine,
      onDownloadProgress,
      createWorker
    });
    const promise = client.transcribe(PCM(), { onStage, onSegment });
    await flush();

    workers[0].emitForJob({ type: "stage", stage: "Loading model" });
    workers[0].emitForJob({ type: "downloadProgress", file: "encoder", progress: 42 });
    workers[0].emitForJob({ type: "engine", device: "webgpu" });
    workers[0].emitForJob({ type: "segment", segment: { text: "hi", start: 0, end: 10 } });
    workers[0].emitForJob({ type: "done", text: "hi", segments: [], device: "webgpu" });
    await promise;

    expect(onStage).toHaveBeenCalledWith("Loading model");
    expect(onDownloadProgress).toHaveBeenCalledWith(
      expect.objectContaining({ file: "encoder", progress: 42 })
    );
    expect(onEngine).toHaveBeenCalledWith("webgpu");
    expect(onSegment).toHaveBeenCalledWith({ text: "hi", start: 0, end: 10 });
  });

  it("ignores messages from a stale job id", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const onStage = vi.fn();
    const promise = client.transcribe(PCM(), { onStage });
    await flush();

    workers[0].emit({ jobId: "not-the-active-job", type: "stage", stage: "Transcribing" });
    expect(onStage).not.toHaveBeenCalled();

    workers[0].emitForJob({ type: "done", text: "ok", segments: [], device: "wasm" });
    await promise;
  });

  it("rejects with a stalled error when generation goes silent", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    const assertion = expect(promise).rejects.toThrow(/stopped responding/i);
    await flush();

    // Prove the worker was alive and stepping, which arms the strict timeout.
    workers[0].emitForJob({ type: "stage", stage: "Transcribing" });
    workers[0].emitForJob({ type: "heartbeat", stepped: true });

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 5000);
    await assertion;
    expect(workers[0].terminated).toBe(1);
  });

  it("does not trip the strict timeout while heartbeats keep arriving", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    await flush();
    workers[0].emitForJob({ type: "stage", stage: "Transcribing" });

    for (let minute = 0; minute < 10; minute++) {
      workers[0].emitForJob({ type: "heartbeat", stepped: true });
      await vi.advanceTimersByTimeAsync(60 * 1000);
    }
    expect(workers[0].terminated).toBe(0);

    workers[0].emitForJob({ type: "done", text: "still here", segments: [], device: "wasm" });
    await expect(promise).resolves.toMatchObject({ text: "still here" });
  });

  it("allows a long silent model load before the strict timeout is armed", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    await flush();
    workers[0].emitForJob({ type: "stage", stage: "Loading model" });

    // Well past the 3 minute generation limit, but loading blocks the worker
    // thread and cannot heartbeat, so it gets the 10 minute budget.
    await vi.advanceTimersByTimeAsync(8 * 60 * 1000);
    expect(workers[0].terminated).toBe(0);

    workers[0].emitForJob({ type: "done", text: "loaded", segments: [], device: "wasm" });
    await expect(promise).resolves.toMatchObject({ text: "loaded" });
  });

  it("falls back to the loose timeout when the worker never reports a step", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    const assertion = expect(promise).rejects.toThrow(/stopped responding/i);
    await flush();
    workers[0].emitForJob({ type: "stage", stage: "Transcribing" });

    // No stepped heartbeat, so 3 minutes of silence is not yet a stall.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(workers[0].terminated).toBe(0);

    await vi.advanceTimersByTimeAsync(7 * 60 * 1000);
    await assertion;
  });

  it("enforces the absolute per-chunk budget even while heartbeating", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM(), { budgetMs: 60 * 1000 });
    const assertion = expect(promise).rejects.toThrow(/budget/i);
    await flush();
    workers[0].emitForJob({ type: "stage", stage: "Transcribing" });

    for (let i = 0; i < 14; i++) {
      workers[0].emitForJob({ type: "heartbeat", stepped: true });
      await vi.advanceTimersByTimeAsync(5000);
    }
    await assertion;
  });

  it("rejects on a worker error with a recoverable code", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    await flush();

    workers[0].onerror({ message: "boom", filename: "w.js", lineno: 3 });
    await promise.then(
      () => expect.unreachable("should have rejected"),
      (error) => {
        expect(isRecoverableWhisperError(error)).toBe(true);
        expect(error.message).toContain("boom");
      }
    );
  });

  it("rejects with the worker's own error, which is not retried", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM());
    await flush();

    workers[0].emitForJob({ type: "error", error: "bad audio" });
    await promise.then(
      () => expect.unreachable("should have rejected"),
      (error) => {
        expect(error.message).toBe("bad audio");
        expect(isRecoverableWhisperError(error)).toBe(false);
      }
    );
  });

  it("aborts in flight when the signal fires", async () => {
    const controller = new AbortController();
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = client.transcribe(PCM(), { signal: controller.signal });
    await flush();

    controller.abort();
    await promise.then(
      () => expect.unreachable("should have rejected"),
      (error) => expect(isAbortError(error)).toBe(true)
    );
    expect(workers[0].terminated).toBe(1);
  });

  it("refuses a second concurrent job and any job after termination", async () => {
    const client = createWhisperWorkerClient({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const first = client.transcribe(PCM());
    await flush();

    await expect(client.transcribe(PCM())).rejects.toThrow(/already has an active job/);

    client.terminate();
    await expect(first).rejects.toThrow(/terminated/);
    await expect(client.transcribe(PCM())).rejects.toThrow(/closed/);
    expect(client.closed).toBe(true);
  });
});

describe("createWhisperChunkRunner", () => {
  it("retries a stalled chunk on a fresh CPU-pinned worker", async () => {
    const onRecovery = vi.fn();
    const runner = createWhisperChunkRunner({
      modelId: "Xenova/whisper-tiny.en",
      onRecovery,
      createWorker
    });

    const pcm = PCM();
    const promise = runner.transcribe(pcm, {});
    await flush();

    // First attempt wedges after proving it was stepping.
    workers[0].emitForJob({ type: "stage", stage: "Transcribing" });
    workers[0].emitForJob({ type: "heartbeat", stepped: true });
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 5000);
    await flush();

    expect(onRecovery).toHaveBeenCalledTimes(1);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted[0].device).toBe("wasm");
    // The retry still has real audio, not a detached buffer.
    expect(Array.from(workers[1].posted[0].pcm)).toEqual(Array.from(PCM()));

    workers[1].emitForJob({ type: "done", text: "second try", segments: [], device: "wasm" });
    await expect(promise).resolves.toMatchObject({ text: "second try" });
    expect(runner.device).toBe("wasm");
  });

  it("gives up after the second attempt also stalls", async () => {
    const runner = createWhisperChunkRunner({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = runner.transcribe(PCM(), {});
    const assertion = expect(promise).rejects.toThrow(/stopped responding/i);
    await flush();

    for (const index of [0, 1]) {
      workers[index].emitForJob({ type: "stage", stage: "Transcribing" });
      workers[index].emitForJob({ type: "heartbeat", stepped: true });
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 5000);
      await flush();
    }

    await assertion;
    expect(workers).toHaveLength(2);
  });

  it("does not retry an ordinary transcription error", async () => {
    const onRecovery = vi.fn();
    const runner = createWhisperChunkRunner({
      modelId: "Xenova/whisper-tiny.en",
      onRecovery,
      createWorker
    });
    const promise = runner.transcribe(PCM(), {});
    await flush();

    workers[0].emitForJob({ type: "error", error: "bad audio" });

    await expect(promise).rejects.toThrow("bad audio");
    expect(onRecovery).not.toHaveBeenCalled();
    expect(workers).toHaveLength(1);
  });

  it("does not retry after a cancellation", async () => {
    const controller = new AbortController();
    const runner = createWhisperChunkRunner({ modelId: "Xenova/whisper-tiny.en", createWorker });
    const promise = runner.transcribe(PCM(), { signal: controller.signal });
    await flush();

    controller.abort();

    await promise.then(
      () => expect.unreachable("should have rejected"),
      (error) => expect(isAbortError(error)).toBe(true)
    );
    expect(workers).toHaveLength(1);
  });

  it("reuses one worker across sequential chunks", async () => {
    const runner = createWhisperChunkRunner({ modelId: "Xenova/whisper-tiny.en", createWorker });

    for (const text of ["one", "two"]) {
      const promise = runner.transcribe(PCM(), {});
      await flush();
      workers[0].emitForJob({ type: "done", text, segments: [], device: "webgpu" });
      await expect(promise).resolves.toMatchObject({ text });
    }

    expect(workers).toHaveLength(1);
    runner.terminate();
    expect(workers[0].terminated).toBe(1);
  });
});
