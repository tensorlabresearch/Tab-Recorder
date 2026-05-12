/**
 * Lightweight HTTP server for E2E audio source page
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TEST_PORT || 8787;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // Resolve path relative to e2e/ dir (where audio_source.html lives)
  let filePath = path.join(__dirname, req.url === '/' ? 'audio_source.html' : req.url);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server Error');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
    });
    res.end(content, 'utf-8');
  });
});

export function startServer(port = PORT) {
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      console.log(`E2E test server running at http://localhost:${port}`);
      resolve({ server, url: `http://localhost:${port}` });
    });
    server.on('error', reject);
  });
}

export function stopServer() {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// If run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer();
}
