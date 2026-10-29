// Requests each test playlist so the extension's network sniffer sees it.
const APPLE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples';
const q = (params) => new URLSearchParams(params).toString();

const SHORT = [
  {
    name: 'Muxed TS, 4 qualities (bipbop 4×3)',
    url: `/test/hls/trim.m3u8?${q({ src: `${APPLE}/bipbop_4x3/bipbop_4x3_variant.m3u8`, n: 3 })}`,
    expect: 'Qualities listed by bitrate. Downloads as .ts (or .mp4 with "Convert HLS to MP4" on) with picture and sound.',
  },
  {
    name: 'TS video + separate AAC audio (advanced example)',
    url: `/test/hls/trim.m3u8?${q({ src: `${APPLE}/img_bipbop_adv_example_ts/master.m3u8`, n: 3 })}`,
    expect: '1080p…270p with AAC / AC-3 audio choices. The AAC choices save one .mp4 with picture and sound (HLS-5).',
  },
  {
    name: 'fMP4 (CMAF) video + separate audio, byte ranges',
    url: `/test/hls/trim.m3u8?${q({ src: `${APPLE}/img_bipbop_adv_example_fmp4/master.m3u8`, n: 3 })}`,
    expect: 'Saves one .mp4 with both tracks.',
  },
  {
    name: 'AES-128 encrypted (standard HLS, test key)',
    url: `/test/hls/aes.m3u8?${q({ src: `${APPLE}/bipbop_4x3/gear2/prog_index.m3u8`, n: 3 })}`,
    expect: 'Decrypts and saves a playable file (HLS-4).',
  },
  {
    name: 'Flaky segment (fails twice, then works)',
    url: `/test/hls/flaky.m3u8?${q({ src: `${APPLE}/bipbop_4x3/gear1/prog_index.m3u8`, n: 4 })}`,
    expect: 'Retries after 1 s and 2 s, then completes (HLS-6).',
  },
  {
    name: 'Blocked segment (403)',
    url: '/test/hls/forbidden.m3u8',
    expect: 'Pauses with "This site blocked the download…", with Retry and Cancel.',
  },
  {
    name: 'Live stream (no ENDLIST)',
    url: `/test/hls/live.m3u8?${q({ src: `${APPLE}/bipbop_4x3/gear1/prog_index.m3u8` })}`,
    expect: '"Live stream — not supported in v1" (HLS-7).',
  },
  {
    name: 'DRM (SAMPLE-AES, FairPlay)',
    url: '/test/hls/drm.m3u8',
    expect: '"Protected — not downloadable" (HLS-4).',
  },
];

const FULL = [
  { name: 'bipbop 4×3 (TS, ~30 min)', url: `${APPLE}/bipbop_4x3/bipbop_4x3_variant.m3u8` },
  { name: 'Advanced example, TS (~10 min)', url: `${APPLE}/img_bipbop_adv_example_ts/master.m3u8` },
  { name: 'Advanced example, fMP4 (~10 min)', url: `${APPLE}/img_bipbop_adv_example_fmp4/master.m3u8` },
];

const log = (text) => (document.getElementById('log').textContent += `${text}\n`);

async function touch(url) {
  try {
    const res = await fetch(url, { mode: 'no-cors' });
    log(`requested ${url.slice(0, 90)} (${res.type === 'opaque' ? 'cross-origin' : res.status})`);
  } catch (err) {
    log(`failed ${url}: ${err.message}`);
  }
}

for (const s of SHORT) {
  const li = document.createElement('li');
  li.innerHTML = `<strong></strong><span class="expect"></span>`;
  li.querySelector('strong').textContent = s.name;
  li.querySelector('.expect').textContent = `Expect: ${s.expect}`;
  document.getElementById('streams').append(li);
  touch(s.url);
}

for (const s of FULL) {
  const li = document.createElement('li');
  const button = document.createElement('button');
  button.textContent = `Capture: ${s.name}`;
  button.addEventListener('click', () => touch(s.url));
  li.append(button);
  document.getElementById('full').append(li);
}
