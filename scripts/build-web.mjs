/**
 * Front-end build: esbuild, and nothing else.
 *
 * One dependency rather than a bundler stack, because this build has to be
 * runnable by whoever inherits it in three years without first learning a
 * toolchain. It produces a hashed bundle (cached forever) and an index.html
 * that references it (never cached), which is what makes a deploy take effect
 * without leaving anybody on yesterday's JavaScript.
 *
 *   node scripts/build-web.mjs            production build
 *   node scripts/build-web.mjs --watch    rebuild on change
 */
import { build, context } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'web/public/assets');
const watch = process.argv.includes('--watch');
const dev = watch || process.env.NODE_ENV !== 'production';

const shared = {
  entryPoints: [path.join(root, 'web/src/main.tsx')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  platform: 'browser',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
  loader: { '.svg': 'text' },
};

async function writeIndex(jsName, cssName) {
  // The base path is baked in at build time from the same variable the server
  // reads, so the client and the server cannot disagree about where they live.
  const base = (process.env.BASE_PATH ?? '/crm').replace(/\/$/, '');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>Lendmax CRM</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230F172A'/%3E%3Cpath d='M9 22V10h3v9h7v3H9z' fill='%23fff'/%3E%3C/svg%3E">
<script>
/* Theme before first paint. Without this the app flashes light and then goes
   dark, which on a dashboard somebody opens forty times a day is not a small
   annoyance. */
(function(){try{var t=localStorage.getItem('lmx-theme')||'system';
var d=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.dataset.theme=d?'dark':'light';
document.documentElement.dataset.themePref=t;}catch(e){}})();
</script>
<link rel="stylesheet" href="${base}/assets/${cssName}">
<script type="module" src="${base}/assets/${jsName}"></script>
</head>
<body><div id="root"></div></body>
</html>
`;
  await writeFile(path.join(root, 'web/public/index.html'), html);

  // The server's CSP allows inline scripts by hash, never by 'unsafe-inline'.
  // Computing the hashes here means editing the bootstrap above cannot leave a
  // policy that blocks it.
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hashes = scripts.map(
    (body) => `sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}`,
  );
  await writeFile(
    path.join(root, 'web/public/csp-hashes.json'),
    JSON.stringify({ scripts: hashes }, null, 2),
  );
}

async function hashAndRename(metafile) {
  const outputs = Object.keys(metafile.outputs);
  const names = {};
  for (const file of outputs) {
    const abs = path.join(root, file);
    const buf = await readFile(abs);
    const hash = createHash('sha256').update(buf).digest('hex').slice(0, 10);
    const ext = path.extname(file);
    const name = `app-${hash}${ext}`;
    await writeFile(path.join(outDir, name), buf);
    if (path.basename(abs) !== name) await rm(abs, { force: true });
    names[ext] = name;
  }
  return names;
}

async function once() {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await build({ ...shared, outdir: outDir, metafile: true, entryNames: 'app' });
  const names = await hashAndRename(result.metafile);
  await writeIndex(names['.js'] ?? 'app.js', names['.css'] ?? 'app.css');
  console.log(`built ${names['.js']} + ${names['.css']}`);
}

if (watch) {
  await mkdir(outDir, { recursive: true });
  // Stable names in watch mode: rewriting index.html on every keystroke fights
  // with the browser's reload.
  const ctx = await context({ ...shared, outdir: outDir, entryNames: 'app' });
  await ctx.watch();
  await writeIndex('app.js', 'app.css');
  console.log('watching web/src …');
} else {
  await once();
}
