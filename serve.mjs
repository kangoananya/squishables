// Zero-dependency static server. Add COOP/COEP headers here later when moving
// to SharedArrayBuffer / multi-threaded WASM.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT) || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = decodeURIComponent(url.pathname);
  // the node editor used to live at graph.html; keep old links working
  if (path === '/graph.html') return res.writeHead(301, { Location: `/${url.search}` }).end();
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// if the port is taken (e.g. another copy is already running), try the next ones
let tries = 0;
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE' || ++tries > 10) throw err;
  console.log(`port ${port + tries - 1} is busy, trying ${port + tries}…`);
  server.listen(port + tries);
});
server.on('listening', () => console.log(`squishables → http://localhost:${server.address().port}`));
server.listen(port);
