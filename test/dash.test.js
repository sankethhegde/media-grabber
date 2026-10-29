// Unit tests for background/dash.js — plain Node, no framework.
//   node test/dash.test.js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fillTemplate, findRep, parseDuration, parseMpd, parseXml, qualitiesFromMpd, segmentsFor } from '../background/dash.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const URL_ = 'https://cdn.example.com/show/manifest.mpd';

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

console.log('dash.js');

test('parseXml: attributes, nesting, entities, prefixes, comments', () => {
  const doc = parseXml('<?xml version="1.0"?><!-- c --><a:Root x="1 &amp; 2"><B y=\'z\'/><C>t &lt;3</C></a:Root>');
  const root = doc.children[0];
  assert.equal(root.name, 'Root');
  assert.equal(root.attrs.x, '1 & 2');
  assert.equal(root.children[0].attrs.y, 'z');
  assert.equal(root.children[1].text, 't <3');
});

test('parseDuration handles ISO 8601 durations', () => {
  assert.equal(parseDuration('PT0M12.000S'), 12);
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('bogus'), null);
});

test('fillTemplate: identifiers, padding, $$', () => {
  assert.equal(fillTemplate('$RepresentationID$/$Number%05d$.m4s', { RepresentationID: 'v1', Number: 42 }), 'v1/00042.m4s');
  assert.equal(fillTemplate('t-$Time$-$$', { Time: 9000 }), 't-9000-$');
});

test('SegmentTemplate + SegmentTimeline: times, repeats, BaseURL chain', () => {
  const mpd = parseMpd(fixture('dash-timeline.mpd'), URL_);
  const { rep, period } = findRep(mpd, 'v720');
  const s = segmentsFor(rep, period);
  assert.equal(s.container, 'fmp4');
  assert.equal(s.init.url, 'https://cdn.example.com/show/media/v720/init.mp4');
  assert.deepEqual(s.segments.map((x) => x.url.split('/').pop()), ['seg-0.m4s', 'seg-4000.m4s', 'seg-8000.m4s']);
  assert.deepEqual(s.segments.map((x) => x.duration), [4, 4, 4]);
});

test('SegmentTimeline r="-1" repeats to the end of the period', () => {
  const mpd = parseMpd(fixture('dash-timeline.mpd'), URL_);
  const { rep, period } = findRep(mpd, 'a128');
  const s = segmentsFor(rep, period);
  assert.deepEqual(s.segments.map((x) => x.url.split('/').pop()), ['00001.m4s', '00002.m4s', '00003.m4s']);
});

test('SegmentTemplate with @duration: count from the period length', () => {
  const mpd = parseMpd(fixture('dash-number.mpd'), URL_);
  const { rep, period } = findRep(mpd, '360');
  const s = segmentsFor(rep, period);
  assert.deepEqual(s.segments.map((x) => x.url.split('/').pop()), ['chunk-360-0.m4s', 'chunk-360-1.m4s', 'chunk-360-2.m4s']);
  assert.deepEqual(s.segments.map((x) => x.duration), [4, 4, 2]);
});

test('SegmentList with byte ranges', () => {
  const mpd = parseMpd(fixture('dash-list-base.mpd'), URL_);
  const { rep, period } = findRep(mpd, 'v');
  const s = segmentsFor(rep, period);
  assert.deepEqual(s.init, { url: 'https://cdn.example.net/v/main.mp4', byteRange: { offset: 0, length: 720 } });
  assert.deepEqual(s.segments.map((x) => x.byteRange), [{ offset: 720, length: 1000 }, { offset: 1720, length: 2000 }]);
});

test('SegmentBase: index to be read from the sidx', () => {
  const mpd = parseMpd(fixture('dash-list-base.mpd'), URL_);
  const { rep, period } = findRep(mpd, 'a');
  const s = segmentsFor(rep, period);
  assert.deepEqual(s.index, {
    url: 'https://cdn.example.com/show/audio.mp4',
    range: { offset: 616, length: 96 },
    initRange: { offset: 0, length: 616 },
  });
});

test('qualitiesFromMpd: best first, paired with the main AAC audio, labelled', () => {
  const { qualities, drm, subtitles } = qualitiesFromMpd(parseMpd(fixture('dash-timeline.mpd'), URL_));
  assert.equal(drm, false);
  assert.deepEqual(qualities.map((q) => q.label), ['1080p60 · 5.1 Mbps', '720p · 2.9 Mbps']);
  assert.equal(qualities[0].videoId, 'v1080');
  assert.equal(qualities[0].audioId, 'a128');
  assert.deepEqual(subtitles, [{ id: 'sub-en', language: 'en', name: 'English & SDH', container: 'vtt' }]);
});

test('ContentProtection marks the stream as DRM', () => {
  const text = fixture('dash-number.mpd').replace(
    '<AdaptationSet mimeType="video/mp4">',
    '<AdaptationSet mimeType="video/mp4"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>',
  );
  assert.equal(qualitiesFromMpd(parseMpd(text, URL_)).drm, true);
});

test('type="dynamic" is live', () => {
  const text = fixture('dash-number.mpd').replace('type="static"', 'type="dynamic"');
  assert.equal(parseMpd(text, URL_).live, true);
});

test('rejects non-MPD documents', () => {
  assert.throws(() => parseMpd('<html></html>', URL_), /Not a DASH manifest/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
