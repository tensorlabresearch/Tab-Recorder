import { test, expect } from './extension.fixture.mjs';

test('Tab-Recorder installs and exposes its MV3 service worker', async ({ manifest, serviceWorker }) => {
  expect(manifest.manifest_version).toBe(3);
  const runtimeManifest = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  expect(runtimeManifest.name).toBeTruthy();
});

test('Tab-Recorder popup renders controls', async ({ page, extensionId, manifest }) => {
  const popupPath = manifest.action?.default_popup ?? 'popup.html';
  await page.goto(`chrome-extension://${extensionId}/${popupPath}`);
  await expect(page.locator('body')).toBeVisible();
  const buttonCount = await page.getByRole('button').count();
  expect(buttonCount).toBeGreaterThan(0);
});
