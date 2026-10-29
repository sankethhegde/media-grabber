// Dev-server routes that build small HLS test streams from Apple's public
// sample streams: trimmed to a few segments so tests finish quickly, plus
// variants for AES-128, live, DRM, blocked (403) and flaky (retry) cases.
// Used by test/serve.js only; never part of the extension.
import { createCipheriv } from 'node:crypto';

const M3U8 = 'application/vnd.apple.mpegurl';
// Fixed test key (16 bytes). Only for the local AES-128 test stream.
const TEST_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const flakyCounts = new Map();

const abs = (uri, base) => new URL(uri, base).href;
const local = (path, params) => `${path}?${new URLSearchParams(params)}`;

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

// Keep the header and the first `n` segments of a media playlist; make every
// URI absolute (or rewrite it with `mapSegment`), and end the list unless live.
function trimMedia(text, src, n, { live = false, mapSegment = null, extraHeader = '' } = {}) {
  const lines = text.replace(/\r/g, '').split('\n');
  const out = [];
  const pending = [];
  let count = 0;
  let headerDone = false;
  let seq = 0;
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.slice(22), 10) || 0;
    if (line === '#EXT-X-ENDLIST' || (live && line.startsWith('#EXT-X-PLAYLIST-TYPE'))) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      out.push(line.replace(/URI="([^"]+)"/, (_, u) => `URI="${abs(u, src)}"`));
      continue;
    }
    if (line.startsWith('#EXTINF') || line.startsWith('#EXT-X-BYTERANGE') || line.startsWith('#EXT-X-BITRATE')) {
      if (!headerDone && extraHeader) out.push(extraHeader);
      headerDone = true;
      pending.push(line);
      continue;
    }
    if (line && !line.startsWith('#')) {
      if (count >= n) break;
      const url = abs(line, src);
      out.push(...pending, mapSegment ? mapSegment(url, seq + count) : url);
      pending.length = 0;
      count++;
      continue;
    }
    if (!headerDone) out.push(line);
  }
  if (!live) out.push('#EXT-X-ENDLIST');
  return `${out.join('\n')}\n`;
}

// Point a master's variants and renditions at trimmed copies.
function trimMaster(text, src, n) {
  return text
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => !line.startsWith('#EXT-X-I-FRAME-STREAM-INF'))
    .map((line) => {
      if (line.startsWith('#EXT-X-MEDIA:')) {
        return line.replace(/URI="([^"]+)"/, (_, u) => `URI="${local('/test/hls/trim.m3u8', { src: abs(u, src), n })}"`);
      }
      if (line && !line.startsWith('#')) return local('/test/hls/trim.m3u8', { src: abs(line, src), n });
      return line;
    })
    .join('\n');
}

function ivFor(sequence) {
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(sequence >>> 0, 12);
  return iv;
}

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

/** Handle /test/hls/* — returns true when the request was handled. */
export async function handleHls(req, res, url) {
  if (!url.pathname.startsWith('/test/hls/')) return false;
  const q = url.searchParams;
  const n = Math.max(1, Math.min(50, parseInt(q.get('n'), 10) || 4));
  try {
    switch (url.pathname) {
      case '/test/hls/trim.m3u8': {
        const src = q.get('src');
        const text = await fetchText(src);
        const body = text.includes('#EXT-X-STREAM-INF') ? trimMaster(text, src, n) : trimMedia(text, src, n);
        send(res, 200, M3U8, body);
        return true;
      }
      case '/test/hls/live.m3u8': {
        const src = q.get('src');
        send(res, 200, M3U8, trimMedia(await fetchText(src), src, 3, { live: true }));
        return true;
      }
      case '/test/hls/aes.m3u8': {
        const src = q.get('src');
        const body = trimMedia(await fetchText(src), src, n, {
          extraHeader: '#EXT-X-KEY:METHOD=AES-128,URI="/test/hls/key.bin"',
          mapSegment: (segUrl, seq) => local('/test/hls/enc.ts', { src: segUrl, seq }),
        });
        send(res, 200, M3U8, body);
        return true;
      }
      case '/test/hls/key.bin':
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': 16 });
        res.end(TEST_KEY);
        return true;
      case '/test/hls/enc.ts': {
        const plain = Buffer.from(await (await fetch(q.get('src'))).arrayBuffer());
        const cipher = createCipheriv('aes-128-cbc', TEST_KEY, ivFor(parseInt(q.get('seq'), 10) || 0));
        const body = Buffer.concat([cipher.update(plain), cipher.final()]);
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
        res.end(body);
        return true;
      }
      case '/test/hls/flaky.m3u8': {
        // Segment 1 fails twice, then works: exercises the retry backoff.
        const src = q.get('src');
        const run = Date.now();
        const body = trimMedia(await fetchText(src), src, n, {
          mapSegment: (segUrl, seq) => (seq % n === 1 ? local('/test/hls/flaky.ts', { src: segUrl, fail: 2, run }) : segUrl),
        });
        send(res, 200, M3U8, body);
        return true;
      }
      case '/test/hls/flaky.ts': {
        const key = `${q.get('run')}|${q.get('src')}`;
        const seen = flakyCounts.get(key) || 0;
        flakyCounts.set(key, seen + 1);
        if (seen < (parseInt(q.get('fail'), 10) || 0)) {
          send(res, 503, 'text/plain', 'try again');
          return true;
        }
        const body = Buffer.from(await (await fetch(q.get('src'))).arrayBuffer());
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
        res.end(body);
        return true;
      }
      case '/test/hls/synthetic.m3u8': {
        // Local stream of deterministic TS-shaped segments, each served after
        // `delay` ms: for timing tests (cancel, service-worker restart) that
        // must not depend on a remote CDN. Not playable video.
        const size = Math.max(188, Math.min(4_000_000, parseInt(q.get('size'), 10) || 188 * 2000));
        const delay = Math.max(0, Math.min(5000, parseInt(q.get('delay'), 10) || 0));
        const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:4', '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
        for (let i = 0; i < n; i++) lines.push('#EXTINF:4.0,', local('/test/hls/synthetic.ts', { i, size, delay }));
        lines.push('#EXT-X-ENDLIST');
        send(res, 200, M3U8, `${lines.join('\n')}\n`);
        return true;
      }
      case '/test/hls/synthetic.ts': {
        const i = parseInt(q.get('i'), 10) || 0;
        const size = Math.floor((parseInt(q.get('size'), 10) || 188 * 2000) / 188) * 188;
        const delay = Math.max(0, Math.min(5000, parseInt(q.get('delay'), 10) || 0));
        const body = Buffer.alloc(size);
        for (let p = 0; p < size; p += 188) {
          body[p] = 0x47; // TS sync byte
          body.writeUInt32BE(i, p + 4); // segment number, for checking order
          body.writeUInt32BE(p / 188, p + 8); // packet number within the segment
        }
        const startedAt = Date.now();
        await new Promise((r) => setTimeout(r, delay));
        if (res.destroyed) {
          console.log(`[synthetic] seg ${i} aborted by client after ${Date.now() - startedAt} ms @${Date.now()}`);
          return true;
        }
        console.log(`[synthetic] seg ${i} sent @${Date.now()}`);
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': body.length });
        res.end(body);
        return true;
      }
      case '/test/hls/forbidden.m3u8':
        send(res, 200, M3U8, '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n/test/hls/forbidden.ts\n#EXT-X-ENDLIST\n');
        return true;
      case '/test/hls/forbidden.ts':
        send(res, 403, 'text/plain', 'Forbidden');
        return true;
      case '/test/hls/drm.m3u8':
        send(
          res,
          200,
          M3U8,
          '#EXTM3U\n#EXT-X-TARGETDURATION:6\n' +
            '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://test-key",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n' +
            '#EXTINF:6.0,\nprotected0.ts\n#EXT-X-ENDLIST\n',
        );
        return true;
      default:
        send(res, 404, 'text/plain', 'Not found');
        return true;
    }
  } catch (err) {
    send(res, 502, 'text/plain', String(err.message));
    return true;
  }
}
