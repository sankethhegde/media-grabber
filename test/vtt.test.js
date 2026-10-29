// Unit tests for offscreen/vtt.js — plain Node, no framework.
//   node test/vtt.test.js
import assert from 'node:assert/strict';
import { combineVtt, languageSuffix } from '../offscreen/vtt.js';

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

console.log('vtt.js');

test('combineVtt keeps one header and every cue once', () => {
  const a = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n1\n00:00:01.000 --> 00:00:03.000\nHello\n\n2\n00:00:05.000 --> 00:00:07.000\nSpans the boundary\n';
  const b = '﻿WEBVTT\r\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\r\n\r\n7\r\n00:00:05.000 --> 00:00:07.000\r\nSpans the boundary\r\n\r\n8\r\n00:00:08.000 --> 00:00:09.000\r\nBye\r\n';
  const out = combineVtt([a, b]);
  assert.equal(out.match(/WEBVTT/g).length, 1);
  assert.equal(out.match(/-->/g).length, 3);
  assert.ok(out.startsWith('WEBVTT\n\n1\n00:00:01.000'));
  assert.ok(!out.includes('X-TIMESTAMP-MAP'));
});

test('combineVtt with no cues is still a valid file', () => {
  assert.equal(combineVtt(['WEBVTT\n\n']), 'WEBVTT\n\n\n');
});

test('languageSuffix makes a safe tag', () => {
  assert.equal(languageSuffix('pt-BR', '', 0), 'pt-BR');
  assert.equal(languageSuffix('', 'English (CC)', 1), 'English-CC');
  assert.equal(languageSuffix('', '', 2), 'sub3');
  assert.equal(languageSuffix('../en', '', 0), 'en');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
