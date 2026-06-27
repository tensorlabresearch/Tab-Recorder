import { TRANSCRIPTION_SAMPLE_RATE } from "./transcriptionChunks.js";

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_TRACKS = 0x1654ae6b;
const ID_TRACK_ENTRY = 0xae;
const ID_TRACK_NUMBER = 0xd7;
const ID_TRACK_TYPE = 0x83;
const ID_CODEC_ID = 0x86;
const ID_CODEC_PRIVATE = 0x63a2;
const ID_CODEC_DELAY = 0x56aa;
const ID_SEEK_PRE_ROLL = 0x56bb;
const ID_AUDIO = 0xe1;
const ID_SAMPLING_FREQUENCY = 0xb5;
const ID_CHANNELS = 0x9f;
const ID_CLUSTER = 0x1f43b675;
const ID_CLUSTER_TIMECODE = 0xe7;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;
const ID_BLOCK = 0xa1;
const ID_BLOCK_DURATION = 0x9b;

const TRACK_TYPE_AUDIO = 2;
const DEFAULT_TIMECODE_SCALE_NS = 1000000;
const DEFAULT_OPUS_SAMPLE_RATE = 48000;
const DEFAULT_OPUS_SEEK_PRE_ROLL_US = 80000;
const MAX_DECODE_QUEUE_SIZE = 80;

export function canDecodeWebmOpusWithWebCodecs() {
  return (
    typeof AudioDecoder === "function" &&
    typeof EncodedAudioChunk === "function" &&
    typeof AudioData === "function"
  );
}

export async function* decodeWebmOpusChunks(file, plan, { onProgress } = {}) {
  if (!canDecodeWebmOpusWithWebCodecs()) {
    throw new Error("WebCodecs AudioDecoder is not available in this browser.");
  }
  if (!file) throw new Error("File required.");
  if (!plan?.chunks?.length) return;

  const arrayBuffer = await file.arrayBuffer();
  const demuxed = demuxWebmOpus(arrayBuffer);
  if (!demuxed.packets.length) {
    throw new Error("No WebM/Opus audio packets found.");
  }

  for (const chunk of plan.chunks) {
    const decoded = await decodeWebmOpusChunk(demuxed, chunk, {
      onProgress: (progress) => onProgress?.({ chunk, ...progress })
    });
    yield { chunk, ...decoded };
  }
}

export function demuxWebmOpus(arrayBuffer) {
  const source =
    arrayBuffer instanceof ArrayBuffer
      ? arrayBuffer
      : arrayBuffer?.buffer instanceof ArrayBuffer
        ? arrayBuffer.buffer
        : null;
  if (!source) throw new Error("ArrayBuffer required.");

  const ctx = {
    buffer: source,
    view: new DataView(source),
    timecodeScaleNs: DEFAULT_TIMECODE_SCALE_NS,
    audioTrack: null,
    clusters: [],
    packets: []
  };

  let foundSegment = false;
  forEachElement(ctx, 0, source.byteLength, (el) => {
    if (el.id !== ID_SEGMENT) return;
    foundSegment = true;
    parseSegment(ctx, el.dataStart, el.dataEnd);
  });

  if (!foundSegment) throw new Error("WebM segment not found.");
  if (!ctx.audioTrack) throw new Error("WebM/Opus audio track not found.");

  for (const cluster of ctx.clusters) {
    parseCluster(ctx, cluster.start, cluster.end);
  }

  ctx.packets.sort((a, b) => a.timestampUs - b.timestampUs);
  for (let i = 0; i < ctx.packets.length; i++) {
    const packet = ctx.packets[i];
    const next = ctx.packets[i + 1];
    if (!packet.durationUs && next && next.timestampUs > packet.timestampUs) {
      packet.durationUs = next.timestampUs - packet.timestampUs;
    }
    if (!packet.durationUs) packet.durationUs = opusPacketDurationUs(packet.data) || 60000;
  }

  return {
    sampleRate: ctx.audioTrack.sampleRate || DEFAULT_OPUS_SAMPLE_RATE,
    channels: ctx.audioTrack.channels || 1,
    codecPrivate: ctx.audioTrack.codecPrivate || null,
    codecDelayUs: Math.round((ctx.audioTrack.codecDelayNs || 0) / 1000),
    seekPreRollUs: Math.round((ctx.audioTrack.seekPreRollNs || 0) / 1000) || DEFAULT_OPUS_SEEK_PRE_ROLL_US,
    packets: ctx.packets
  };
}

async function decodeWebmOpusChunk(demuxed, chunk, { onProgress } = {}) {
  const startUs = Math.round(chunk.audioStartMs * 1000);
  const endUs = Math.round(chunk.audioEndMs * 1000);
  const preRollUs = Number(demuxed.seekPreRollUs) || DEFAULT_OPUS_SEEK_PRE_ROLL_US;
  const decodeStartUs = Math.max(0, startUs - preRollUs);
  const packets = demuxed.packets.filter((packet) => {
    const packetEndUs = packet.timestampUs + (packet.durationUs || 0);
    return packetEndUs >= decodeStartUs && packet.timestampUs <= endUs;
  });

  if (!packets.length) {
    return {
      pcm16k: new Float32Array(Math.max(1, Math.ceil(((endUs - startUs) / 1000000) * TRANSCRIPTION_SAMPLE_RATE))),
      packetCount: 0,
      decodedFrames: 0
    };
  }

  const targetSamples = Math.max(
    1,
    Math.ceil(((endUs - startUs) / 1000000) * TRANSCRIPTION_SAMPLE_RATE)
  );
  const pcm16k = new Float32Array(targetSamples);
  const config = {
    codec: "opus",
    sampleRate: demuxed.sampleRate || DEFAULT_OPUS_SAMPLE_RATE,
    numberOfChannels: demuxed.channels || 1
  };
  if (demuxed.codecPrivate?.byteLength) {
    config.description = demuxed.codecPrivate;
  }

  let decodedFrames = 0;
  let decoderError = null;
  const decoder = new AudioDecoder({
    output: (audioData) => {
      try {
        mixAudioDataInto16kMono(audioData, pcm16k, startUs);
        decodedFrames += audioData.numberOfFrames || 0;
      } finally {
        audioData.close();
      }
    },
    error: (error) => {
      decoderError = error;
    }
  });

  if (typeof AudioDecoder.isConfigSupported === "function") {
    const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
    if (support && support.supported === false) {
      throw new Error("This browser does not support WebCodecs Opus decoding.");
    }
  }

  decoder.configure(config);
  let fed = 0;
  try {
    for (const packet of packets) {
      if (decoderError) throw decoderError;
      decoder.decode(
        new EncodedAudioChunk({
          type: "key",
          timestamp: packet.timestampUs,
          duration: packet.durationUs || undefined,
          data: packet.data
        })
      );
      fed += 1;
      if (fed % 100 === 0 || decoder.decodeQueueSize > MAX_DECODE_QUEUE_SIZE) {
        await decoder.flush();
        onProgress?.({ fed, total: packets.length, decodedFrames });
      }
    }
    await decoder.flush();
  } finally {
    decoder.close();
  }
  if (decoderError) throw decoderError;
  return { pcm16k, packetCount: packets.length, decodedFrames };
}

function mixAudioDataInto16kMono(audioData, target, targetStartUs) {
  const frames = Number(audioData.numberOfFrames) || 0;
  const channels = Math.max(1, Number(audioData.numberOfChannels) || 1);
  const sourceRate = Number(audioData.sampleRate) || DEFAULT_OPUS_SAMPLE_RATE;
  if (frames <= 0) return;

  const planes = [];
  for (let ch = 0; ch < channels; ch++) {
    const data = new Float32Array(frames);
    audioData.copyTo(data, { planeIndex: ch, format: "f32-planar" });
    planes.push(data);
  }

  const sourceStartUs = Number(audioData.timestamp) || 0;
  const sourceEndUs = sourceStartUs + Math.round((frames / sourceRate) * 1000000);
  const targetRate = TRANSCRIPTION_SAMPLE_RATE;
  const targetStart = Math.max(
    0,
    Math.floor(((sourceStartUs - targetStartUs) / 1000000) * targetRate)
  );
  const targetEnd = Math.min(
    target.length,
    Math.ceil(((sourceEndUs - targetStartUs) / 1000000) * targetRate)
  );

  for (let i = targetStart; i < targetEnd; i++) {
    const absoluteUs = targetStartUs + (i / targetRate) * 1000000;
    const sourcePos = ((absoluteUs - sourceStartUs) / 1000000) * sourceRate;
    const leftIndex = Math.floor(sourcePos);
    if (leftIndex < 0 || leftIndex >= frames) continue;
    const rightIndex = Math.min(frames - 1, leftIndex + 1);
    const frac = sourcePos - leftIndex;
    let sum = 0;
    for (const plane of planes) {
      sum += plane[leftIndex] + (plane[rightIndex] - plane[leftIndex]) * frac;
    }
    target[i] = sum / planes.length;
  }
}

function parseSegment(ctx, start, end) {
  let pos = start;
  while (pos < end) {
    const el = readElementHeader(ctx.view, pos, end);
    if (!el) break;
    if (el.id === ID_INFO) {
      parseInfo(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_TRACKS) {
      parseTracks(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_CLUSTER) {
      const clusterEnd = el.unknown
        ? findNextElementStart(ctx, el.dataStart, end, ID_CLUSTER) || end
        : el.dataEnd;
      ctx.clusters.push({ start: el.dataStart, end: clusterEnd });
      pos = clusterEnd;
      continue;
    }
    if (el.dataEnd <= pos) break;
    pos = el.dataEnd;
  }
}

function parseInfo(ctx, start, end) {
  forEachElement(ctx, start, end, (el) => {
    if (el.id === ID_TIMECODE_SCALE) {
      const value = readUnsigned(ctx, el.dataStart, el.dataEnd);
      if (value > 0) ctx.timecodeScaleNs = value;
    }
  });
}

function parseTracks(ctx, start, end) {
  forEachElement(ctx, start, end, (el) => {
    if (el.id !== ID_TRACK_ENTRY) return;
    const track = parseTrackEntry(ctx, el.dataStart, el.dataEnd);
    if (track.type === TRACK_TYPE_AUDIO && track.codecId === "A_OPUS") {
      ctx.audioTrack = track;
    }
  });
}

function parseTrackEntry(ctx, start, end) {
  const track = {
    number: 0,
    type: 0,
    codecId: "",
    codecPrivate: null,
    sampleRate: DEFAULT_OPUS_SAMPLE_RATE,
    channels: 1,
    codecDelayNs: 0,
    seekPreRollNs: 0
  };

  forEachElement(ctx, start, end, (el) => {
    if (el.id === ID_TRACK_NUMBER) {
      track.number = readUnsigned(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_TRACK_TYPE) {
      track.type = readUnsigned(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_CODEC_ID) {
      track.codecId = readAscii(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_CODEC_PRIVATE) {
      track.codecPrivate = new Uint8Array(ctx.buffer, el.dataStart, el.dataEnd - el.dataStart);
      applyOpusHead(track, track.codecPrivate);
    } else if (el.id === ID_CODEC_DELAY) {
      track.codecDelayNs = readUnsigned(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_SEEK_PRE_ROLL) {
      track.seekPreRollNs = readUnsigned(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_AUDIO) {
      parseAudioTrack(ctx, el.dataStart, el.dataEnd, track);
    }
  });

  return track;
}

function parseAudioTrack(ctx, start, end, track) {
  forEachElement(ctx, start, end, (el) => {
    if (el.id === ID_SAMPLING_FREQUENCY) {
      const value = readFloat(ctx, el.dataStart, el.dataEnd);
      if (value > 0) track.sampleRate = value;
    } else if (el.id === ID_CHANNELS) {
      const value = readUnsigned(ctx, el.dataStart, el.dataEnd);
      if (value > 0) track.channels = value;
    }
  });
}

function parseCluster(ctx, start, end) {
  let clusterTimecode = 0;
  forEachElement(ctx, start, end, (el) => {
    if (el.id === ID_CLUSTER_TIMECODE) {
      clusterTimecode = readUnsigned(ctx, el.dataStart, el.dataEnd);
    } else if (el.id === ID_SIMPLE_BLOCK) {
      parseBlock(ctx, el.dataStart, el.dataEnd, clusterTimecode, null);
    } else if (el.id === ID_BLOCK_GROUP) {
      parseBlockGroup(ctx, el.dataStart, el.dataEnd, clusterTimecode);
    }
  });
}

function parseBlockGroup(ctx, start, end, clusterTimecode) {
  let block = null;
  let durationTicks = null;
  forEachElement(ctx, start, end, (el) => {
    if (el.id === ID_BLOCK) {
      block = el;
    } else if (el.id === ID_BLOCK_DURATION) {
      durationTicks = readUnsigned(ctx, el.dataStart, el.dataEnd);
    }
  });
  if (block) parseBlock(ctx, block.dataStart, block.dataEnd, clusterTimecode, durationTicks);
}

function parseBlock(ctx, start, end, clusterTimecode, durationTicks) {
  let pos = start;
  const trackInfo = readVint(ctx.view, pos, false);
  pos += trackInfo.length;
  if (trackInfo.value !== ctx.audioTrack.number) return;
  if (pos + 3 > end) return;

  const blockTimecode = ctx.view.getInt16(pos, false);
  pos += 2;
  const flags = ctx.view.getUint8(pos);
  pos += 1;

  const timestampTicks = clusterTimecode + blockTimecode;
  const timestampUs = Math.round((timestampTicks * ctx.timecodeScaleNs) / 1000);
  const blockDurationUs =
    durationTicks == null ? null : Math.round((durationTicks * ctx.timecodeScaleNs) / 1000);
  const lacing = flags & 0x06;
  const frames = splitBlockFrames(ctx, pos, end, lacing);
  const fixedDurationUs = blockDurationUs ? Math.round(blockDurationUs / frames.length) : null;
  let frameTimestampUs = timestampUs;

  for (const frame of frames) {
    const data = new Uint8Array(ctx.buffer, frame.start, frame.end - frame.start);
    const durationUs = fixedDurationUs || opusPacketDurationUs(data) || null;
    ctx.packets.push({
      timestampUs: frameTimestampUs,
      durationUs,
      data
    });
    frameTimestampUs += durationUs || 0;
  }
}

function splitBlockFrames(ctx, start, end, lacing) {
  if (lacing === 0) return [{ start, end }];

  let pos = start;
  const frameCount = ctx.view.getUint8(pos) + 1;
  pos += 1;
  if (frameCount <= 1) return [{ start: pos, end }];

  const sizes = [];
  if (lacing === 0x02) {
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      let value = 255;
      while (pos < end && value === 255) {
        value = ctx.view.getUint8(pos);
        pos += 1;
        size += value;
      }
      sizes.push(size);
    }
  } else if (lacing === 0x04) {
    const size = Math.floor((end - pos) / frameCount);
    for (let i = 0; i < frameCount - 1; i++) sizes.push(size);
  } else if (lacing === 0x06) {
    const first = readVint(ctx.view, pos, false);
    pos += first.length;
    sizes.push(first.value);
    for (let i = 1; i < frameCount - 1; i++) {
      const next = readSignedVint(ctx.view, pos);
      pos += next.length;
      sizes.push(sizes[i - 1] + next.value);
    }
  }

  const consumed = sizes.reduce((sum, size) => sum + size, 0);
  sizes.push(Math.max(0, end - pos - consumed));
  const frames = [];
  for (const size of sizes) {
    const frameEnd = Math.min(end, pos + size);
    frames.push({ start: pos, end: frameEnd });
    pos = frameEnd;
  }
  return frames.filter((frame) => frame.end > frame.start);
}

function forEachElement(ctx, start, end, fn) {
  let pos = start;
  while (pos < end) {
    const header = readElementHeader(ctx.view, pos, end);
    if (!header) break;
    fn(header);
    if (header.dataEnd <= pos) break;
    pos = header.dataEnd;
  }
}

function readElementHeader(view, pos, end) {
  if (pos >= end) return null;
  const id = readVint(view, pos, true);
  const size = readVint(view, pos + id.length, false);
  const dataStart = pos + id.length + size.length;
  if (dataStart > end) return null;
  const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
  return { id: id.value, size: size.value, dataStart, dataEnd, start: pos, unknown: size.unknown };
}

function findNextElementStart(ctx, start, end, targetId) {
  let pos = start;
  while (pos < end) {
    const el = readElementHeader(ctx.view, pos, end);
    if (!el) return null;
    if (el.id === targetId) return el.start;
    if (el.dataEnd <= pos) return null;
    pos = el.dataEnd;
  }
  return null;
}

function readVint(view, pos, keepMarker) {
  const first = view.getUint8(pos);
  let mask = 0x80;
  let length = 1;
  while (length <= 8 && (first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 8) throw new Error("Invalid EBML variable integer.");

  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i++) {
    value = value * 256 + view.getUint8(pos + i);
  }
  const unknown = !keepMarker && value === Math.pow(2, 7 * length) - 1;
  return { value, length, unknown };
}

function readSignedVint(view, pos) {
  const unsigned = readVint(view, pos, false);
  const bias = Math.pow(2, 7 * unsigned.length - 1) - 1;
  return {
    value: unsigned.value - bias,
    length: unsigned.length
  };
}

function readUnsigned(ctx, start, end) {
  let value = 0;
  for (let pos = start; pos < end; pos++) {
    value = value * 256 + ctx.view.getUint8(pos);
  }
  return value;
}

function readFloat(ctx, start, end) {
  const length = end - start;
  if (length === 4) return ctx.view.getFloat32(start, false);
  if (length === 8) return ctx.view.getFloat64(start, false);
  return 0;
}

function readAscii(ctx, start, end) {
  let out = "";
  for (let pos = start; pos < end; pos++) out += String.fromCharCode(ctx.view.getUint8(pos));
  return out;
}

function applyOpusHead(track, bytes) {
  if (!bytes || bytes.byteLength < 19) return;
  const magic = String.fromCharCode(...bytes.slice(0, 8));
  if (magic !== "OpusHead") return;
  track.channels = bytes[9] || track.channels;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const inputRate = view.getUint32(12, true);
  if (inputRate > 0) track.sampleRate = inputRate;
}

function opusPacketDurationUs(packet) {
  if (!packet || packet.byteLength < 1) return 0;
  const toc = packet[0];
  const config = toc >> 3;
  const code = toc & 0x03;
  let frameCount = 1;
  if (code === 1 || code === 2) {
    frameCount = 2;
  } else if (code === 3) {
    if (packet.byteLength < 2) return 0;
    frameCount = packet[1] & 0x3f;
  }

  let frameUs;
  if (config < 12) {
    frameUs = [10000, 20000, 40000, 60000][config & 0x03];
  } else if (config < 16) {
    frameUs = [10000, 20000, 10000, 20000][config - 12];
  } else {
    frameUs = [2500, 5000, 10000, 20000][config & 0x03];
  }
  return frameUs * frameCount;
}
