// Builds the dynamic parts of test/more.html.
const log = (t) => (document.getElementById('log').textContent += `${t}\n`);
const APPLE = 'https://devstreaming-cdn.apple.com/videos/streaming/examples';

function makePlayer(mode) {
  return class extends HTMLElement {
    connectedCallback() {
      if (this.shadowRoot || this._root) return;
      this._root = this.attachShadow({ mode });
      const video = document.createElement('video');
      video.src = this.dataset.src;
      video.controls = true;
      video.muted = true;
      video.width = 360;
      video.title = this.title;
      this._root.append(video);
    }
  };
}
customElements.define('open-player', makePlayer('open'));
customElements.define('closed-player', makePlayer('closed'));

// Native HLS: the <video> points straight at a playlist.
document.getElementById('native-hls').src =
  `/test/hls/trim.m3u8?${new URLSearchParams({ src: `${APPLE}/bipbop_4x3/bipbop_4x3_variant.m3u8`, n: 2 })}`;

// about:blank iframe: the parent writes a video into it.
const frame = document.getElementById('blank-frame');
const doc = frame.contentDocument;
doc.open();
// A distinct URL, so it isn't merged with the identical file elsewhere on the page.
doc.write('<!doctype html><body style="margin:0"><video src="/test/video/sample-720.webm?in=iframe" title="about:blank iframe video" muted controls width="340"></video></body>');
doc.close();

async function touch(url) {
  try {
    const res = await fetch(url);
    log(`requested ${url} → ${res.status} ${res.headers.get('content-type')}`);
  } catch (err) {
    log(`failed ${url}: ${err.message}`);
  }
}

// Like a player would: fetch the manifests so the extension sees them.
touch('/test/hls/noext/playlist?id=bbb');
touch('/test/dash/list.mpd?n=3');
touch('/test/dash/base.mpd?n=3');
touch('/test/dash/drm.mpd?n=3');
touch('/test/dash/live.mpd?n=3');
