// Minimal fragmented-MP4 box handling for HLS-5: combine a video-only and an
// audio-only fragmented MP4 (from fMP4 HLS, or from mux.js output) into one
// file with two tracks. Pure functions over Uint8Array; unit-tested in Node.
//
// A fragmented MP4 is: ftyp, moov (one trak per track, mvex/trex), then
// repeated moof (traf → tfhd track_ID, tfdt decode time) + mdat. Sample data
// offsets in trun are relative to the moof, so moof+mdat pairs can be moved
// around whole; only track IDs need rewriting.

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'moof', 'traf', 'edts', 'dinf']);

const u32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
function setU32(b, p, v) {
  b[p] = (v >>> 24) & 255;
  b[p + 1] = (v >>> 16) & 255;
  b[p + 2] = (v >>> 8) & 255;
  b[p + 3] = v & 255;
}
const fourcc = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

/** Top-level (or child) boxes in b[start, end): [{ type, start, end, header }]. */
export function readBoxes(b, start = 0, end = b.length) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    let header = 8;
    if (size === 1) {
      size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p, end: p + size, header });
    p += size;
  }
  return out;
}

function children(b, box) {
  return readBoxes(b, box.start + box.header, box.end);
}

function child(b, box, type) {
  return children(b, box).find((c) => c.type === type) || null;
}

function makeBox(type, parts) {
  const size = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  setU32(out, 0, size);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  let p = 8;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const slice = (b, box) => b.slice(box.start, box.end);

// Field offsets inside full boxes (version byte right after the 8-byte header).
function tkhdIdOffset(b, box) {
  return box.start + box.header + (b[box.start + box.header] === 1 ? 20 : 12);
}
function mdhdTimescaleOffset(b, box) {
  return box.start + box.header + (b[box.start + box.header] === 1 ? 20 : 12);
}

/** Track list of an init segment: [{ id, handler, timescale }]. */
export function describeInit(init) {
  const moov = readBoxes(init).find((x) => x.type === 'moov');
  if (!moov) throw new Error('No moov box in init segment');
  return children(init, moov)
    .filter((c) => c.type === 'trak')
    .map((trak) => {
      const tkhd = child(init, trak, 'tkhd');
      const mdia = child(init, trak, 'mdia');
      const mdhd = mdia && child(init, mdia, 'mdhd');
      const hdlr = mdia && child(init, mdia, 'hdlr');
      return {
        id: u32(init, tkhdIdOffset(init, tkhd)),
        handler: hdlr ? fourcc(init, hdlr.start + hdlr.header + 8) : '',
        timescale: mdhd ? u32(init, mdhdTimescaleOffset(init, mdhd)) : 90000,
      };
    });
}

/**
 * Merge init segments. `sources` = [{ init, handlers? }] — handlers limits
 * which tracks are taken (e.g. ['soun'] from the audio file). Returns the new
 * init and, per source, a Map(oldTrackId → newTrackId).
 */
export function mergeInits(sources) {
  const first = sources[0].init;
  const top = readBoxes(first);
  const ftyp = top.find((x) => x.type === 'ftyp');
  const moov0 = top.find((x) => x.type === 'moov');
  const moov0Kids = children(first, moov0);
  const mvhd = slice(first, moov0Kids.find((c) => c.type === 'mvhd'));
  const mvex0 = moov0Kids.find((c) => c.type === 'mvex');
  const mehd = mvex0 && child(first, mvex0, 'mehd');

  const traks = [];
  const trexes = [];
  const maps = [];
  let nextId = 1;
  for (const { init, handlers } of sources) {
    const moov = readBoxes(init).find((x) => x.type === 'moov');
    const kids = children(init, moov);
    const mvex = kids.find((c) => c.type === 'mvex');
    const trexById = new Map(
      (mvex ? children(init, mvex).filter((c) => c.type === 'trex') : []).map((t) => [u32(init, t.start + t.header + 4), t]),
    );
    const map = new Map();
    for (const trak of kids.filter((c) => c.type === 'trak')) {
      const tkhd = child(init, trak, 'tkhd');
      const oldId = u32(init, tkhdIdOffset(init, tkhd));
      const mdia = child(init, trak, 'mdia');
      const hdlr = mdia && child(init, mdia, 'hdlr');
      const handler = hdlr ? fourcc(init, hdlr.start + hdlr.header + 8) : '';
      if (handlers && !handlers.includes(handler)) continue;
      const newId = nextId++;
      map.set(oldId, newId);
      const trakCopy = slice(init, trak);
      setU32(trakCopy, tkhdIdOffset(init, tkhd) - trak.start, newId);
      traks.push(trakCopy);
      const trex = trexById.get(oldId);
      const trexCopy = trex ? slice(init, trex) : defaultTrex();
      setU32(trexCopy, 12, newId);
      trexes.push(trexCopy);
    }
    maps.push(map);
  }

  const mvhdCopy = mvhd.slice();
  setU32(mvhdCopy, mvhdCopy.length - 4, nextId); // next_track_ID
  const others = moov0Kids
    .filter((c) => !['mvhd', 'trak', 'mvex'].includes(c.type))
    .map((c) => slice(first, c));
  const mvexBox = makeBox('mvex', [...(mehd ? [slice(first, mehd)] : []), ...trexes]);
  const moov = makeBox('moov', [mvhdCopy, ...traks, mvexBox, ...others]);
  const ftypBytes = ftyp ? slice(first, ftyp) : new Uint8Array(0);
  const out = new Uint8Array(ftypBytes.length + moov.length);
  out.set(ftypBytes, 0);
  out.set(moov, ftypBytes.length);
  return { init: out, maps };
}

function defaultTrex() {
  // version/flags, track_ID, sample_description_index=1, duration, size, flags
  const body = new Uint8Array(24);
  setU32(body, 8, 1);
  return makeBox('trex', [body]);
}

function readTfdt(b, tfdt) {
  const p = tfdt.start + tfdt.header + 4;
  return b[tfdt.start + tfdt.header] === 1 ? u32(b, p) * 2 ** 32 + u32(b, p + 4) : u32(b, p);
}

function writeTfdt(b, tfdt, value) {
  const p = tfdt.start + tfdt.header + 4;
  const v = Math.max(0, Math.round(value));
  if (b[tfdt.start + tfdt.header] === 1) {
    setU32(b, p, Math.floor(v / 2 ** 32));
    setU32(b, p + 4, v % 2 ** 32);
  } else {
    setU32(b, p, v % 2 ** 32);
  }
}

/**
 * Rewrite track IDs in a media fragment (moof/mdat …), and optionally move
 * each track's decode times earlier by `shifts` (Map oldTrackId → ticks) so the
 * merged file starts at 0. Boxes that would be wrong after merging (styp,
 * sidx) are dropped. Returns a new Uint8Array.
 */
export function remapFragment(bytes, idMap, shifts = null) {
  const keep = [];
  for (const box of readBoxes(bytes)) {
    if (box.type === 'styp' || box.type === 'sidx' || box.type === 'ftyp' || box.type === 'moov') continue;
    const copy = slice(bytes, box);
    if (box.type === 'moof') {
      for (const traf of readBoxes(copy, 8, copy.length).filter((c) => c.type === 'traf')) {
        const kids = readBoxes(copy, traf.start + traf.header, traf.end);
        const tfhd = kids.find((c) => c.type === 'tfhd');
        if (!tfhd) continue;
        const p = tfhd.start + tfhd.header + 4;
        const oldId = u32(copy, p);
        const newId = idMap.get(oldId);
        if (newId) setU32(copy, p, newId);
        const tfdt = kids.find((c) => c.type === 'tfdt');
        const shift = shifts?.get(oldId);
        if (tfdt && shift) writeTfdt(copy, tfdt, readTfdt(copy, tfdt) - shift);
      }
    }
    keep.push(copy);
  }
  const total = keep.reduce((n, k) => n + k.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const k of keep) {
    out.set(k, p);
    p += k.length;
  }
  return out;
}

/**
 * Decode time (seconds) of the first track fragment in a media fragment,
 * given Map(trackId → timescale). Used to interleave audio and video.
 */
export function fragmentStartTime(bytes, timescales) {
  for (const moof of readBoxes(bytes).filter((x) => x.type === 'moof')) {
    for (const traf of children(bytes, moof).filter((c) => c.type === 'traf')) {
      const kids = children(bytes, traf);
      const tfhd = kids.find((c) => c.type === 'tfhd');
      const tfdt = kids.find((c) => c.type === 'tfdt');
      if (!tfhd || !tfdt) continue;
      const id = u32(bytes, tfhd.start + tfhd.header + 4);
      return readTfdt(bytes, tfdt) / (timescales.get(id) || 90000);
    }
  }
  return 0;
}

/**
 * Read a segment index (sidx) box. `bytes` holds file bytes starting at file
 * offset `bytesOffset`; returns subsegment byte ranges (absolute offsets in the
 * file) and durations, or null if there is no usable single-level sidx.
 */
export function parseSidx(bytes, bytesOffset = 0) {
  const box = readBoxes(bytes).find((x) => x.type === 'sidx');
  if (!box) return null;
  let p = box.start + box.header;
  const version = bytes[p];
  p += 4; // version + flags
  p += 4; // reference_ID
  const timescale = u32(bytes, p);
  p += 4;
  let firstOffset;
  if (version === 0) {
    p += 4; // earliest_presentation_time
    firstOffset = u32(bytes, p);
    p += 4;
  } else {
    p += 8;
    firstOffset = u32(bytes, p) * 2 ** 32 + u32(bytes, p + 4);
    p += 8;
  }
  p += 2; // reserved
  const count = (bytes[p] << 8) | bytes[p + 1];
  p += 2;
  const segments = [];
  let offset = bytesOffset + box.end + firstOffset;
  for (let i = 0; i < count; i++) {
    const word = u32(bytes, p);
    if (word >>> 31) return null; // points at another sidx: not supported
    const size = word & 0x7fffffff;
    const duration = u32(bytes, p + 4);
    segments.push({ offset, length: size, duration: duration / (timescale || 1) });
    offset += size;
    p += 12;
  }
  return { timescale, segments, initEnd: bytesOffset + box.start };
}

/** Split a self-contained fragmented MP4 into its init (ftyp+moov) and the rest. */
export function splitInit(bytes) {
  const boxes = readBoxes(bytes);
  const moov = boxes.find((x) => x.type === 'moov');
  if (!moov) return null;
  return { init: bytes.slice(0, moov.end), rest: bytes.slice(moov.end) };
}

export const hasBox = (bytes, type) => readBoxes(bytes).some((x) => x.type === type);
export { makeBox as _makeBox, CONTAINERS as _containers };
