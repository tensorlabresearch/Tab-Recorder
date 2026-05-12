import { test as base, chromium, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultExtensionPath = process.env.EXTENSION_PATH
  ?? path.resolve(__dirname, '../projects/tab-recorder-v2');

export const test = base.extend({
  extensionPath: async ({}, use) => {
    const extensionPath = path.resolve(defaultExtensionPath);
    const manifestPath = path.join(extensionPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(
        `Could not find manifest.json at ${manifestPath}. ` +
        `Set EXTENSION_PATH to the extension directory containing manifest.json.`
      );
    }
    await use(extensionPath);
  },

  manifest: async ({ extensionPath }, use) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'));
    await use(manifest);
  },

  context: async ({ extensionPath }, use) => {
    const context = await chromium.launchPersistentContext('', {
      headless: process.env.PWHEADLESS !== 'false',
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
      ],
    });
    await use(context);
    await context.close();
  },

  serviceWorker: async ({ context }, use) => {
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent('serviceworker');
    }
    await use(serviceWorker);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const extensionId = serviceWorker.url().split('/')[2];
    if (!extensionId) {
      throw new Error(`Could not derive extension ID from service worker URL: ${serviceWorker.url()}`);
    }
    await use(extensionId);
  },
});

export { expect };
