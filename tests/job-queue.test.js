import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  enqueue,
  subscribe,
  cancel,
  cancelAll,
  clearFinished,
  getAllJobs,
  getCurrentJob,
  getQueuedCount,
  updateJobProgress,
  _reset,
} from "../extension/lib/jobQueue.js";

beforeEach(() => {
  _reset();
});

describe("enqueue", () => {
  it("adds a job to the queue", () => {
    const run = () => new Promise(() => {});
    const job = enqueue({
      type: "transcribe",
      label: "Transcribe",
      sessionId: "s1",
      sessionLabel: "Session 1",
      run,
    });
    expect(job.id).toBeTruthy();
    expect(["queued", "running"]).toContain(job.status);
    expect(job.type).toBe("transcribe");
    expect(job.sessionId).toBe("s1");
    expect(getAllJobs()).toHaveLength(1);
  });

  it("starts processing immediately", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => expect(run).toHaveBeenCalled());
  });

  it("runs jobs sequentially", async () => {
    const order = [];
    const run1 = vi.fn().mockImplementation(async () => {
      order.push("job1-start");
      await new Promise((r) => setTimeout(r, 20));
      order.push("job1-end");
    });
    const run2 = vi.fn().mockImplementation(async () => {
      order.push("job2-start");
      await new Promise((r) => setTimeout(r, 10));
      order.push("job2-end");
    });
    enqueue({ type: "transcribe", label: "T1", sessionId: "s1", run: run1 });
    enqueue({ type: "diarize", label: "D1", sessionId: "s2", run: run2 });
    await vi.waitFor(() => expect(run2).toHaveBeenCalled(), { timeout: 1000 });
    expect(order).toEqual(["job1-start", "job1-end", "job2-start", "job2-end"]);
  });
});

describe("job lifecycle", () => {
  it("transitions from queued to done", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const job = enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => {
      const updated = getAllJobs().find((j) => j.id === job.id);
      expect(updated?.status).toBe("done");
    });
    expect(getCurrentJob()).toBeNull();
  });

  it("transitions to error on failure", async () => {
    const run = vi.fn().mockRejectedValue(new Error("Failed"));
    const job = enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => {
      const updated = getAllJobs().find((j) => j.id === job.id);
      expect(updated?.status).toBe("error");
      expect(updated?.error).toBe("Failed");
    });
  });

  it("sets startedAt and endedAt timestamps", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const job = enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => {
      const updated = getAllJobs().find((j) => j.id === job.id);
      expect(updated?.status).toBe("done");
    });
    const updated = getAllJobs().find((j) => j.id === job.id);
    expect(updated?.startedAt).toBeGreaterThan(0);
    expect(updated?.endedAt).toBeGreaterThanOrEqual(updated.startedAt);
  });
});

describe("cancel", () => {
  it("cancels a queued job", async () => {
    const blocker = new Promise(() => {});
    const run1 = vi.fn().mockReturnValue(blocker);
    const run2 = vi.fn().mockResolvedValue(undefined);
    const job1 = enqueue({ type: "transcribe", label: "T1", sessionId: "s1", run: run1 });
    const job2 = enqueue({ type: "transcribe", label: "T2", sessionId: "s2", run: run2 });

    await vi.waitFor(() => expect(getCurrentJob()?.id).toBe(job1.id));

    expect(cancel(job2.id)).toBe(true);
    const cancelled = getAllJobs().find((j) => j.id === job2.id);
    expect(cancelled?.status).toBe("cancelled");
  });

  it("cannot cancel a running job", async () => {
    const blocker = new Promise(() => {});
    const run = vi.fn().mockReturnValue(blocker);
    const job = enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => expect(getCurrentJob()?.id).toBe(job.id));
    expect(cancel(job.id)).toBe(false);
  });

  it("returns false for unknown job id", () => {
    expect(cancel("nonexistent")).toBe(false);
  });
});

describe("cancelAll", () => {
  it("cancels all queued jobs", async () => {
    const blocker = new Promise(() => {});
    const run1 = vi.fn().mockReturnValue(blocker);
    const run2 = vi.fn().mockResolvedValue(undefined);
    const run3 = vi.fn().mockResolvedValue(undefined);
    enqueue({ type: "transcribe", label: "T1", sessionId: "s1", run: run1 });
    enqueue({ type: "transcribe", label: "T2", sessionId: "s2", run: run2 });
    enqueue({ type: "transcribe", label: "T3", sessionId: "s3", run: run3 });

    await vi.waitFor(() => expect(getCurrentJob()).not.toBeNull());
    cancelAll();

    const queued = getAllJobs().filter((j) => j.status === "queued");
    expect(queued).toHaveLength(0);
  });
});

describe("clearFinished", () => {
  it("removes finished jobs", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => {
      expect(getAllJobs()[0]?.status).toBe("done");
    });
    clearFinished();
    expect(getAllJobs()).toHaveLength(0);
  });

  it("keeps queued and running jobs", async () => {
    const blocker = new Promise(() => {});
    const run1 = vi.fn().mockReturnValue(blocker);
    const run2 = vi.fn().mockResolvedValue(undefined);
    enqueue({ type: "transcribe", label: "T1", sessionId: "s1", run: run1 });
    enqueue({ type: "transcribe", label: "T2", sessionId: "s2", run: run2 });
    await vi.waitFor(() => expect(getCurrentJob()).not.toBeNull());
    clearFinished();
    expect(getAllJobs()).toHaveLength(2);
  });
});

describe("getQueuedCount", () => {
  it("returns count of queued jobs", async () => {
    const blocker = new Promise(() => {});
    enqueue({ type: "transcribe", label: "T1", sessionId: "s1", run: () => blocker });
    enqueue({ type: "transcribe", label: "T2", sessionId: "s2", run: vi.fn() });
    enqueue({ type: "transcribe", label: "T3", sessionId: "s3", run: vi.fn() });
    await vi.waitFor(() => expect(getCurrentJob()).not.toBeNull());
    expect(getQueuedCount()).toBe(2);
  });
});

describe("subscribe", () => {
  it("calls subscriber immediately with current state", () => {
    const cb = vi.fn();
    subscribe(cb);
    expect(cb).toHaveBeenCalledWith([], null);
  });

  it("notifies on enqueue", () => {
    const cb = vi.fn();
    subscribe(cb);
    cb.mockClear();
    enqueue({ type: "transcribe", label: "T", sessionId: "s1", run: vi.fn() });
    expect(cb).toHaveBeenCalled();
  });

  it("returns unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = subscribe(cb);
    expect(typeof unsub).toBe("function");
    unsub();
    cb.mockClear();
    enqueue({ type: "transcribe", label: "T", sessionId: "s1", run: vi.fn() });
    expect(cb).not.toHaveBeenCalled();
  });

  it("notifies on job completion", async () => {
    const cb = vi.fn();
    subscribe(cb);
    cb.mockClear();
    const run = vi.fn().mockResolvedValue(undefined);
    enqueue({ type: "transcribe", label: "T", sessionId: "s1", run });
    await vi.waitFor(() => {
      const doneCall = cb.mock.calls.find((c) => {
        const jobs = c[0];
        return jobs.some((j) => j.status === "done");
      });
      expect(doneCall).toBeTruthy();
    });
  });
});

describe("updateJobProgress", () => {
  it("updates the running job's progress label", async () => {
    let resolve;
    const blocker = new Promise((r) => { resolve = r; });
    const job = enqueue({
      type: "transcribe",
      label: "T",
      sessionId: "s1",
      run: () => blocker,
    });
    await vi.waitFor(() => expect(getCurrentJob()?.id).toBe(job.id));

    updateJobProgress("Decoding");
    expect(getCurrentJob().progressLabel).toBe("Decoding");

    updateJobProgress("Encoding");
    expect(getCurrentJob().progressLabel).toBe("Encoding");

    resolve();
    await vi.waitFor(() => {
      expect(getAllJobs().find((j) => j.id === job.id)?.status).toBe("done");
    });
  });

  it("does nothing when no job is running", () => {
    updateJobProgress("test");
    expect(getCurrentJob()).toBeNull();
  });

  it("notifies subscribers on progress update", async () => {
    let resolve;
    const blocker = new Promise((r) => { resolve = r; });
    const cb = vi.fn();
    subscribe(cb);
    cb.mockClear();

    enqueue({
      type: "transcribe",
      label: "T",
      sessionId: "s1",
      run: () => blocker,
    });
    await vi.waitFor(() => expect(getCurrentJob()).not.toBeNull());
    cb.mockClear();

    updateJobProgress("Encoding");
    const progressCall = cb.mock.calls.find((c) => {
      const changed = c[1];
      return changed?.progressLabel === "Encoding";
    });
    expect(progressCall).toBeTruthy();

    resolve();
  });
});
