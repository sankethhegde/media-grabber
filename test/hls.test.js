// Unit tests for background/hls.js — plain Node, no framework.
//   node test/hls.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDrmKey, ivFor, parseAttributes, parsePlaylist, qualitiesFromMaster, variantLabel } from '../background/hls.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const BASE = 'https://cdn.example.com/show/master.m3u8';

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

console.log('hls.js');

test('parseAttributes handles quoted commas', () => {
  const a = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720');
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.RESOLUTION, '1280x720');
});

test('master: variants with resolution, bandwidth and absolute URLs (HLS-2)', () => {
  const m = parsePlaylist(fixture('master.m3u8'), BASE);
  assert.equal(m.kind, 'master');
  assert.equal(m.variants.length, 4);
  const v = m.variants.find((x) => x.height === 720);
  assert.equal(v.url, 'https://cdn.example.com/show/v720/index.m3u8');
  assert.equal(v.bandwidth, 2800000);
  assert.equal(v.audioGroup, 'aac');
});

test('master: separate audio renditions are collected (HLS-5)', () => {
  const m = parsePlaylist(fixture('master.m3u8'), BASE);
  const aac = m.audio.find((a) => a.groupId === 'aac' && a.default);
  assert.equal(aac.url, 'https://cdn.example.com/show/audio/en.m3u8');
});

test('master: lists every child playlist (audio, subtitles, i-frames)', () => {
  const m = parsePlaylist(fixture('master.m3u8'), BASE);
  assert.deepEqual(m.renditionUrls.map((u) => u.replace('https://cdn.example.com/show/', '')).sort(), [
    'audio/en.m3u8', 'audio/fr.m3u8', 'subs/en.m3u8', 'v720/iframes.m3u8',
  ]);
});

test('qualitiesFromMaster: best first, labelled, audio attached', () => {
  const q = qualitiesFromMaster(parsePlaylist(fixture('master.m3u8'), BASE));
  assert.deepEqual(q.map((x) => x.label), ['1080p · 5.0 Mbps', '720p · 2.8 Mbps', '360p · 800 kbps', 'Audio only · 64 kbps']);
  assert.equal(q[1].audioUrl, 'https://cdn.example.com/show/audio/en.m3u8');
});

test('qualitiesFromMaster: subtitle renditions follow the variant group', () => {
  const q = qualitiesFromMaster(parsePlaylist(fixture('master.m3u8'), BASE));
  const v720 = q.find((x) => x.height === 720);
  assert.deepEqual(v720.subtitles, [{ url: 'https://cdn.example.com/show/subs/en.m3u8', language: '', name: 'English' }]);
});

test('qualitiesFromMaster: at equal height, AAC sorts before AC-3', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",DEFAULT=YES,URI="a.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="b",NAME="en",DEFAULT=YES,URI="b.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=3500000,CODECS="avc1.640020,ac-3",RESOLUTION=1280x720,AUDIO="b"',
    'v.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3200000,CODECS="avc1.640020,mp4a.40.2",RESOLUTION=1280x720,AUDIO="a"',
    'v.m3u8',
  ].join('\n');
  const q = qualitiesFromMaster(parsePlaylist(text, BASE));
  assert.deepEqual(q.map((x) => x.label), ['720p · 3.2 Mbps · AAC', '720p · 3.5 Mbps · AC-3']);
});

test('variantLabel adds codec hints when needed', () => {
  assert.equal(variantLabel({ height: 2160, bandwidth: 15e6, codecs: 'hvc1.2.4.L150,mp4a.40.2' }), '2160p · 15.0 Mbps · HEVC');
  assert.equal(variantLabel({ height: 720, bandwidth: 3e6, frameRate: 60, codecs: 'avc1.640020,ac-3' }, { showAudioCodec: true }), '720p60 · 3.0 Mbps · AC-3');
});

test('media (TS): segments, durations, sequence numbers, ENDLIST', () => {
  const m = parsePlaylist(fixture('media-ts.m3u8'), 'https://cdn.example.com/show/v720/index.m3u8');
  assert.equal(m.kind, 'media');
  assert.equal(m.segments.length, 3);
  assert.equal(m.segments[0].url, 'https://cdn.example.com/show/v720/seg0.ts');
  assert.equal(m.segments[2].url, 'https://other.example.net/abs/seg2.ts');
  assert.equal(m.segments[1].sequence, 11);
  assert.equal(m.totalDuration, 16);
  assert.equal(m.endList, true);
  assert.equal(m.container, 'ts');
  assert.equal(m.encryption, 'none');
});

test('media (fMP4): EXT-X-MAP and byte ranges with implied offsets', () => {
  const m = parsePlaylist(fixture('media-fmp4.m3u8'), 'https://cdn.example.com/show/v1080/index.m3u8');
  assert.equal(m.container, 'fmp4');
  assert.deepEqual(m.segments[0].map, { url: 'https://cdn.example.com/show/v1080/main.mp4', byteRange: { length: 720, offset: 0 } });
  assert.deepEqual(m.segments[0].byteRange, { length: 1000, offset: 720 });
  assert.deepEqual(m.segments[1].byteRange, { length: 2000, offset: 1720 }, 'offset continues from the previous range');
  assert.deepEqual(m.segments[2].byteRange, { length: 500, offset: 9000 });
});

test('media: AES-128 is standard encryption, with key URL and IV (HLS-4)', () => {
  const m = parsePlaylist(fixture('media-aes.m3u8'), 'https://cdn.example.com/show/v720/index.m3u8');
  assert.equal(m.encryption, 'aes-128');
  assert.equal(m.segments[0].key.uri, 'https://cdn.example.com/show/keys/k1.bin');
  assert.equal(m.segments[1].key.iv, '0x000102030405060708090A0B0C0D0E0F');
  assert.equal(m.segments[2].key, null, 'METHOD=NONE clears the key');
});

test('ivFor: explicit IV, else media sequence number', () => {
  const m = parsePlaylist(fixture('media-aes.m3u8'), 'https://cdn.example.com/x/index.m3u8');
  assert.deepEqual([...ivFor(m.segments[1])], [...Array(16).keys()]);
  const iv0 = ivFor(m.segments[0]);
  assert.equal(iv0[15], 5);
  assert.equal(iv0.slice(0, 15).every((b) => b === 0), true);
});

test('media: SAMPLE-AES / Widevine / FairPlay count as DRM (HLS-4)', () => {
  assert.equal(parsePlaylist(fixture('media-drm.m3u8'), BASE).encryption, 'drm');
  assert.equal(isDrmKey({ method: 'AES-128', keyformat: 'com.apple.streamingkeydelivery' }), true);
  assert.equal(isDrmKey({ method: 'AES-128', keyformat: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' }), true);
  assert.equal(isDrmKey({ method: 'SAMPLE-AES-CTR' }), true);
  assert.equal(isDrmKey({ method: 'AES-128', keyformat: 'identity' }), false);
});

test('master: EXT-X-SESSION-KEY with a DRM key marks the stream protected', () => {
  const text = '#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n';
  assert.equal(parsePlaylist(text, BASE).drm, true);
});

test('media: no ENDLIST means live (HLS-7)', () => {
  const m = parsePlaylist(fixture('media-live.m3u8'), BASE);
  assert.equal(m.endList, false);
});

test('rejects non-playlists', () => {
  assert.throws(() => parsePlaylist('<html>', BASE), /Not an HLS playlist/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
