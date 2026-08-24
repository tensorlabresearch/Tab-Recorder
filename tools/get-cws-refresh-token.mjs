#!/usr/bin/env node
// One-shot helper to obtain a Google OAuth refresh token with the
// chrome-webstore scope, for use in the BPP_KEYS GitHub secret.
//
// Usage:
//   node tools/get-cws-refresh-token.mjs [path-to-client-secret.json]
//
// Defaults to the client_secret_*.json in ~/Downloads. Starts a temporary
// HTTP listener on localhost:8085, opens the consent page in your browser,
// catches the redirect, exchanges the code, and prints the refresh token.
//
// The client_secret is read from the JSON file but is never written anywhere
// except printed as part of the final BPP_KEYS template (which YOU paste
// into GitHub Secrets). This script does not store anything.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URLSearchParams } from 'node:url';

const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';

const credPath = process.argv[2] || join(
  homedir(),
  'Downloads',
  'client_secret_613474506073-2gnedqpik4v0psv71lh3bdmpm3f3ne90.apps.googleusercontent.com.json',
);

const creds = JSON.parse(readFileSync(credPath, 'utf8')).installed;
if (!creds?.client_id || !creds?.client_secret) {
  console.error(`Could not read client_id/client_secret from ${credPath}`);
  process.exit(1);
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
authUrl.search = new URLSearchParams({
  response_type: 'code',
  scope: SCOPE,
  client_id: creds.client_id,
  redirect_uri: REDIRECT_URI,
  access_type: 'offline',
  prompt: 'consent', // ensures a refresh_token is returned every time
}).toString();

console.log(`Opening browser for OAuth consent (scope: ${SCOPE})...`);
console.log(`If it doesn't open, visit:\n${authUrl}\n`);

const server = createServer((req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    res.end(`Authorization failed: ${error}. You can close this tab.`);
    server.close();
    console.error(`Authorization failed: ${error}`);
    process.exit(1);
  }

  if (!code) {
    res.end('Waiting for the OAuth redirect... (missing code param)');
    return;
  }

  res.end('Success! You can close this tab and check your terminal.');
  server.close();
  exchangeCode(code).catch((err) => {
    console.error('Token exchange failed:', err.message);
    process.exit(1);
  });
});

server.listen(PORT, () => {
  // macOS: open the consent URL in the default browser
  exec(`open "${authUrl}"`);
});

async function exchangeCode(code) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data.refresh_token) {
    console.error('Token endpoint error:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log('\n=== refresh_token ===');
  console.log(data.refresh_token);
  console.log('\nNow fill in your extension ID (extId) and create the GitHub secret BPP_KEYS as:');
  console.log(JSON.stringify({
    chrome: {
      extId: '<your 32-char extension id>',
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      refreshToken: data.refresh_token,
    },
  }, null, 2));
  console.log('\nAdd it at: https://github.com/<your-repo>/settings/secrets/actions/new');
  console.log('NOTE: clientSecret + refreshToken are sensitive — do not commit them.');
}
