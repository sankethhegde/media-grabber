// Unit tests for offscreen/mp4.js — plain Node, no framework.
//   node test/mp4.test.js
import assert from 'node:assert/strict';
import { describeInit, fragmentStartTime, mergeInits, parseSidx, readBoxes, remapFragment, splitInit, _makeBox as box } from '../offscreen/mp4.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}\n       ${err.message.split('\n').join('\n       ')}`);
  }
}

// --- tiny builders for the boxes the merger touches
const u32 = (...vals) => {
  const b = new Uint8Array(vals.length * 4);
  vals.forEach((v, i) => new DataView(b.buffer).setUint32(i * 4, v));
  return b;
};
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const tkhd = (id) => box('tkhd', [u32(0 /*v0 flags*/, 0, 0, id, 0, 0)]);
const mdhd = (timescale) => box('mdhd', [u32(0, 0, 0, timescale, 0, 0)]);
const hdlr = (type) => box('hdlr', [u32(0, 0), ascii(type), u32(0, 0, 0), ascii('x\0')]);
const trak = (id, type, timescale) => box('trak', [tkhd(id), box('mdia', [mdhd(timescale), hdlr(type)])]);
const trex = (id) => box('trex', [u32(0, id, 1, 0, 0, 0)]);
const mvhd = (next) => box('mvhd', [u32(0, 0, 0, 1000, 0), new Uint8Array(76), u32(next)]);
const init = (tracks) =>
  concat(
    box('ftyp', [ascii('isom'), u32(1), ascii('isomiso6')]),
    box('moov', [mvhd(tracks.length + 1), ...tracks.map(([id, t, ts]) => trak(id, t, ts)), box('mvex', tracks.map(([id]) => trex(id)))]),
  );
const fragment = (id, ticks, payload = [1, 2, 3]) =>
  concat(
    box('styp', [ascii('msdh')]),
    box('sidx', [u32(0, id)]),
    box('moof', [box('mfhd', [u32(0, 1)]), box('traf', [box('tfhd', [u32(0x020000, id)]), box('tfdt', [u32(0x01000000, 0, ticks)])])]),
    box('mdat', [Uint8Array.from(payload)]),
  );
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
const tfhdIds = (bytes) => {
  const ids = [];
  for (const moof of readBoxes(bytes).filter((b) => b.type === 'moof')) {
    for (const traf of readBoxes(bytes, moof.start + 8, moof.end).filter((b) => b.type === 'traf')) {
      const t = readBoxes(bytes, traf.start + 8, traf.end).find((b) => b.type === 'tfhd');
      ids.push(new DataView(bytes.buffer, bytes.byteOffset).getUint32(t.start + 12));
    }
  }
  return ids;
};

console.log('mp4.js');

test('readBoxes walks top-level boxes', () => {
  assert.deepEqual(readBoxes(init([[1, 'vide', 90000]])).map((b) => b.type), ['ftyp', 'moov']);
});

test('describeInit reports track id, handler and timescale', () => {
  assert.deepEqual(describeInit(init([[256, 'vide', 90000], [257, 'soun', 44100]])), [
    { id: 256, handler: 'vide', timescale: 90000 },
    { id: 257, handler: 'soun', timescale: 44100 },
  ]);
});

test('mergeInits: video + audio become tracks 1 and 2, both with trex', () => {
  const v = init([[1, 'vide', 90000]]);
  const a = init([[1, 'soun', 48000]]); // same id as video — must be renumbered
  const { init: merged, maps } = mergeInits([{ init: v }, { init: a, handlers: ['soun'] }]);
  assert.deepEqual(describeInit(merged), [
    { id: 1, handler: 'vide', timescale: 90000 },
    { id: 2, handler: 'soun', timescale: 48000 },
  ]);
  assert.equal(maps[0].get(1), 1);
  assert.equal(maps[1].get(1), 2);
  const moov = readBoxes(merged).find((b) => b.type === 'moov');
  const kids = readBoxes(merged, moov.start + 8, moov.end).map((b) => b.type);
  assert.deepEqual(kids, ['mvhd', 'trak', 'trak', 'mvex']);
  const mvhdBox = readBoxes(merged, moov.start + 8, moov.end)[0];
  assert.equal(new DataView(merged.buffer).getUint32(mvhdBox.end - 4), 3, 'next_track_ID');
});

test('mergeInits: handlers filter skips unwanted tracks', () => {
  const muxed = init([[1, 'vide', 90000], [2, 'soun', 48000]]);
  const { init: merged } = mergeInits([{ init: muxed, handlers: ['vide'] }]);
  assert.deepEqual(describeInit(merged).map((t) => t.handler), ['vide']);
});

test('remapFragment rewrites tfhd ids and drops styp/sidx', () => {
  const out = remapFragment(fragment(1, 9000), new Map([[1, 2]]));
  assert.deepEqual(readBoxes(out).map((b) => b.type), ['moof', 'mdat']);
  assert.deepEqual(tfhdIds(out), [2]);
  const mdat = readBoxes(out).find((b) => b.type === 'mdat');
  assert.deepEqual([...out.slice(mdat.start + 8, mdat.end)], [1, 2, 3], 'payload untouched');
});

test('remapFragment shifts decode times so the file starts at 0', () => {
  // 10 s into a 90 kHz track, shifted back by 10 s → 0; 12 s → 2 s.
  const at10 = remapFragment(fragment(1, 900000), new Map([[1, 1]]), new Map([[1, 900000]]));
  const at12 = remapFragment(fragment(1, 1080000), new Map([[1, 1]]), new Map([[1, 900000]]));
  assert.equal(fragmentStartTime(at10, new Map([[1, 90000]])), 0);
  assert.equal(fragmentStartTime(at12, new Map([[1, 90000]])), 2);
});

test('fragmentStartTime converts tfdt ticks to seconds', () => {
  assert.equal(fragmentStartTime(fragment(7, 180000), new Map([[7, 90000]])), 2);
  assert.equal(fragmentStartTime(fragment(2, 96000), new Map([[2, 48000]])), 2);
});

test('parseSidx turns references into absolute byte ranges', () => {
  // v0 sidx: timescale 1000, first_offset 0, two refs: 500 B / 2 s and 700 B / 2.5 s.
  const sidx = box('sidx', [
    u32(0, 1, 1000, 0, 0),
    Uint8Array.from([0, 0, 0, 2]), // reserved, reference_count = 2
    u32(500, 2000, 0x90000000, 700, 2500, 0x90000000),
  ]);
  const file = concat(init([[1, 'vide', 90000]]), sidx);
  const sidxStart = file.length - sidx.length;
  const parsed = parseSidx(file.slice(sidxStart), sidxStart);
  assert.deepEqual(parsed.segments, [
    { offset: file.length, length: 500, duration: 2 },
    { offset: file.length + 500, length: 700, duration: 2.5 },
  ]);
  assert.equal(parsed.initEnd, sidxStart);
});

test('parseSidx refuses hierarchical indexes', () => {
  const sidx = box('sidx', [u32(0, 1, 1000, 0, 0), Uint8Array.from([0, 0, 0, 1]), u32(0x80000000 | 500, 2000, 0)]);
  assert.equal(parseSidx(sidx, 0), null);
});

test('splitInit separates ftyp+moov from fragments', () => {
  const i = init([[1, 'vide', 90000]]);
  const f = fragment(1, 0);
  const { init: head, rest } = splitInit(concat(i, f));
  assert.equal(head.length, i.length);
  assert.deepEqual(readBoxes(rest).map((b) => b.type), ['styp', 'sidx', 'moof', 'mdat']);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
