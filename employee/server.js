import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4001;
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_FILE = path.join(DIST_DIR, 'index.html');

const server = http.createServer((req, res) => {
  if (!fs.existsSync(INDEX_FILE)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderMissingBuildPage());
    return;
  }

  const [rawPath] = req.url.split('?');
  const trimmed = rawPath.replace(/^\/+/, '');
  const requestPath = trimmed.length === 0 ? 'index.html' : decodeURIComponent(trimmed);
  const safePath = path.normalize(requestPath).replace(/^([.]{2}[\\/])+/g, '');
  const filePath = path.join(DIST_DIR, safePath);

  if (!filePath.startsWith(DIST_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(INDEX_FILE, (indexErr, indexData) => {
          if (indexErr) {
            res.writeHead(500);
            res.end('Failed to load application.');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(indexData);
        });
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': getContentType(ext) });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Employee interface available at http://localhost:${PORT}`);
});

function getContentType(ext) {
  switch (ext) {
    case '.html':
      return 'text/html';
    case '.css':
      return 'text/css';
    case '.js':
    case '.mjs':
      return 'application/javascript';
    case '.json':
      return 'application/json';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}

function renderMissingBuildPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Employee console – build required</title>
    <style>
      body { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; margin: 0; padding: 3rem; }
      main { max-width: 640px; margin: 0 auto; background: rgba(15, 23, 42, 0.85); padding: 2rem 2.5rem; border-radius: 16px; border: 1px solid rgba(148, 163, 184, 0.3); box-shadow: 0 24px 60px rgba(2, 6, 23, 0.5); }
      h1 { margin-top: 0; font-size: 1.8rem; }
      code { background: rgba(15, 23, 42, 0.95); padding: 0.2rem 0.45rem; border-radius: 6px; }
      ol { line-height: 1.6; }
    </style>
  </head>
  <body>
    <main>
      <h1>Employee application build not found</h1>
      <p>The compiled assets for the employee console are missing. Build them with:</p>
      <ol>
        <li><code>cd employee</code></li>
        <li><code>npm install</code></li>
        <li><code>npm run build</code></li>
        <li><code>npm start</code></li>
      </ol>
      <p>During development you can run <code>npm run dev</code> inside <code>employee/</code> to launch the Vite dev server.</p>
    </main>
  </body>
</html>`;
}
