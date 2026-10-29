// Minimal static file server for the test page (no dependencies).
//   node test/serve.js        → http://localhost:8080/test/
// Serves the whole extension folder so the test page sits at /test/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleHls } from './hls-routes.js';
import { handleDash } from './dash-routes.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
};

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (await handleDash(req, res, url)) return; // generated DASH test streams (checked first: /test/hls/noext)
  if (await handleHls(req, res, url)) return; // generated HLS test streams
  const path = decodeURIComponent(url.pathname);
  if (path === '/') {
    res.writeHead(302, { Location: '/test/' }).end();
    return;
  }
  const file = normalize(join(ROOT, path.endsWith('/') ? `${path}index.html` : path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(PORT, () => console.log(`Test page: http://localhost:${PORT}/test/`));
