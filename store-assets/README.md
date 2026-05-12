# Store Assets for Tab Recorder

This directory contains marketing and promotional materials for the Chrome Web Store listing.

## Required Assets

### Screenshots (1–5 maximum)
Format: PNG or JPEG, **1280×800** or **640×400** pixels

| # | File | Description | Status |
|---|---|---|---|
| 1 | `screenshot-1-main.png` | Main panel UI showing recording controls | ❌ TODO |
| 2 | `screenshot-2-recording.png` | Recording in progress with level meters | ❌ TODO |
| 3 | `screenshot-3-recordings.png` | Recordings list with playback/transcription | ❌ TODO |
| 4 | `screenshot-4-transcript.png` | Transcription view with timestamps | ❌ TODO |
| 5 | `screenshot-5-settings.png` | Settings page with model selection | ❌ TODO |

### Promotional Images

**Small promotional tile**: 440×280 pixels, PNG or JPEG
- `promo-small.png` — Use for store search results and category pages

**Marquee promotional tile**: 1400×560 pixels, PNG or JPEG
- `promo-marquee.png` — Use for homepage/feature spots (optional but recommended)

**Large promotional tile**: 920×680 pixels, PNG or JPEG
- `promo-large.png` — Optional, used in some store layouts

### Store Icon
Already included in the extension package at `extension/icons/icon128.png`.

## Design Guidelines

- **Keep it clean**: No excessive text, let the UI speak for itself
- **Highlight the extension UI**: Show the actual panel/popup, not generic stock imagery
- **Use the browser frame**: Screenshots look more authentic with Chrome window chrome visible
- **Avoid sensitive data**: No real meeting names, PII, or confidential information
- **Consistent branding**: Use the same color palette (dark theme matches the panel)

## Generating Screenshots

Option A: Manual capture
1. Install the extension locally via `chrome://extensions/` → Load unpacked
2. Open the panel and navigate through key states
3. Use Chrome DevTools → Capture screenshot (Ctrl+Shift+P → "Capture full size screenshot")
4. Crop to **1280×800** exactly

Option B: Automated (if supported by your environment)
```bash
# Requires running Chrome with the extension loaded
# See scripts/capture-screenshots.sh (not yet implemented)
```

## Text Overlays (Optional)

If adding explanatory text to screenshots:
- Font: System UI font or Inter/SF Pro
- Size: 24–32px for headlines, 16–20px for body
- Contrast: White text on semi-transparent dark overlay
- Position: Bottom or corner, avoid covering UI elements
