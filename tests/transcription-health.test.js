import { describe, it, expect } from "vitest";

import {
  buildTranscriptionHealthReport,
  nextAutoTranscribeAction,
  MAX_AUTO_TRANSCRIBE_ATTEMPTS
} from "../extension/lib/transcriptionHealth.js";

const healthy = {
  fileSystemAccessSupported: true,
  folderPermission: "granted",
  modelCached: true,
  online: true,
  modelConsent: "granted"
};

describe("buildTranscriptionHealthReport", () => {
  it("is ok when the folder is granted and the model is cached", () => {
    const report = buildTranscriptionHealthReport(healthy);
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.notices).toEqual([]);
  });

  it("treats a missing model as a self-resolving notice, not a blocker", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      modelCached: false,
      modelSizeLabel: "250 MB"
    });
    expect(report.ok).toBe(true);
    expect(report.notices).toHaveLength(1);
    expect(report.notices[0].code).toBe("model-download-pending");
    expect(report.notices[0].message).toContain("250 MB");
  });

  it("asks once before downloading a model the user has not consented to", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      modelCached: false,
      modelConsent: "unset",
      modelSizeLabel: "538 MB"
    });
    expect(report.ok).toBe(false);
    const blocker = report.blockers[0];
    expect(blocker.code).toBe("model-download-consent");
    expect(blocker.needsGesture).toBe(true);
    expect(blocker.actionLabel).toBe("Download (538 MB)");
    expect(blocker.secondaryLabel).toBe("Not now");
    expect(blocker.message).toContain("538 MB");
    expect(blocker.message).toContain("only asked once");
  });

  it("asks before the offline check, so the prompt is not pre-empted", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      modelCached: false,
      modelConsent: "unset",
      online: false
    });
    expect(report.blockers[0].code).toBe("model-download-consent");
  });

  it("does not ask again once the user declined", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      modelCached: false,
      modelConsent: "declined"
    });
    expect(report.blockers[0].code).toBe("model-download-declined");
    expect(report.blockers[0].needsGesture).toBe(false);
    expect(report.blockers[0].actionLabel).toBeUndefined();
  });

  it("never asks when the model is already cached", () => {
    const report = buildTranscriptionHealthReport({ ...healthy, modelConsent: "unset" });
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it("blocks on a missing model only when offline, and marks it auto-resuming", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      modelCached: false,
      online: false,
      modelConsent: "granted"
    });
    expect(report.ok).toBe(false);
    expect(report.blockers[0].code).toBe("model-download-offline");
    expect(report.blockers[0].autoResume).toBe("online");
    expect(report.blockers[0].needsGesture).toBe(false);
  });

  it("asks for a folder when none has been picked", () => {
    const report = buildTranscriptionHealthReport({ ...healthy, folderPermission: "none" });
    expect(report.ok).toBe(false);
    expect(report.blockers[0].code).toBe("folder-not-picked");
    expect(report.blockers[0].needsGesture).toBe(true);
    expect(report.blockers[0].actionLabel).toBe("Choose folder");
  });

  it("asks to restore access when the permission lapsed or was denied", () => {
    for (const folderPermission of ["prompt", "denied"]) {
      const report = buildTranscriptionHealthReport({ ...healthy, folderPermission });
      expect(report.blockers[0].code).toBe("folder-permission-lost");
      expect(report.blockers[0].needsGesture).toBe(true);
    }
  });

  it("reports an unusable browser without offering a button", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      fileSystemAccessSupported: false,
      folderPermission: "none"
    });
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0].code).toBe("no-file-system-access");
    expect(report.blockers[0].needsGesture).toBe(false);
    expect(report.blockers[0].actionLabel).toBeUndefined();
  });

  it("gives Brave users the specific flag to flip", () => {
    const report = buildTranscriptionHealthReport({
      ...healthy,
      fileSystemAccessSupported: false,
      isBrave: true
    });
    expect(report.blockers[0].message).toContain("brave://flags/#file-system-access-api");
  });

  it("reports both a folder blocker and an offline model blocker together", () => {
    const report = buildTranscriptionHealthReport({
      fileSystemAccessSupported: true,
      folderPermission: "none",
      modelCached: false,
      online: false,
      modelConsent: "granted"
    });
    expect(report.blockers.map((b) => b.code)).toEqual([
      "folder-not-picked",
      "model-download-offline"
    ]);
  });
});

describe("nextAutoTranscribeAction", () => {
  it("skips a recording that already has a transcript", () => {
    expect(nextAutoTranscribeAction({ attempts: 0 }, { hasTranscript: true })).toBe("skip-done");
  });

  it("runs a fresh recording", () => {
    expect(nextAutoTranscribeAction(undefined, { hasTranscript: false })).toBe("run");
    expect(nextAutoTranscribeAction({ attempts: 1 }, { hasTranscript: false })).toBe("run");
  });

  it("gives up rather than retrying forever", () => {
    expect(
      nextAutoTranscribeAction(
        { attempts: MAX_AUTO_TRANSCRIBE_ATTEMPTS },
        { hasTranscript: false }
      )
    ).toBe("give-up");
  });
});
