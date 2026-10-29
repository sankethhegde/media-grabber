// Dev-server routes that build small DASH test streams from Apple's public
// fMP4 sample (480×270 video + AAC audio), one per addressing style:
//   /test/dash/list.mpd      SegmentList with byte ranges (+ a WebVTT track)
//   /test/dash/template.mpd  SegmentTemplate $Number$ (segments served locally)
//   /test/dash/base.mpd      SegmentBase: one file per track with a sidx index
//   /test/dash/drm.mpd, /test/dash/live.mpd
// Also /test/hls/noext/playlist: an HLS playlist with no extension, served as
// text/plain, for the playlist sniffer. Used by test/serve.js only.

const APPLE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples';
const FMP4 = `${APPLE}/img_bipbop_adv_example_fmp4`;
const TRACKS = {
  v: { playlist: `${FMP4}/v2/prog_index.m3u8`, mime: 'video/mp4', codecs: 'avc1.640015', bandwidth: 530000, width: 480, height: 270 },
  a: { playlist: `${FMP4}/a1/prog_index.m3u8`, mime: 'audio/mp4', codecs: 'mp4a.40.2', bandwidth: 160000 },
};
const SEGMENT_SECONDS = 6;

const cache = new Map(); // url|range → Buffer (small test streams only)
const layouts = new Map(); // track → { url, init: {offset,length}, segments: [{offset,length}] }

async function fetchBytes(url, offset, length) {
  const key = `${url}|${offset}|${length}`;
  if (!cache.has(key)) {
    const res = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    cache.set(key, Buffer.from(await res.arrayBuffer()));
  }
  return cache.get(key);
}

// Byte ranges of the first `n` segments, read from Apple's HLS playlist.
async function layout(track, n) {
  const key = `${track}|${n}`;
  if (layouts.has(key)) return layouts.get(key);
  const src = TRACKS[track].playlist;
  const text = await (await fetch(src)).text();
  let init = null;
  let url = null;
  const segments = [];
  let range = null;
  for (const line of text.split('\n').map((l) => l.trim())) {
    const map = /^#EXT-X-MAP:URI="([^"]+)",BYTERANGE="(\d+)@(\d+)"/.exec(line);
    if (map) {
      url = new URL(map[1], src).href;
      init = { length: Number(map[2]), offset: Number(map[3]) };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [len, off] = line.slice(17).split('@').map(Number);
      range = { length: len, offset: off };
    } else if (line && !line.startsWith('#') && range) {
      segments.push(range);
      range = null;
      if (segments.length >= n) break;
    }
  }
  const result = { url, init, segments };
  layouts.set(key, result);
  return result;
}

// SegmentBase file: init + sidx + the segments, built once and cached.
const files = new Map();
async function segmentBaseFile(track, n) {
  const key = `${track}|${n}`;
  if (files.has(key)) return files.get(key);
  const l = await layout(track, n);
  const init = await fetchBytes(l.url, l.init.offset, l.init.length);
  const segs = [];
  for (const s of l.segments) segs.push(await fetchBytes(l.url, s.offset, s.length));
  // sidx v0: timescale 1000, first_offset 0, one reference per segment.
  const body = Buffer.alloc(4 + 4 + 4 + 4 + 4 + 2 + 2 + segs.length * 12);
  let p = 0;
  body.writeUInt32BE(0, p); p += 4; // version 0, flags
  body.writeUInt32BE(1, p); p += 4; // reference_ID
  body.writeUInt32BE(1000, p); p += 4; // timescale
  body.writeUInt32BE(0, p); p += 4; // earliest_presentation_time
  body.writeUInt32BE(0, p); p += 4; // first_offset
  body.writeUInt16BE(0, p); p += 2; // reserved
  body.writeUInt16BE(segs.length, p); p += 2;
  for (const s of segs) {
    body.writeUInt32BE(s.length, p); // reference_type 0 + size
    body.writeUInt32BE(SEGMENT_SECONDS * 1000, p + 4);
    body.writeUInt32BE(0x90000000, p + 8); // starts with SAP
    p += 12;
  }
  const sidx = Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from('sidx'), body]);
  sidx.writeUInt32BE(sidx.length, 0);
  const file = { bytes: Buffer.concat([init, sidx, ...segs]), initLength: init.length, sidxLength: sidx.length };
  files.set(key, file);
  return file;
}

const mpdHeader = (n, type = 'static') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="${type}" ` +
  `${type === 'static' ? `mediaPresentationDuration="PT${n * SEGMENT_SECONDS}S" ` : 'availabilityStartTime="2026-01-01T00:00:00Z" '}` +
  'minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">\n';

function repAttrs(id) {
  const t = TRACKS[id];
  return `id="${id}" mimeType="${t.mime}" codecs="${t.codecs}" bandwidth="${t.bandwidth}"${t.width ? ` width="${t.width}" height="${t.height}"` : ''}`;
}

const SUBTITLE_SET = `
    <AdaptationSet contentType="text" mimeType="text/vtt" lang="en">
      <Label>English</Label>
      <Representation id="sub-en" bandwidth="500"><BaseURL>/test/dash/subs.vtt</BaseURL></Representation>
    </AdaptationSet>`;

async function listMpd(n) {
  const sets = [];
  for (const id of ['v', 'a']) {
    const l = await layout(id, n);
    const segs = l.segments.map((s) => `          <SegmentURL mediaRange="${s.offset}-${s.offset + s.length - 1}"/>`).join('\n');
    sets.push(`    <AdaptationSet contentType="${id === 'v' ? 'video' : 'audio'}"${id === 'a' ? ' lang="en"' : ''}>
      <Representation ${repAttrs(id)}>
        <BaseURL>${l.url}</BaseURL>
        <SegmentList timescale="1" duration="${SEGMENT_SECONDS}">
          <Initialization range="${l.init.offset}-${l.init.offset + l.init.length - 1}"/>
${segs}
        </SegmentList>
      </Representation>
    </AdaptationSet>`);
  }
  return `${mpdHeader(n)}  <Period>\n${sets.join('\n')}${SUBTITLE_SET}\n  </Period>\n</MPD>\n`;
}

function templateMpd(n) {
  return `${mpdHeader(n)}  <Period duration="PT${n * SEGMENT_SECONDS}S">
    <AdaptationSet contentType="video">
      <SegmentTemplate timescale="1" duration="${SEGMENT_SECONDS}" startNumber="1"
        initialization="/test/dash/seg/$RepresentationID$/init.mp4?n=${n}" media="/test/dash/seg/$RepresentationID$/$Number$.m4s?n=${n}"/>
      <Representation ${repAttrs('v')}/>
    </AdaptationSet>
    <AdaptationSet contentType="audio" lang="en">
      <SegmentTemplate timescale="1" duration="${SEGMENT_SECONDS}" startNumber="1"
        initialization="/test/dash/seg/$RepresentationID$/init.mp4?n=${n}" media="/test/dash/seg/$RepresentationID$/$Number$.m4s?n=${n}"/>
      <Representation ${repAttrs('a')}/>
    </AdaptationSet>
  </Period>
</MPD>
`;
}

async function baseMpd(n) {
  const sets = [];
  for (const id of ['v', 'a']) {
    const f = await segmentBaseFile(id, n);
    sets.push(`    <AdaptationSet contentType="${id === 'v' ? 'video' : 'audio'}">
      <Representation ${repAttrs(id)}>
        <BaseURL>/test/dash/file/${id}.mp4?n=${n}</BaseURL>
        <SegmentBase indexRange="${f.initLength}-${f.initLength + f.sidxLength - 1}">
          <Initialization range="0-${f.initLength - 1}"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>`);
  }
  return `${mpdHeader(n)}  <Period>\n${sets.join('\n')}\n  </Period>\n</MPD>\n`;
}

const SUBS_VTT = [
  'WEBVTT',
  '',
  '1',
  '00:00:00.500 --> 00:00:03.000',
  'Media Grabber test subtitle one',
  '',
  '2',
  '00:00:06.000 --> 00:00:09.000',
  'Second line, six seconds in',
  '',
  '3',
  '00:00:12.000 --> 00:00:15.000',
  'Third line',
  '',
].join('\n');

function send(res, status, type, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

/** Handle /test/dash/* and /test/hls/noext/* — returns true when handled. */
export async function handleDash(req, res, url) {
  const q = url.searchParams;
  const n = Math.max(1, Math.min(20, parseInt(q.get('n'), 10) || 3));
  const path = url.pathname;
  if (!path.startsWith('/test/dash/') && !path.startsWith('/test/hls/noext/')) return false;
  const MPD = 'application/dash+xml';
  try {
    if (path === '/test/dash/list.mpd') return send(res, 200, MPD, await listMpd(n)), true;
    if (path === '/test/dash/template.mpd') return send(res, 200, MPD, templateMpd(n)), true;
    if (path === '/test/dash/base.mpd') return send(res, 200, MPD, await baseMpd(n)), true;
    if (path === '/test/dash/subs.vtt') return send(res, 200, 'text/vtt', SUBS_VTT), true;
    if (path === '/test/dash/drm.mpd') {
      const body = templateMpd(n).replace('<AdaptationSet contentType="video">',
        '<AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" value="Widevine"/>')
        .replace('<AdaptationSet contentType="audio" lang="en">',
        '<AdaptationSet contentType="audio" lang="en"><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>');
      return send(res, 200, MPD, body), true;
    }
    if (path === '/test/dash/live.mpd') return send(res, 200, MPD, templateMpd(n).replace(mpdHeader(n), mpdHeader(n, 'dynamic'))), true;

    const seg = /^\/test\/dash\/seg\/([va])\/(init\.mp4|(\d+)\.m4s)$/.exec(path);
    if (seg) {
      const l = await layout(seg[1], n);
      const r = seg[3] ? l.segments[Number(seg[3]) - 1] : l.init;
      if (!r) return send(res, 404, 'text/plain', 'no such segment'), true;
      return send(res, 200, TRACKS[seg[1]].mime, await fetchBytes(l.url, r.offset, r.length)), true;
    }

    const file = /^\/test\/dash\/file\/([va])\.mp4$/.exec(path);
    if (file) {
      const f = (await segmentBaseFile(file[1], n)).bytes;
      const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      if (range) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), f.length - 1) : f.length - 1;
        return send(res, 206, TRACKS[file[1]].mime, f.subarray(start, end + 1), {
          'Content-Range': `bytes ${start}-${end}/${f.length}`,
          'Accept-Ranges': 'bytes',
        }), true;
      }
      return send(res, 200, TRACKS[file[1]].mime, f, { 'Accept-Ranges': 'bytes' }), true;
    }

    if (path === '/test/hls/noext/playlist') {
      // Same content as a trimmed Apple playlist, but no .m3u8 and text/plain.
      const src = `${APPLE}/bipbop_4x3/gear1/prog_index.m3u8`;
      const text = await (await fetch(src)).text();
      const lines = [];
      let count = 0;
      for (const line of text.split('\n')) {
        if (line && !line.startsWith('#')) {
          if (count++ >= n) break;
          lines.push(new URL(line.trim(), src).href);
        } else if (line !== '#EXT-X-ENDLIST') lines.push(line);
      }
      lines.push('#EXT-X-ENDLIST');
      return send(res, 200, 'text/plain; charset=utf-8', `${lines.join('\n')}\n`), true;
    }
    return send(res, 404, 'text/plain', 'Not found'), true;
  } catch (err) {
    return send(res, 502, 'text/plain', String(err.message)), true;
  }
}
