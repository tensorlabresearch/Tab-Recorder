/**
 * Sequential job queue for recording operations (transcribe, diarize, MP3, summarize).
 *
 * Jobs are executed one at a time in FIFO order. Each job has a type, a
 * human-readable label, a session identifier, and an async runner function.
 * The queue emits state changes via a subscriber callback so the UI can
 * render a floating job panel.
 */

/**
 * @typedef {Object} Job
 * @property {string} id
 * @property {string} type        - "transcribe" | "diarize" | "convert-mp3" | "summarize"
 * @property {string} label       - Human-readable label for the job
 * @property {string} sessionId   - Session ID the job operates on
 * @property {string} sessionLabel - Display name of the session
 * @property {function} run       - Async function that does the work
 * @property {"queued"|"running"|"done"|"error"|"cancelled"} status
 * @property {string} [error]     - Error message if status === "error"
 * @property {string} [progressLabel] - Current progress label for running jobs
 * @property {number} enqueuedAt  - Timestamp when enqueued
 * @property {number} [startedAt] - Timestamp when execution started
 * @property {number} [endedAt]   - Timestamp when execution finished
 */

let jobCounter = 0;
const queue = [];
let running = false;

/** @type {function(Job[], Job|null)[]} */
const subscribers = [];

/**
 * Subscribe to job queue state changes.
 * @param {function(Job[], Job|null) => void} cb
 * @returns {function()} unsubscribe
 */
export function subscribe(cb) {
  subscribers.push(cb);
  cb(getAllJobs(), getCurrentJob());
  return () => {
    const i = subscribers.indexOf(cb);
    if (i >= 0) subscribers.splice(i, 1);
  };
}

function notify(changedJob) {
  for (const cb of subscribers) {
    try { cb(getAllJobs(), changedJob); } catch (_) {}
  }
}

/**
 * @returns {Job[]}
 */
export function getAllJobs() {
  return [...queue];
}

/**
 * @returns {Job|null}
 */
export function getCurrentJob() {
  return queue.find((j) => j.status === "running") || null;
}

/**
 * @returns {number}
 */
export function getQueuedCount() {
  return queue.filter((j) => j.status === "queued").length;
}

/**
 * Enqueue a new job.
 * @param {Object} opts
 * @param {string} opts.type
 * @param {string} opts.label
 * @param {string} opts.sessionId
 * @param {string} opts.sessionLabel
 * @param {function} opts.run
 * @returns {Job}
 */
export function enqueue(opts) {
  const job = {
    id: `job-${++jobCounter}`,
    type: opts.type,
    label: opts.label,
    sessionId: opts.sessionId,
    sessionLabel: opts.sessionLabel || opts.sessionId,
    run: opts.run,
    status: "queued",
    enqueuedAt: Date.now(),
  };
  queue.push(job);
  notify(job);
  processQueue();
  return job;
}

/**
 * Update the progress label of the currently running job.
 * @param {string} label
 */
export function updateJobProgress(label) {
  const job = getCurrentJob();
  if (!job || job.status !== "running") return;
  job.progressLabel = label;
  notify(job);
}

/**
 * Cancel a queued job (cannot cancel a running job).
 * @param {string} jobId
 * @returns {boolean}
 */
export function cancel(jobId) {
  const job = queue.find((j) => j.id === jobId && j.status === "queued");
  if (!job) return false;
  job.status = "cancelled";
  job.endedAt = Date.now();
  notify(job);
  return true;
}

/**
 * Cancel all queued jobs.
 */
export function cancelAll() {
  for (const job of queue) {
    if (job.status === "queued") {
      job.status = "cancelled";
      job.endedAt = Date.now();
    }
  }
  notify(null);
}

/**
 * Remove finished (done/error/cancelled) jobs from the queue.
 */
export function clearFinished() {
  for (let i = queue.length - 1; i >= 0; i--) {
    const s = queue[i].status;
    if (s === "done" || s === "error" || s === "cancelled") {
      queue.splice(i, 1);
    }
  }
  notify(null);
}

async function processQueue() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const job = queue.find((j) => j.status === "queued");
      if (!job) break;
      job.status = "running";
      job.startedAt = Date.now();
      notify(job);
      try {
        await job.run();
        job.status = "done";
      } catch (err) {
        job.status = "error";
        job.error = err?.message || String(err);
      }
      job.endedAt = Date.now();
      notify(job);
    }
  } finally {
    running = false;
  }
}

/**
 * Reset the queue (for testing).
 */
export function _reset() {
  queue.length = 0;
  running = false;
  jobCounter = 0;
}
