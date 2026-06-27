import { describe, expect, it } from "vitest";
import { demuxWebmOpus } from "../extension/lib/webmOpusDecoder.js";

describe("demuxWebmOpus", () => {
  it("handles consecutive unknown-size clusters", () => {
    const webm = bytes(
      element([0x18, 0x53, 0x80, 0x67], bytes(
        element([0x15, 0x49, 0xa9, 0x66], bytes(
          element([0x2a, 0xd7, 0xb1], uint(1_000_000))
        )),
        element([0x16, 0x54, 0xae, 0x6b], bytes(
          element([0xae], bytes(
            element([0xd7], [0x01]),
            element([0x83], [0x02]),
            element([0x86], ascii("A_OPUS")),
            element([0x63, 0xa2], opusHead({ channels: 2, sampleRate: 48000 })),
            element([0xe1], bytes(
              element([0xb5], float64(48000)),
              element([0x9f], [0x02])
            ))
          ))
        )),
        unknownElement([0x1f, 0x43, 0xb6, 0x75], bytes(
          element([0xe7], [0x00]),
          simpleBlock(0, opusPacket())
        )),
        unknownElement([0x1f, 0x43, 0xb6, 0x75], bytes(
          element([0xe7], uint(1000)),
          simpleBlock(0, opusPacket())
        ))
      ), { unknown: true })
    );

    const out = demuxWebmOpus(new Uint8Array(webm).buffer);

    expect(out.sampleRate).toBe(48000);
    expect(out.channels).toBe(2);
    expect(out.packets).toHaveLength(2);
    expect(out.packets.map((packet) => packet.timestampUs)).toEqual([0, 1_000_000]);
    expect(out.packets.map((packet) => packet.durationUs)).toEqual([60_000, 60_000]);
  });
});

function element(id, body, { unknown = false } = {}) {
  return bytes(id, unknown ? [0xff] : sizeVint(body.length), body);
}

function unknownElement(id, body) {
  return element(id, body, { unknown: true });
}

function simpleBlock(timecode, packet) {
  return element([0xa3], bytes(
    [0x81],
    [(timecode >> 8) & 0xff, timecode & 0xff],
    [0x80],
    packet
  ));
}

function opusPacket() {
  return [0xff, 0x03, 0xff, 0xfe, 0xff, 0xfe, 0xff, 0xfe];
}

function opusHead({ channels, sampleRate }) {
  return bytes(
    ascii("OpusHead"),
    [0x01, channels, 0x00, 0x00],
    uintLe(sampleRate, 4),
    [0x00, 0x00, 0x00]
  );
}

function sizeVint(size) {
  if (size < 0x7f) return [0x80 | size];
  if (size < 0x3fff) return [0x40 | (size >> 8), size & 0xff];
  throw new Error("fixture size too large");
}

function uint(value) {
  const out = [];
  let started = false;
  for (let shift = 24; shift >= 0; shift -= 8) {
    const byte = (value >> shift) & 0xff;
    if (byte || started || shift === 0) {
      out.push(byte);
      started = true;
    }
  }
  return out;
}

function uintLe(value, length) {
  return Array.from({ length }, (_, idx) => (value >> (idx * 8)) & 0xff);
}

function float64(value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return [...new Uint8Array(buffer)];
}

function ascii(value) {
  return [...value].map((char) => char.charCodeAt(0));
}

function bytes(...parts) {
  return parts.flatMap((part) => Array.from(part));
}
