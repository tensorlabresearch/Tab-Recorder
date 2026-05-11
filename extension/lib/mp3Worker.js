import { encodePcmToMp3 } from "./mp3Encoding.js";

self.onmessage = (event) => {
  const data = event.data;
  if (!data || data.type !== "encode") return;
  const { jobId } = data;
  try {
    const merged = encodePcmToMp3({
      left: data.left,
      right: data.right,
      sampleRate: data.sampleRate,
      bitrate: data.bitrate || 128,
      onProgress: (progress) => {
        self.postMessage({ type: "progress", jobId, progress });
      }
    });
    self.postMessage(
      { type: "done", jobId, mp3: merged.buffer },
      [merged.buffer]
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      jobId,
      error: String(error?.message || error)
    });
  }
};
