// HLS playlist parsing (spec HLS-1 to HLS-4, HLS-7). Pure functions with no
// chrome.* calls, shared by the service worker (listing qualities) and the
// offscreen document (downloading), and unit-tested in plain Node.

export const HLS_MIME = /mpegurl/i;

// Key systems that mean DRM, never plain AES-128.
const DRM_KEYFORMATS = [
  /com\.apple\.streamingkeydelivery/i, // FairPlay
  /edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i, // Widevine
  /9a04f079-9840-4286-ab92-e65be0885f95/i, // PlayReady
  /com\.microsoft\.playready/i,
  /com\.widevine/i,
];

/** Parse an attribute list: KEY=VALUE,KEY="quoted, value",... */
export function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) {
    let value = m[2];
    if (value.startsWith('"')) value = value.slice(1, -1);
    attrs[m[1]] = value;
  }
  return attrs;
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/** "1024@2048" → { length: 1024, offset: 2048 }; offset defaults to `nextOffset`. */
function parseByteRange(text, nextOffset) {
  const [len, off] = String(text).split('@');
  const length = parseInt(len, 10);
  const offset = off !== undefined ? parseInt(off, 10) : nextOffset;
  return Number.isFinite(length) && Number.isFinite(offset) ? { length, offset } : null;
}

/** True when a key tag means DRM rather than standard AES-128 (HLS-4). */
export function isDrmKey(key) {
  if (!key || key.method === 'NONE') return false;
  if (key.method !== 'AES-128') return true; // SAMPLE-AES, SAMPLE-AES-CTR, ...
  const format = key.keyformat || 'identity';
  return format !== 'identity' || DRM_KEYFORMATS.some((re) => re.test(format));
}

function parseKey(attrs, base) {
  return {
    method: (attrs.METHOD || 'NONE').toUpperCase(),
    uri: attrs.URI ? resolve(attrs.URI, base) : null,
    iv: attrs.IV || null,
    keyformat: attrs.KEYFORMAT || 'identity',
  };
}

/**
 * Parse a master or media playlist.
 * Master → { kind: 'master', variants, audio, drm }
 * Media  → { kind: 'media', segments, endList, totalDuration, encryption, ... }
 */
export function parsePlaylist(text, baseUrl) {
  const lines = String(text).replace(/\r/g, '').split('\n').map((l) => l.trim());
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('Not an HLS playlist');

  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  return isMaster ? parseMaster(lines, baseUrl) : parseMedia(lines, baseUrl);
}

function parseMaster(lines, base) {
  const variants = [];
  const audio = [];
  const renditionUrls = []; // every audio/subtitle/i-frame playlist the master points to
  const subtitles = [];
  let drm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributes(line.slice(18));
      // The URI is the next non-comment line.
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j >= lines.length) continue;
      const [w, h] = (a.RESOLUTION || '').split('x').map((n) => parseInt(n, 10));
      variants.push({
        url: resolve(lines[j], base),
        bandwidth: parseInt(a.BANDWIDTH, 10) || null,
        averageBandwidth: parseInt(a['AVERAGE-BANDWIDTH'], 10) || null,
        width: w || null,
        height: h || null,
        codecs: a.CODECS || '',
        frameRate: parseFloat(a['FRAME-RATE']) || null,
        audioGroup: a.AUDIO || null,
        subtitleGroup: a.SUBTITLES || null,
      });
      i = j;
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      const a = parseAttributes(line.slice(26));
      if (a.URI) renditionUrls.push(resolve(a.URI, base));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributes(line.slice(13));
      if (a.URI) renditionUrls.push(resolve(a.URI, base));
      const mediaType = (a.TYPE || '').toUpperCase();
      if (mediaType === 'SUBTITLES' && a.URI) {
        subtitles.push({
          groupId: a['GROUP-ID'] || '',
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          forced: a.FORCED === 'YES',
          url: resolve(a.URI, base),
        });
        continue;
      }
      if (mediaType !== 'AUDIO') continue;
      audio.push({
        groupId: a['GROUP-ID'] || '',
        name: a.NAME || '',
        language: a.LANGUAGE || '',
        default: a.DEFAULT === 'YES',
        autoselect: a.AUTOSELECT === 'YES',
        channels: a.CHANNELS || '',
        // No URI = the audio is muxed into the variant's own segments.
        url: a.URI ? resolve(a.URI, base) : null,
      });
    } else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
      if (isDrmKey(parseKey(parseAttributes(line.slice(19)), base))) drm = true;
    }
  }
  return { kind: 'master', variants, audio, subtitles, drm, renditionUrls };
}

function parseMedia(lines, base) {
  const segments = [];
  let targetDuration = null;
  let mediaSequence = 0;
  let endList = false;
  let playlistType = null;
  let key = null;
  let map = null;
  let duration = null;
  let byteRange = null;
  let discontinuity = false;
  let drm = false;
  let aes = false;
  // Offset where the next range of each resource starts (BYTERANGE without @).
  const nextOffset = new Map();

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('#EXTINF:')) {
      duration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseFloat(line.slice(22)) || null;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice(22), 10) || 0;
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice(21).trim().toUpperCase();
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      byteRange = line.slice(17);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      key = parseKey(parseAttributes(line.slice(11)), base);
      if (key.method === 'NONE') key = null;
      else if (isDrmKey(key)) drm = true;
      else aes = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(11));
      const url = resolve(a.URI, base);
      map = { url, byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (!line.startsWith('#')) {
      const url = resolve(line, base);
      let range = null;
      if (byteRange) {
        range = parseByteRange(byteRange, nextOffset.get(url) || 0);
        if (range) nextOffset.set(url, range.offset + range.length);
      }
      segments.push({
        url,
        duration: duration ?? 0,
        byteRange: range,
        key,
        map,
        discontinuity,
        sequence: mediaSequence + segments.length,
      });
      duration = null;
      byteRange = null;
      discontinuity = false;
    }
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  return {
    kind: 'media',
    targetDuration,
    mediaSequence,
    playlistType,
    endList: endList || playlistType === 'VOD',
    segments,
    totalDuration,
    encryption: drm ? 'drm' : aes ? 'aes-128' : 'none',
    container: segments[0]?.map ? 'fmp4' : guessContainer(segments[0]?.url),
  };
}

export function guessContainer(url) {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return String(url || '').toLowerCase();
    }
  })();
  if (/\.(vtt|webvtt)$/.test(path)) return 'vtt';
  if (/\.(aac|adts)$/.test(path)) return 'aac';
  if (/\.(ac3|ec3|eac3)$/.test(path)) return 'ac3';
  if (/\.(mp4|m4s|m4v|m4a|cmfv|cmfa)$/.test(path)) return 'fmp4';
  return 'ts';
}

// ------------------------------------------------------- quality labels

const CODEC_NAMES = [
  [/^(hvc1|hev1)/i, 'HEVC'],
  [/^(dvh1|dvhe)/i, 'Dolby Vision'],
  [/^av01/i, 'AV1'],
  [/^vp0?9/i, 'VP9'],
];
const AUDIO_CODEC_NAMES = [
  [/^mp4a/i, 'AAC'],
  [/^ac-3/i, 'AC-3'],
  [/^ec-3/i, 'E-AC-3'],
  [/^(opus|Opus)/, 'Opus'],
];

function codecHints(codecs) {
  const list = String(codecs || '').split(',').map((c) => c.trim()).filter(Boolean);
  const video = list.map((c) => CODEC_NAMES.find(([re]) => re.test(c))?.[1]).find(Boolean) || null;
  const audio = list.map((c) => AUDIO_CODEC_NAMES.find(([re]) => re.test(c))?.[1]).find(Boolean) || null;
  const hasVideo = list.some((c) => /^(avc|hvc|hev|dvh|av01|vp0?9)/i.test(c));
  return { video, audio, audioOnly: list.length > 0 && !hasVideo };
}

/** "720p · 2.8 Mbps" (HLS-2), with codec hints when variants would collide. */
export function variantLabel(v, { showAudioCodec = false } = {}) {
  const hints = codecHints(v.codecs);
  const bw = v.averageBandwidth || v.bandwidth;
  const rate = bw ? (bw >= 1e6 ? `${(bw / 1e6).toFixed(1)} Mbps` : `${Math.round(bw / 1e3)} kbps`) : '';
  const parts = [];
  if (hints.audioOnly) parts.push('Audio only');
  else if (v.height) parts.push(`${v.height}p${v.frameRate && v.frameRate > 31 ? Math.round(v.frameRate) : ''}`);
  if (rate) parts.push(rate);
  if (hints.video) parts.push(hints.video);
  if (showAudioCodec && hints.audio) parts.push(hints.audio);
  return parts.join(' · ') || 'Default';
}

/**
 * Turn a parsed master playlist into a quality list, best first. Each entry
 * carries the media playlist URL plus the matching audio rendition, if the
 * audio is separate (HLS-5).
 */
export function qualitiesFromMaster(master) {
  const groups = new Set(master.variants.map((v) => v.audioGroup).filter(Boolean));
  const showAudioCodec = groups.size > 1;
  const pickAudio = (groupId) => {
    if (!groupId) return null;
    const options = master.audio.filter((a) => a.groupId === groupId);
    const chosen = options.find((a) => a.default) || options.find((a) => a.autoselect) || options[0];
    return chosen?.url ? chosen : null; // URI-less rendition = muxed in
  };
  // Subtitles: the variant's group, or every subtitle playlist if it names none.
  const subtitlesFor = (groupId) =>
    (master.subtitles || [])
      .filter((s) => !groupId || s.groupId === groupId)
      .filter((s, i, all) => all.findIndex((x) => x.url === s.url) === i)
      .map((s) => ({ url: s.url, language: s.language, name: s.name }));
  const out = master.variants.map((v) => {
    const audio = pickAudio(v.audioGroup);
    return {
      label: variantLabel(v, { showAudioCodec }),
      url: v.url,
      audioUrl: audio?.url || null,
      audioName: audio?.name || null,
      subtitles: subtitlesFor(v.subtitleGroup),
      width: v.width,
      height: v.height,
      bandwidth: v.averageBandwidth || v.bandwidth,
      codecs: v.codecs,
    };
  });
  // Drop exact duplicates, then sort: taller first; at the same height, AAC
  // before other audio (it plays everywhere and can be remuxed); then bitrate.
  const audioRank = (q) => {
    const audio = codecHints(q.codecs).audio;
    return !audio || audio === 'AAC' ? 0 : 1;
  };
  const seen = new Set();
  return out
    .filter((q) => {
      const key = `${q.url}|${q.audioUrl}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (a, b) =>
        (b.height || 0) - (a.height || 0) || audioRank(a) - audioRank(b) || (b.bandwidth || 0) - (a.bandwidth || 0),
    );
}

/** 16-byte IV: explicit 0x... value, or the media sequence number (big-endian). */
export function ivFor(segment) {
  const iv = new Uint8Array(16);
  if (segment.key?.iv) {
    const hex = segment.key.iv.replace(/^0x/i, '').padStart(32, '0').slice(-32);
    for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  } else {
    let n = BigInt(segment.sequence);
    for (let i = 15; i >= 0 && n > 0n; i--) {
      iv[i] = Number(n & 0xffn);
      n >>= 8n;
    }
  }
  return iv;
}
