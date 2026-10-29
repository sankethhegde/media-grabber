// Unit tests for utils/filename.js — plain Node, no framework.
//   node test/filename.test.js
import assert from 'node:assert/strict';
import {
  MAX_FILENAME_LENGTH,
  buildFilename,
  bulkFolderName,
  extFromMime,
  extFromUrl,
  sanitize,
  siteFromUrl,
} from '../utils/filename.js';

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

console.log('filename.js');

test('sanitize removes \\ / : * ? " < > |', () => {
  assert.equal(sanitize('a\\b/c:d*e?f"g<h>i|j'), 'a b c d e f g h i j');
});

test('sanitize trims dots/spaces and collapses whitespace', () => {
  assert.equal(sanitize('  ..My   photo.. '), 'My photo');
});

test('sanitize strips control characters', () => {
  assert.equal(sanitize('a\u0000b\nc\td'), 'a b c d');
});

test('sanitize guards Windows reserved names', () => {
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(sanitize('lpt1'), '_lpt1');
});

test('siteFromUrl drops www and handles junk', () => {
  assert.equal(siteFromUrl('https://www.example.co.uk/page'), 'example.co.uk');
  assert.equal(siteFromUrl('not a url'), 'media');
});

test('extFromUrl reads the path extension', () => {
  assert.equal(extFromUrl('https://x.com/a/b/photo.JPEG?w=100'), 'jpg');
  assert.equal(extFromUrl('https://x.com/clip.webm'), 'webm');
});

test('extFromUrl reads CDN format params', () => {
  assert.equal(extFromUrl('https://images.unsplash.com/photo-123?fm=webp&w=800', ''), 'webp');
});

test('extFromUrl reads data: MIME types', () => {
  assert.equal(extFromUrl('data:image/png;base64,AAAA'), 'png');
  assert.equal(extFromUrl('data:image/svg+xml,<svg/>'), 'svg');
});

test('extFromUrl falls back for unknown extensions', () => {
  assert.equal(extFromUrl('https://x.com/image', 'jpg'), 'jpg');
  assert.equal(extFromUrl('https://x.com/script.php', ''), '');
});

test('extFromMime maps content types', () => {
  assert.equal(extFromMime('image/webp; charset=binary'), 'webp');
  assert.equal(extFromMime('application/json', ''), '');
});

test('buildFilename fills the default pattern', () => {
  const name = buildFilename({
    pattern: '{site}_{title}_{quality}.{ext}',
    site: 'example.com',
    title: 'A cat: sitting?',
    quality: '1600w',
    ext: 'jpg',
  });
  assert.equal(name, 'example.com_A cat sitting_1600w.jpg');
});

test('buildFilename tidies separators left by empty tokens', () => {
  const name = buildFilename({ pattern: '{site}_{title}_{quality}.{ext}', site: 'example.com', title: '', quality: '', ext: 'png' });
  assert.equal(name, 'example.com.png');
});

test('buildFilename caps length at 150 and keeps the extension', () => {
  const name = buildFilename({
    pattern: '{site}_{title}_{quality}.{ext}',
    site: 'example.com',
    title: 'x'.repeat(400),
    quality: '1080w',
    ext: 'webp',
  });
  assert.ok(name.length <= MAX_FILENAME_LENGTH, `length ${name.length}`);
  assert.ok(name.endsWith('.webp'));
});

test('buildFilename never lets tokens inject path separators', () => {
  const name = buildFilename({ pattern: '{title}.{ext}', site: 's', title: '../../etc/passwd', quality: '', ext: 'jpg' });
  assert.ok(!name.includes('/') && !name.includes('\\'), name);
});

test('buildFilename supports custom patterns', () => {
  assert.equal(buildFilename({ pattern: '{quality}-{site}.{ext}', site: 'a.com', title: 't', quality: '2x', ext: 'gif' }), '2x-a.com.gif');
});

test('bulkFolderName is {site}_{yyyy-mm-dd}', () => {
  assert.equal(bulkFolderName('example.com', new Date(2026, 9, 4)), 'example.com_2026-10-04');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
