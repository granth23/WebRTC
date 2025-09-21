#!/usr/bin/env node
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const port = Number(process.env.PORT ?? 4173);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function readFileSafe(filePath) {
  try {
    const data = await fs.readFile(filePath);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function resolveFile(requestPath) {
  const cleanPath = decodeURIComponent(requestPath.split('?')[0]);
  const absolutePath = path.join(distDir, cleanPath);

  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      const indexPath = path.join(absolutePath, 'index.html');
      const indexContent = await readFileSafe(indexPath);
      if (indexContent) {
        return { filePath: indexPath, content: indexContent };
      }
    } else if (stats.isFile()) {
      const content = await readFileSafe(absolutePath);
      if (content) {
        return { filePath: absolutePath, content };
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const fallbackPath = path.join(distDir, 'index.html');
  const fallbackContent = await readFileSafe(fallbackPath);
  if (!fallbackContent) {
    return null;
  }
  return { filePath: fallbackPath, content: fallbackContent };
}

const server = http.createServer(async (req, res) => {
  const result = await resolveFile(req.url ?? '/');
  if (!result) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(result.filePath);
  const contentType = mimeTypes[ext] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  res.end(result.content);
});

server.listen(port, () => {
  console.log(`Preview server running at http://localhost:${port}`);
});
