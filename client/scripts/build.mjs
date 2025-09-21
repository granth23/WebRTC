#!/usr/bin/env node
import { build } from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');

const envPrefix = 'VITE_';
const mode = process.env.MODE ?? 'production';
const baseUrl = process.env.BASE_URL ?? '/';

const env = {
  MODE: mode,
  DEV: false,
  PROD: true,
  SSR: false,
  BASE_URL: baseUrl,
};

for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith(envPrefix)) {
    env[key] = value ?? '';
  }
}

async function ensureCleanDist() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });
}

async function copyDir(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const src = path.join(source, entry.name);
    const dest = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyDir(src, dest);
    } else if (entry.isFile()) {
      await fs.copyFile(src, dest);
    }
  }
}

async function copyPublicDir() {
  const publicDir = path.join(projectRoot, 'public');
  try {
    await fs.access(publicDir);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  await copyDir(publicDir, distDir);
}

async function writeHtml() {
  const templatePath = path.join(projectRoot, 'index.html');
  let html = await fs.readFile(templatePath, 'utf8');

  html = html.replace('/src/main.jsx', './assets/main.js');
  html = html.replace('href="/vite.svg"', 'href="./vite.svg"');

  const cssPath = path.join(assetsDir, 'main.css');
  try {
    await fs.access(cssPath);
    const cssLinkTag = '    <link rel="stylesheet" href="./assets/main.css" />\n';
    html = html.replace('</head>', `${cssLinkTag}  </head>`);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  await fs.writeFile(path.join(distDir, 'index.html'), html, 'utf8');
}

async function run() {
  await ensureCleanDist();

  await build({
    entryPoints: [path.join(projectRoot, 'src', 'main.jsx')],
    outdir: assetsDir,
    bundle: true,
    format: 'esm',
    sourcemap: true,
    minify: true,
    splitting: false,
    target: ['es2019'],
    logLevel: 'info',
    jsx: 'automatic',
    jsxImportSource: 'react',
    loader: {
      '.js': 'jsx',
      '.jsx': 'jsx',
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.css': 'css',
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env': JSON.stringify(env),
    },
  });

  await copyPublicDir();
  await writeHtml();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
