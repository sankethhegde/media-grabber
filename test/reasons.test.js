// Unit tests for utils/reasons.js — plain Node, no framework.
//   node test/reasons.test.js
import assert from 'node:assert/strict';
import { REASONS, downloadErrorMessage, itemBlockReason, siteReason, streamErrorReason } from '../utils/reasons.js';

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

console.log('reasons.js');

test('YouTube pages explain why streamed videos cannot be saved', () => {
  for (const url of ['https://www.youtube.com/watch?v=x', 'https://m.youtube.com/shorts/y', 'https://www.youtube-nocookie.com/embed/z']) {
    const r = itemBlockReason({ type: 'streamed' }, url);
    assert.equal(r.short, 'Not supported on YouTube', url);
    assert.match(r.detail, /scrambles/);
  }
});

test('streaming services name themselves in the DRM explanation', () => {
  assert.match(itemBlockReason({ type: 'streamed' }, 'https://www.netflix.com/watch/1').detail, /^Netflix protects/);
  assert.match(itemBlockReason({ type: 'protected' }, 'https://www.hotstar.com/in/x').detail, /^Disney\+ Hotstar/);
});

test('look-alike hosts do not match site rules', () => {
  assert.equal(siteReason('https://notyoutube.com/'), null);
  assert.equal(siteReason('https://youtube.com.evil.example/'), null);
});

test('generic DRM, no-stream, live and analyzing reasons', () => {
  assert.equal(itemBlockReason({ type: 'protected' }, 'https://example.com/'), REASONS.drm);
  assert.equal(itemBlockReason({ type: 'streamed' }, 'https://example.com/'), REASONS.noStream);
  assert.equal(itemBlockReason({ type: 'hls', live: true }, 'https://example.com/'), REASONS.live);
  assert.equal(itemBlockReason({ type: 'dash', analyzing: true }, 'https://example.com/'), REASONS.analyzing);
});

test('a streamed video whose stream is unusable shows the stream’s reason', () => {
  const r = itemBlockReason({ type: 'streamed', streamDetected: true, streamReason: REASONS.live }, 'https://example.com/');
  assert.equal(r, REASONS.live);
});

test('downloadable items have no reason', () => {
  assert.equal(itemBlockReason({ type: 'direct' }, 'https://www.youtube.com/'), null, 'site rules never block plain files');
  assert.equal(itemBlockReason({ type: 'hls' }, 'https://example.com/'), null);
});

test('stream errors are explained by cause', () => {
  assert.match(streamErrorReason('HTTP 403').detail, /refused access.*HTTP 403.*expired/);
  assert.match(streamErrorReason('HTTP 404').detail, /no longer exists/);
  assert.match(streamErrorReason('HTTP 503').detail, /server had a problem/);
  assert.match(streamErrorReason('This operation was aborted').detail, /didn’t answer in time/);
  assert.match(streamErrorReason('not a playlist').detail, /not to be a playlist/);
  assert.equal(streamErrorReason('HTTP 403').short, 'Couldn’t read the stream');
});

test('download error codes map to plain explanations', () => {
  assert.match(downloadErrorMessage('FILE_NO_SPACE'), /disk is full/);
  assert.match(downloadErrorMessage('SERVER_FORBIDDEN'), /blocked the download/);
  assert.match(downloadErrorMessage('SOMETHING_NEW'), /SOMETHING_NEW/);
  assert.equal(downloadErrorMessage('USER_CANCELED'), null, 'no message when the user cancelled');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
