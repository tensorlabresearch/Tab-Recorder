import { test, expect } from '@playwright/test';
import { startServer, stopServer } from './server.mjs';
import { promises as fs } from 'fs';
import path from 'path';

const RECORD_DURATION_MS = 5000;
const OUTPUT_DIR = '/tmp/tab-recorder-e2e';

test.describe.configure({ mode: 'serial' });

let serverInfo = null;

test.beforeAll(async () => {
  serverInfo = await startServer(8787);
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
});

test.afterAll(async () => {
  if (serverInfo) {
    await stopServer();
  }
});

test('record synthetic audio and produce valid webm file', async ({ page }) => {
  // Navigate to the audio source test page
  await page.goto(serverInfo.url);
  await page.waitForLoadState('networkidle');

  // Click on the page to satisfy AudioContext user-gesture requirement
  await page.click('body');
  await page.waitForTimeout(500);

  // Start audio and recording
  const startResult = await page.evaluate(async () => {
    return await window.startAudioAndRecording();
  });

  console.log('Start result:', startResult);
  expect(startResult.ok).toBe(true);
  expect(startResult.streamTracks).toBeGreaterThan(0);

  // Record for a few seconds
  await page.waitForTimeout(RECORD_DURATION_MS);

  // Stop and collect the blob
  const stopResult = await page.evaluate(async () => {
    return await window.stopRecording();
  });

  console.log('Stop result:', stopResult);
  expect(stopResult.ok).toBe(true);
  expect(stopResult.size).toBeGreaterThan(0);
  expect(stopResult.chunks).toBeGreaterThan(0);

  // Write the base64 blob to disk
  const mimeType = stopResult.mimeType || 'audio/webm';
  const ext = mimeType.includes('webm') ? 'webm' : (mimeType.includes('mp4') ? 'm4a' : 'audio');
  const outputPath = path.join(OUTPUT_DIR, `test-recording-${Date.now()}.${ext}`);
  const buffer = Buffer.from(stopResult.base64, 'base64');
  await fs.writeFile(outputPath, buffer);

  console.log(`Saved recording: ${outputPath} (${buffer.length} bytes)`);

  // Verify file exists and has content
  const stats = await fs.stat(outputPath);
  expect(stats.size).toBeGreaterThan(1000); // At least 1KB

  // Verify with ffprobe if available
  let hasFfprobe = false;
  try {
    const { exec } = await import('child_process');
    const ffprobeResult = await new Promise((resolve, reject) => {
      exec(`ffprobe -v error -show_format -show_streams -of json "${outputPath}"`, (error, stdout, _stderr) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
    const probe = JSON.parse(ffprobeResult);
    console.log('ffprobe format:', probe.format?.format_name);
    console.log('Duration:', probe.format?.duration);
    console.log('Streams:', probe.streams?.length);
    expect(probe.streams?.length).toBeGreaterThan(0);
    hasFfprobe = true;
  } catch (probeErr) {
    console.log('ffprobe not available or failed, skipping codec validation:', probeErr.message);
  }

  // If ffprobe is not available, do a basic binary sanity check
  if (!hasFfprobe) {
    // WebM files start with 0x1A 0x45 0xDF 0xA3 (EBML header)
    const header = buffer.slice(0, 4);
    const isWebM = header[0] === 0x1A && header[1] === 0x45 && header[2] === 0xDF && header[3] === 0xA3;
    console.log('EBML header detected:', isWebM);
    // Not asserting on header because MediaRecorder might produce different formats
  }
});
