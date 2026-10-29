// DASH (MPEG-DASH .mpd) parsing. Pure functions with no chrome.* or DOM
// calls: the service worker has no DOMParser, so this carries a small XML
// reader. Shared by the service worker (quality list) and the offscreen
// document (segment list), and unit-tested in plain Node.

// --------------------------------------------------------------- XML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

const localName = (name) => name.slice(name.indexOf(':') + 1);

/** Parse XML into { name, attrs, children, text } nodes (names without prefixes). */
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) {
      top.text += m[1];
    } else if (m[3]) {
      if (m[2] === '/') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      const attrs = {};
      const attrRe = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = attrRe.exec(m[4] || ''))) attrs[localName(a[1])] = decodeEntities(a[2] ?? a[3] ?? '');
      const node = { name: localName(m[3]), attrs, children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined) {
      top.text += decodeEntities(m[6]);
    }
  }
  return root;
}

const kids = (node, name) => (node?.children || []).filter((c) => c.name === name);
const kid = (node, name) => kids(node, name)[0] || null;

// ------------------------------------------------------------ helpers

/** ISO 8601 duration ("PT1H2M3.5S", "P1DT2H") → seconds. */
export function parseDuration(text) {
  if (!text) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((v) => parseFloat(v) || 0);
  return y * 31536000 + mo * 2592000 + d * 86400 + h * 3600 + mi * 60 + s;
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/** "100-499" → { offset: 100, length: 400 } */
export function parseRange(text) {
  const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(text || '');
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  return end >= start ? { offset: start, length: end - start + 1 } : null;
}

/** Fill $RepresentationID$, $Number%05d$, $Time$, $Bandwidth$, $$. */
export function fillTemplate(template, values) {
  return template.replace(/\$(RepresentationID|Number|Time|Bandwidth|SubNumber)?(%0(\d+)d)?\$/g, (m, key, _fmt, width) => {
    if (!key) return '$';
    const v = values[key];
    if (v === undefined || v === null) return m;
    const s = String(v);
    return width ? s.padStart(Number(width), '0') : s;
  });
}

function num(v, fallback = null) {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : fallback;
}

// Settings inherited down Period → AdaptationSet → Representation.
function mergeSegmentInfo(...nodes) {
  const out = {};
  for (const node of nodes) {
    if (!node) continue;
    for (const kind of ['SegmentTemplate', 'SegmentList', 'SegmentBase']) {
      const el = kid(node, kind);
      if (!el) continue;
      const prev = out[kind] || { attrs: {}, children: [] };
      out[kind] = {
        attrs: { ...prev.attrs, ...el.attrs },
        children: el.children.length ? el.children : prev.children,
      };
    }
  }
  return out;
}

function baseUrlOf(node, parentBase) {
  const b = kid(node, 'BaseURL');
  return b && b.text.trim() ? resolve(b.text.trim(), parentBase) : parentBase;
}

// ------------------------------------------------------------- the MPD

/**
 * Parse an MPD into:
 * { type: 'static'|'dynamic', duration, periods: [{ index, duration, sets: [{
 *     contentType, mimeType, lang, label, protected, reps: [{ id, bandwidth,
 *     width, height, codecs, mimeType, frameRate, baseUrl, seg }] }] }] }
 * `seg` is the merged SegmentTemplate/List/Base info for segmentsFor().
 */
export function parseMpd(text, url) {
  const doc = parseXml(text);
  const mpd = kid(doc, 'MPD');
  if (!mpd) throw new Error('Not a DASH manifest');
  const type = (mpd.attrs.type || 'static').toLowerCase();
  const duration = parseDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = baseUrlOf(mpd, url);

  const periodNodes = kids(mpd, 'Period');
  const periods = periodNodes.map((period, index) => {
    const start = parseDuration(period.attrs.start) ?? 0;
    const nextStart = periodNodes[index + 1] ? parseDuration(periodNodes[index + 1].attrs.start) : null;
    const periodDuration =
      parseDuration(period.attrs.duration) ??
      (nextStart != null ? nextStart - start : duration != null ? duration - start : null);
    const periodBase = baseUrlOf(period, mpdBase);

    const sets = kids(period, 'AdaptationSet').map((set) => {
      const setBase = baseUrlOf(set, periodBase);
      const firstRep = kid(set, 'Representation');
      const mimeType = set.attrs.mimeType || firstRep?.attrs.mimeType || '';
      const codecs = set.attrs.codecs || firstRep?.attrs.codecs || '';
      let contentType = (set.attrs.contentType || mimeType.split('/')[0] || '').toLowerCase();
      if (contentType === 'application' && /stpp|wvtt|ttml|vtt/i.test(`${mimeType} ${codecs}`)) contentType = 'text';
      const roles = kids(set, 'Role').map((r) => r.attrs.value);
      const label = kid(set, 'Label')?.text.trim() || set.attrs.label || '';
      const setProtected = kids(set, 'ContentProtection').length > 0;

      const reps = kids(set, 'Representation').map((rep) => {
        const repProtected = setProtected || kids(rep, 'ContentProtection').length > 0;
        return {
          id: rep.attrs.id || '',
          bandwidth: num(rep.attrs.bandwidth, 0),
          width: num(rep.attrs.width ?? set.attrs.width),
          height: num(rep.attrs.height ?? set.attrs.height),
          codecs: rep.attrs.codecs || codecs,
          mimeType: rep.attrs.mimeType || mimeType,
          frameRate: frameRateOf(rep.attrs.frameRate || set.attrs.frameRate),
          baseUrl: baseUrlOf(rep, setBase),
          protected: repProtected,
          seg: mergeSegmentInfo(period, set, rep),
        };
      });
      return { contentType, mimeType, lang: set.attrs.lang || '', label, roles, protected: setProtected, reps };
    });
    return { index, start, duration: periodDuration, sets };
  });

  return { type, live: type === 'dynamic', duration: duration ?? periods.reduce((n, p) => n + (p.duration || 0), 0), periods };
}

function frameRateOf(v) {
  if (!v) return null;
  const [a, b] = String(v).split('/').map(Number);
  return b ? a / b : a || null;
}

// --------------------------------------------------- segment addressing

/**
 * Segment list for one representation, in the same shape as HLS media
 * segments: { container, init: {url, byteRange}|null, segments: [{ url,
 * byteRange, duration, sequence }], index: {url, range, initRange}|null }.
 * `index` means SegmentBase: the segments come from the file's sidx box,
 * which the downloader fetches and reads (see mp4.js parseSidx).
 */
export function segmentsFor(rep, period) {
  const container = containerOf(rep);
  const values = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const periodDuration = period.duration;

  const tpl = rep.seg.SegmentTemplate;
  if (tpl) {
    const a = tpl.attrs;
    const timescale = num(a.timescale, 1);
    const startNumber = num(a.startNumber, 1);
    const init = a.initialization ? { url: resolve(fillTemplate(a.initialization, values), rep.baseUrl), byteRange: null } : null;
    const segments = [];
    const timeline = tpl.children.find((c) => c.name === 'SegmentTimeline');
    if (timeline) {
      let t = 0;
      let number = startNumber;
      const entries = kids(timeline, 'S');
      entries.forEach((s, i) => {
        if (s.attrs.t !== undefined) t = num(s.attrs.t, t);
        const d = num(s.attrs.d, 0);
        let r = num(s.attrs.r, 0);
        if (r < 0) {
          // Repeat until the next S@t, or the end of the period.
          const nextT = entries[i + 1]?.attrs.t !== undefined ? num(entries[i + 1].attrs.t) : null;
          const end = nextT ?? (periodDuration != null ? periodDuration * timescale + num(a.presentationTimeOffset, 0) : t + d);
          r = Math.max(0, Math.ceil((end - t) / d) - 1);
        }
        for (let k = 0; k <= r; k++) {
          segments.push({
            url: resolve(fillTemplate(a.media, { ...values, Number: number, Time: t }), rep.baseUrl),
            byteRange: null,
            duration: d / timescale,
            sequence: number,
          });
          t += d;
          number++;
        }
      });
    } else if (a.duration) {
      const d = num(a.duration, 0) / timescale;
      const count = periodDuration != null && d > 0 ? Math.ceil(periodDuration / d - 1e-6) : 0;
      for (let k = 0; k < count; k++) {
        const isLast = k === count - 1;
        segments.push({
          url: resolve(fillTemplate(a.media, { ...values, Number: startNumber + k, Time: Math.round(k * d * timescale) }), rep.baseUrl),
          byteRange: null,
          duration: isLast && periodDuration != null ? periodDuration - k * d : d,
          sequence: startNumber + k,
        });
      }
    }
    return { container, init, segments, index: null };
  }

  const list = rep.seg.SegmentList;
  if (list) {
    const a = list.attrs;
    const timescale = num(a.timescale, 1);
    const d = num(a.duration, 0) / timescale;
    const initNode = list.children.find((c) => c.name === 'Initialization');
    const init = initNode
      ? { url: resolve(initNode.attrs.sourceURL || rep.baseUrl, rep.baseUrl), byteRange: parseRange(initNode.attrs.range) }
      : null;
    const segments = kids({ children: list.children }, 'SegmentURL').map((s, k) => ({
      url: resolve(s.attrs.media || rep.baseUrl, rep.baseUrl),
      byteRange: parseRange(s.attrs.mediaRange),
      duration: d,
      sequence: num(a.startNumber, 1) + k,
    }));
    return { container, init, segments, index: null };
  }

  const base = rep.seg.SegmentBase;
  if (base?.attrs.indexRange) {
    const initNode = base.children.find((c) => c.name === 'Initialization');
    return {
      container,
      init: null,
      segments: [],
      index: { url: rep.baseUrl, range: parseRange(base.attrs.indexRange), initRange: parseRange(initNode?.attrs.range) },
    };
  }

  // A single self-contained file (BaseURL only).
  return { container, init: null, segments: [{ url: rep.baseUrl, byteRange: null, duration: periodDuration || 0, sequence: 1, wholeFile: true }], index: null };
}

function containerOf(rep) {
  const mime = `${rep.mimeType} ${rep.codecs}`.toLowerCase();
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('text/vtt') || /\bwvtt\b/.test(mime) && !mime.includes('mp4')) return 'vtt';
  if (/stpp|ttml/.test(mime)) return 'ttml';
  return 'fmp4';
}

// ------------------------------------------------------- quality list

const isVideo = (s) => s.contentType === 'video';
const isAudio = (s) => s.contentType === 'audio';
const isText = (s) => s.contentType === 'text';

function audioScore(set, rep) {
  let score = 0;
  if (set.roles.includes('main')) score += 4;
  if (/mp4a/i.test(rep.codecs)) score += 2; // AAC plays everywhere
  if (!/webm/i.test(rep.mimeType)) score += 1;
  return score * 1e9 + rep.bandwidth;
}

function rateText(bw) {
  if (!bw) return '';
  return bw >= 1e6 ? `${(bw / 1e6).toFixed(1)} Mbps` : `${Math.round(bw / 1e3)} kbps`;
}

/**
 * Quality list (best first) from a parsed MPD's first period: every video
 * representation paired with the best audio. Each entry carries the ids the
 * downloader needs. `drm` is true when the chosen sets are encrypted.
 */
export function qualitiesFromMpd(mpd) {
  const period = mpd.periods[0];
  if (!period) return { qualities: [], drm: false, subtitles: [] };
  const videoSets = period.sets.filter(isVideo);
  const audioSets = period.sets.filter(isAudio);

  let bestAudio = null;
  for (const set of audioSets) {
    for (const rep of set.reps) {
      if (!bestAudio || audioScore(set, rep) > audioScore(bestAudio.set, bestAudio.rep)) bestAudio = { set, rep };
    }
  }

  const subtitles = period.sets
    .filter(isText)
    .flatMap((set) => set.reps.map((rep) => ({ id: rep.id, language: set.lang || '', name: set.label || set.lang || '', container: containerOf(rep) })))
    .filter((s) => s.container === 'vtt');

  const qualities = [];
  for (const set of videoSets) {
    for (const rep of set.reps) {
      const webm = /webm/i.test(rep.mimeType);
      const parts = [];
      if (rep.height) parts.push(`${rep.height}p${rep.frameRate && rep.frameRate > 31 ? Math.round(rep.frameRate) : ''}`);
      const rate = rateText(rep.bandwidth + (bestAudio?.rep.bandwidth || 0));
      if (rate) parts.push(rate);
      if (/^(hvc1|hev1)/i.test(rep.codecs)) parts.push('HEVC');
      else if (/^av01/i.test(rep.codecs)) parts.push('AV1');
      else if (/^vp0?9/i.test(rep.codecs)) parts.push('VP9');
      if (webm) parts.push('WebM');
      qualities.push({
        label: parts.join(' · ') || rep.id || 'Default',
        width: rep.width,
        height: rep.height,
        bandwidth: rep.bandwidth + (bestAudio?.rep.bandwidth || 0),
        videoId: rep.id,
        audioId: bestAudio?.rep.id || null,
        protected: rep.protected || Boolean(bestAudio?.rep.protected),
        webm,
      });
    }
  }
  // Audio-only manifests.
  if (!qualities.length && bestAudio) {
    for (const set of audioSets) {
      for (const rep of set.reps) {
        qualities.push({
          label: ['Audio only', rateText(rep.bandwidth), set.lang].filter(Boolean).join(' · '),
          width: null,
          height: null,
          bandwidth: rep.bandwidth,
          videoId: null,
          audioId: rep.id,
          protected: rep.protected,
          webm: /webm/i.test(rep.mimeType),
        });
      }
    }
  }
  // Taller first; MP4 before WebM (MP4 can be merged into one file); then bitrate.
  qualities.sort((a, b) => (b.height || 0) - (a.height || 0) || Number(a.webm) - Number(b.webm) || b.bandwidth - a.bandwidth);
  const drm = qualities.length > 0 && qualities.every((q) => q.protected);
  return { qualities: qualities.filter((q) => !q.protected || drm), drm, subtitles };
}

/** Find a representation (and its period) by id in the first period. */
export function findRep(mpd, id) {
  const period = mpd.periods[0];
  for (const set of period?.sets || []) {
    const rep = set.reps.find((r) => r.id === id);
    if (rep) return { period, set, rep };
  }
  return null;
}
