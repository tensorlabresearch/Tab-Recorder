/**
 * Preflight health check for transcription.
 *
 * Transcription has three prerequisites the user cannot see: read access to the
 * recordings folder, a downloaded speech model, and a browser that exposes the
 * File System Access API. When one is missing the honest thing to do is fix it
 * automatically; only a permission prompt genuinely needs the user, because
 * Chrome requires a user gesture for it.
 *
 * This module is pure: the caller injects the environment so the decision table
 * stays testable.
 */

/**
 * @typedef {Object} HealthIssue
 * @property {string} code
 * @property {string} message      - Shown to the user verbatim.
 * @property {boolean} needsGesture - True when only a user click can fix it.
 * @property {string} [actionLabel] - Button text when needsGesture is true.
 * @property {string} [secondaryLabel] - Text for the decline/secondary button.
 * @property {"online"} [autoResume] - Event that should retry this on its own.
 */

/**
 * @typedef {Object} HealthReport
 * @property {boolean} ok            - Safe to start transcribing now.
 * @property {HealthIssue[]} blockers - Must clear before transcription can run.
 * @property {HealthIssue[]} notices  - Things that resolve themselves; informational.
 */

/**
 * @param {Object} env
 * @param {boolean} env.fileSystemAccessSupported
 * @param {boolean} [env.isBrave]
 * @param {"granted"|"prompt"|"denied"|"none"} env.folderPermission
 * @param {boolean} env.modelCached
 * @param {boolean} env.online
 * @param {"granted"|"declined"|"unset"} [env.modelConsent]
 * @param {string} [env.modelSizeLabel]
 * @returns {HealthReport}
 */
export function buildTranscriptionHealthReport({
  fileSystemAccessSupported,
  isBrave = false,
  folderPermission,
  modelCached,
  online,
  modelConsent = "granted",
  modelSizeLabel = ""
} = {}) {
  const blockers = [];
  const notices = [];

  if (!fileSystemAccessSupported) {
    blockers.push({
      code: "no-file-system-access",
      needsGesture: false,
      message: isBrave
        ? "Brave has the File System Access API turned off, so recordings cannot be " +
          "read back for transcription. Enable brave://flags/#file-system-access-api, " +
          "relaunch Brave, then reopen Tab Recorder."
        : "This browser cannot read saved recordings back (no File System Access API), " +
          "so transcription is unavailable. Chrome 86+ or Edge supports it."
    });
  } else if (folderPermission === "none") {
    blockers.push({
      code: "folder-not-picked",
      needsGesture: true,
      actionLabel: "Choose folder",
      message:
        "Transcription needs to read the recording back, which means one-time access " +
        "to your recordings folder."
    });
  } else if (folderPermission === "prompt" || folderPermission === "denied") {
    blockers.push({
      code: "folder-permission-lost",
      needsGesture: true,
      actionLabel: "Restore access",
      message: "Chrome dropped access to your recordings folder. One click restores it."
    });
  }

  if (!modelCached && modelConsent === "declined") {
    blockers.push({
      code: "model-download-declined",
      needsGesture: false,
      message:
        "The speech model has not been downloaded, so automatic transcription is paused. " +
        "Use the Transcribe button on a recording, or pick a model in Settings."
    });
  } else if (!modelCached && modelConsent === "unset") {
    // The one and only prompt: downloading hundreds of megabytes unannounced
    // is not something to do on a user's behalf.
    blockers.push({
      code: "model-download-consent",
      needsGesture: true,
      actionLabel: modelSizeLabel ? `Download (${modelSizeLabel})` : "Download model",
      secondaryLabel: "Not now",
      message:
        `Transcription runs on your machine and needs a one-time speech model download` +
        `${modelSizeLabel ? ` of about ${modelSizeLabel}` : ""}. ` +
        "Nothing is uploaded, and this is only asked once."
    });
  } else if (!modelCached && !online) {
    blockers.push({
      code: "model-download-offline",
      needsGesture: false,
      autoResume: "online",
      message:
        "The speech model still needs to download. Transcription will start on its own " +
        "once you are back online."
    });
  } else if (!modelCached) {
    notices.push({
      code: "model-download-pending",
      needsGesture: false,
      message: modelSizeLabel
        ? `Downloading the speech model (${modelSizeLabel}, one time).`
        : "Downloading the speech model (one time)."
    });
  }

  return { ok: blockers.length === 0, blockers, notices };
}

export const MAX_AUTO_TRANSCRIBE_ATTEMPTS = 3;

/**
 * Decide what to do with a recording that was queued for auto-transcription.
 * Keeping this pure makes the give-up rule explicit and testable, so a
 * recording that can never succeed (silent audio, say) cannot become an
 * infinite retry loop across panel reloads.
 *
 * @param {{attempts?: number}|undefined} entry
 * @param {{hasTranscript: boolean}} state
 * @returns {"skip-done"|"give-up"|"run"}
 */
export function nextAutoTranscribeAction(entry, { hasTranscript } = {}) {
  if (hasTranscript) return "skip-done";
  const attempts = Number(entry?.attempts) || 0;
  if (attempts >= MAX_AUTO_TRANSCRIBE_ATTEMPTS) return "give-up";
  return "run";
}
