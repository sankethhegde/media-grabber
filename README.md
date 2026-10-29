# Media Grabber

A Chrome (Manifest V3) extension that finds the images and videos on a page and lets you download them, choosing a quality where the page offers more than one. It's for personal use and loads unpacked. There's no build step and nothing to install.

**Status: all three phases of the spec are done:** images, direct video with the hover button and settings, and HLS stream download. Version 1.3 adds DASH download, Shadow DOM support, smarter stream detection, page-data videos and subtitles (see [Wider coverage](#wider-coverage-13)).

**What it won't download, by design:** DRM-protected video (Netflix, Prime Video, Disney+ and other paid streaming) and sites that deliberately scramble their video URLs (YouTube). These show as "Protected" or "Streamed". Your spec's compliance limits rule out working around those protections.

## Install

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `media-grabber` folder.
4. Optional: pin the extension from the puzzle-piece menu.
5. Optional, for local files: on the extension's **Details** page, turn on **Allow access to file URLs**.

After you edit any file, click the reload icon on the extension's card, then reload the tabs you test on. That way the new content script (and the hover button) is loaded.

> **Why this matters:** Chrome reads the popup's files fresh from disk every time you open it. The background service worker and the content scripts, though, keep running the old code until the extension is reloaded. Without a reload you get a new popup on top of an old scanner, so new features (for example video detection) show nothing. Since 1.1.0 the popup detects this and shows a **Reload extension** button.

## Images (Phase 1)

| Spec ID | Behaviour |
|---|---|
| IMG-1 | `<img>` elements: `currentSrc` and every `srcset` candidate, plus common lazy-load attributes (`data-src`, `data-srcset`, `data-lazy-src`, `data-original`) |
| IMG-2 | `<picture><source srcset>` candidates, grouped with their `<img>` |
| IMG-3 | CSS `background-image` (and `::before`/`::after`, `content`, `mask-image`) on visible elements down to 8×8 px, so logos, icons and sprites are included (since 1.3.2; the spec said 100×100) |
| IMG-4 | `og:image` and `twitter:image` meta tags |
| IMG-5 | All versions of one image become one entry with a quality list (`1600w`, `2x`, or measured `W×H`). The largest is the default. Wikimedia and Unsplash also get an **Original** (full-resolution) choice. |
| IMG-6 | Skips only 1×1 tracking pixels and duplicate URLs; entries that share a URL are merged. Small inline (`data:`) images are listed since 1.3.2 (the spec skipped those under 2 KB). Since 1.3.3, video thumbnails are left out too: `<video poster>`, the preview image of a video page (og:image next to og:video, JSON-LD `thumbnailUrl`), images laid over a playing video, images inside player or video-thumbnail containers or links to video pages, and YouTube/Vimeo/Dailymotion/JW Player thumbnail URLs. |
| IMG-7 | Rescans on DOM changes (MutationObserver, 500 ms debounce, never more than 2 s behind) and when lazy images finish loading |
| IMG-8 | `blob:` and `data:` images: the content script turns blob URLs into data URLs so `chrome.downloads` can save them |

**Logos, icons and small images (1.3.2):**
- **Inline SVG logos:** `<svg>` drawings 16 px or larger are listed and saved as standalone `.svg` files. Referenced `<use>` symbols are copied in, and the colour they inherit from the page is fixed.
- **Page icons:** favicons and app icons (`<link rel="icon">`, `apple-touch-icon`, `mask-icon`, `msapplication-TileImage`, or `/favicon.ico` when that exists).
- **Other image elements:** SVG `<image>`, `<input type="image">`, and `<object>`/`<embed>` showing an image.
- **Badges:** a **LOGO** badge when the element or a nearby parent mentions "logo"/"brand", or it's the header's home link. An **ICON** badge for page icons and anything 64 px or smaller (on screen, or as a file).

**Popup filters:**
- **Show:** All images / Logos & icons / Without logos & icons.
- **Min:** Any, ≥ 16, 50, 100, 200, 300, 500, 800, 1000, 1500 or 2000 px.
- **Max:** Any, ≤ 64, 100, 200, 300, 500 or 800 px.
- **Type:** as before.

Sizes are the image's longest side. Images whose size isn't known yet (lazy images not loaded) stay visible. Your filter choices are remembered.

## Videos (Phase 2)

| Spec ID | Behaviour |
|---|---|
| VID-1 | `<video src>` and every `<source src>`. Quality comes from `size` / `label` / `res` / `data-quality` (e.g. `size="720"` → 720p). Measured `videoWidth × videoHeight` is used when known. |
| VID-2 | The service worker watches `webRequest.onHeadersReceived` for `video/*` or `.mp4/.webm/.mov/.m4v` and records URL, size and tab. Stream segments (`.ts`, `.m4s`, `seg-12`, `chunk_3`, and video responses under 100 KB) and audio are ignored. |
| VID-3 | Byte-range requests (`?range=`, `Content-Range`) collapse to one entry per file, downloaded from the range-free URL with the full size taken from `Content-Range`. |
| VID-4 | A `<video>` playing from `blob:` (MediaSource) is listed as **Streamed** and points to any `.m3u8` / `.mpd` captured on the tab. |
| VID-5 | Size is shown where the response told us. Otherwise a `HEAD` request (falling back to a one-byte range request) runs when the popup opens. |

**Other video entry types:**
- **HLS** (`.m3u8`): downloadable, see the next section.
- **DASH** (`.mpd`): downloadable since 1.3, see [Wider coverage](#wider-coverage-13).
- **Protected** (DRM): a video that fires an EME `encrypted` event or has `mediaKeys` set gets a lock and "Protected — not downloadable". Nothing is ever downloaded for it.

## HLS streams (Phase 3)

| Spec ID | Behaviour |
|---|---|
| HLS-1 | Captures `.m3u8` requests by URL or by `application/vnd.apple.mpegurl` / `x-mpegURL` content type. |
| HLS-2 | Reads the master playlist into a quality list such as "720p60 · 3.2 Mbps", best first, with an estimated size and the stream's duration. When variants differ only in audio, the label says so ("· AAC", "· AC-3"), and AAC is listed first. Child playlists (variants, audio, subtitles) are hidden so each stream shows once. |
| HLS-3 | Fetches the chosen media playlist and every segment in order, resolving relative URLs. Supports `EXT-X-BYTERANGE` and fMP4 (`EXT-X-MAP`) streams. |
| HLS-4 | Standard **AES-128** is decrypted with Web Crypto, using the key the page itself loads (explicit IV or the media sequence number). **SAMPLE-AES**, FairPlay, Widevine and PlayReady are marked "Protected — not downloadable" and never fetched. |
| HLS-5 | **Separate audio** (`EXT-X-MEDIA TYPE=AUDIO`) is downloaded too and combined with the video into **one MP4**. Track IDs are rewritten and both timelines start at 0, keeping sync. If they can't be combined, video and audio are saved as two files and the popup says so. |
| HLS-6 | Up to 6 segments in parallel (1–10 in Settings). Each failed segment is retried 3 times (after 1 s, 2 s and 4 s). If it still fails, the job **pauses** with Retry and Cancel. |
| HLS-7 | Live streams (no `#EXT-X-ENDLIST`) show "Live stream — not supported in v1". |
| HLS-8 | Saves `.ts` by default, or `.mp4` with **Convert HLS to MP4** on (remuxed by mux.js). fMP4 streams are always `.mp4`. |

**How it works.** The work happens in an **offscreen document** (`offscreen/`), not in the page or the service worker:
1. It fetches segments with the page's cookies, sent only to the media's own origin.
2. It keeps them in order, as Blobs so memory stays bounded.
3. It remuxes with the bundled `lib/mux.min.js` (Apache-2.0, see `lib/mux.js-LICENSE.txt`).
4. It hands a `blob:` URL to the service worker, which saves it with `chrome.downloads`. The blob is revoked as soon as the download finishes.

Job state lives in the offscreen document, so a download survives the service worker being stopped. The offscreen document closes itself after 30 s with nothing left to do.

**Popup:** active stream downloads appear at the top, with a progress bar, "37% · 37 / 100 segments · 2.2 MB/s · 84.3 MB" and **Cancel**. A paused job shows the reason, **Retry** and **Cancel**. A finished job shows "Saved", and ✕ clears it. Cancelling stops every request immediately.

**Limits:** merging happens in the browser, up to about 2 GB ("File too large to merge in browser" beyond that). mux.js converts H.264 and AAC. Other codecs (HEVC, AC-3 in TS) keep the original container, or combine as fMP4 when the stream is already fMP4.

## Wider coverage (1.3)

**1. DASH streams (`.mpd`).**
- **Quality list:** each video quality is paired with the best audio (the main role, AAC preferred), for example "720p · 3.4 Mbps".
- **Download:** video and audio are downloaded and combined into **one MP4** by the same engine as HLS, with the same parallelism, retries, pause, Retry/Cancel, progress and ~2 GB limit.
- **Segment addressing supported:** SegmentTemplate (by `$Number$` or with a SegmentTimeline using `$Time$`), SegmentList (byte ranges), SegmentBase (byte ranges read from the file's `sidx` index), and plain single files.
- **Not downloaded:** `ContentProtection` (Widevine/PlayReady/CENC) shows "Protected", and `type="dynamic"` (live) is refused.
- **WebM-only DASH:** saved as separate video and audio `.webm` files.
- **Multi-period manifests:** only the first period is used.

**2. Videos inside Shadow DOM.**
- **What's covered:** the scanner looks inside shadow roots, including closed ones (`chrome.dom.openOrClosedShadowRoot`), for videos, images and backgrounds.
- **Updates:** it watches each root for changes and media events.
- **Hover button:** it looks through shadow roots under the cursor, so it works on custom players.

**3. Better stream detection.**
- **Playlists with no extension or a generic content type:** when a response looks like it could be a playlist (`text/plain`, `octet-stream` and so on, with a name like "manifest", "playlist" or "master"), the extension reads its first 1 KB and checks for `#EXTM3U` / `<MPD`. That's at most 40 checks per tab.
- **Hints in the query string** are recognised too, such as `?format=m3u8`.
- **Native HLS:** `<video src="x.m3u8">` and `<source type="application/x-mpegURL">` are treated as streams, not files.
- **Frames:** content scripts now also run in `about:blank`, `srcdoc` and blob frames. The page's scanner also reads same-origin `about:` frames directly.
- **Streamed videos:** the hover button downloads the stream the page is playing, so you no longer have to open the popup for those.

**4. Videos found only in page data.**
- **Sources read:** `og:video` / `og:video:url` / `og:video:secure_url` / `twitter:player:stream`, schema.org `VideoObject` `contentUrl` in JSON-LD (including `@graph` and nesting) and microdata (`itemprop="contentUrl"`).
- **How they're handled:** video files become Direct entries, with title, thumbnail and size from the same data. `.m3u8`/`.mpd` links become streams. Player-page links (`embedUrl`, `text/html`) are ignored.

**5. Subtitles.**
- **What's saved:** when an HLS stream (`EXT-X-MEDIA TYPE=SUBTITLES`) or a DASH manifest (`text/vtt` adaptation sets) carries WebVTT subtitles, each language is saved next to the video, for example `…_720p.en.vtt`.
- **Segmented subtitles** are joined into one file, with repeated cues removed.
- **Settings:** **Save subtitles** turns this off.
- **Not supported:** TTML/IMSC subtitles and captions embedded in the video stream (CEA-608).

## Why something can't be downloaded (1.3.1)

Anything that can't be saved explains why, in the same words in the popup (a short label plus an explanation on the row, and as the tooltip of the greyed Download button), on the hover button (greyed, with the explanation as its tooltip) and in error toasts. The wording lives in `utils/reasons.js`.

| Situation | What it says |
|---|---|
| DRM (EME, SAMPLE-AES/FairPlay/Widevine/PlayReady keys, DASH `ContentProtection`) | **Protected (DRM)**: the video is encrypted and can only play in the site's own player. Named services (Netflix, Prime Video, Disney+, Hotstar, Hulu, Max, Peacock, Paramount+, Apple TV+, Crunchyroll, Spotify, JioCinema, ZEE5, SonyLIV) are named. |
| YouTube | **Not supported on YouTube**: it scrambles its video addresses, Media Grabber doesn't work around that, and how to get your own uploads (YouTube Studio). |
| A streamed player with no stream seen | **No downloadable stream found**: play it for a few seconds and reopen; otherwise the site's delivery can't be saved. |
| A streamed player whose stream is listed | **Download its stream**: use its stream entry or the button on the video. |
| Live HLS/DASH | **Live stream**: no fixed end, so it can't be saved as one file. |
| Playlist can't be read | **Couldn't read the stream**, with the cause: 401/403 (expired link or sign-in needed), 404/410, server error, timeout, or not actually a playlist. |
| Still reading the playlist | **Reading stream…**: try again in a moment. |
| A download fails part-way | A plain explanation of Chrome's error: blocked by the site, file gone, connection dropped, disk full, download folder not writable, file name too long, antivirus, and so on. |

Site rules only apply to videos that are already streamed or protected. Ordinary files and images on those sites download as usual.

## Hover button (Phase 2, spec §3.5)

Rest the cursor on an image that's at least 200 × 200 px on screen, or on any video. After 300 ms a download badge appears in its top-right corner:
- **Clicking the badge** saves the best quality.
- **The ▾ arrow next to it** opens a quality menu, which also has **Hide button on this site**.

The button sits in a closed Shadow DOM, so site CSS can't reach it. Clicks on it never reach the page's own handlers, such as lightboxes and players. The button finds media under overlays (e.g. player controls) by looking through the stack of elements under the cursor. On protected or streamed videos the badge turns grey and explains why it won't download.

## Popup

- **Tabs:** Images and Videos, each with a count.
- **Image rows:** checkbox, thumbnail, dimensions, file type, a quality dropdown and Download.
- **Video rows:** poster or first-frame thumbnail, a Direct / HLS / DASH / Streamed / Protected badge, size, and a quality dropdown.
- **Filters:** Show (all / logos & icons / without), Min and Max size, file type, and Select all.
- **Download selected** sits at the bottom left.
- **Gear icon:** opens Settings.

## Settings (spec §3.7)

Open them from the popup's gear icon, or with right-click on the extension icon → **Options**:
- Hover button on/off, plus a per-site list (subdomains included).
- Minimum image size to list.
- Filename pattern, with a live example.
- Ask where to save each file.
- Convert HLS to MP4, and max parallel segment downloads (1–10).

Changes save immediately and apply to open tabs straight away.

## Downloads

- **How files are saved:** everything goes through `chrome.downloads.download` with `conflictAction: "uniquify"`.
- **Filenames:** default `{site}_{title}_{quality}.{ext}`, with `\ / : * ? " < > |` removed and a 150-character cap.
- **Bulk downloads:** go into a `{site}_{yyyy-mm-dd}/` subfolder.
- **Unknown file types:** if the URL doesn't show the type, a `HEAD` request finds it.
- **Blocked downloads (401/403):** show "This site blocked the download…".
- **"Ask where to save":** applies to single downloads only.

## Icon

`icons/icon.svg` is the master artwork: a violet → pink → orange badge with an arrow dropping into a tray. The PNG sizes are rendered from it (16 and 32 px use a simplified version without the sparkles). The popup, the settings page and the hover button all use the same artwork.

## Project layout

```
media-grabber/
  manifest.json
  background/service-worker.js   hub: per-tab store (storage.session), network sniffing, size lookups, downloads, HLS job routing
  background/hls.js              m3u8 parsing: variants, segments, byte ranges, keys, subtitles, DRM/live detection (pure, unit-tested)
  background/dash.js             MPD parsing (own small XML reader): qualities, segment lists for all addressing styles (pure, unit-tested)
  offscreen/vtt.js               joins segmented WebVTT into one file (pure, unit-tested)
  content/content-script.js      DOM scanning, MutationObserver, hover button (no imports: not a module)
  offscreen/offscreen.js         HLS engine: parallel fetch + retry, AES-128, ordering, mux.js remux, merge, progress
  offscreen/mp4.js               fragmented-MP4 box tools for merging separate audio (pure, unit-tested)
  lib/mux.min.js                 mux.js 6.3.0 (Apache-2.0), TS → MP4
  content/overlay.css            page-level styles (the hover button styles live in its Shadow DOM)
  popup/                         popup.html / popup.js / popup.css
  options/                       options.html / options.js / options.css
  utils/filename.js              safe filename builder (pure, unit-tested)
  utils/messages.js              shared message type constants
  utils/settings.js              settings defaults + loader
  utils/hash.js                  short stable ids
  icons/                         icon.svg + 16, 32, 48, 128 px PNGs
  test/                          test pages, sample media, dev server (+ HLS test routes), unit tests, fixtures, dev harness
```

## Testing

**Unit tests** (Node 18+, no dependencies):

```bash
npm test
```

**Manual test page:**

```bash
npm run serve
```

Open <http://localhost:8080/test/> and click the toolbar icon. Each section of the page says what to expect:
- **Images:** 10 entries.
- **Videos:** a three-source video (1080p / 720p / 360p with sizes), a plain `<video src>` with a first-frame thumbnail, a MediaSource video marked Streamed, and a simulated DRM video marked Protected.

Hover the large images and the videos to try the button.

**HLS test page:** <http://localhost:8080/test/hls.html>. It needs internet access: the dev server builds short (3-segment) copies of Apple's public sample streams. It loads these cases automatically:
- muxed TS with 4 qualities
- TS video + separate AAC
- fMP4 + separate audio with byte ranges
- AES-128 (local test key)
- a flaky segment that fails twice
- a 403
- live
- DRM

It also has buttons to capture the full Apple streams for the spec's acceptance check. `/test/hls/synthetic.m3u8?n=40&delay=300` is a local, CDN-free stream for timing tests such as cancel and worker restarts.

**Coverage test page:** <http://localhost:8080/test/more.html>. It covers:
- videos in open and closed shadow roots
- `<video src="….m3u8">`
- an `about:blank` iframe filled in by script
- a JSON-LD-only video
- an `og:video` DASH stream
- an extensionless `text/plain` playlist
- DASH SegmentList (with subtitles), SegmentTemplate and SegmentBase/sidx
- DRM and live DASH

The DASH test streams are built by `test/dash-routes.js` from Apple's public fMP4 sample and need internet access.

**Dev harness:** `test/dev-harness.js` runs the real service worker and content script in a normal page with a stand-in `chrome` API. It's handy for checking logic without reloading the extension. Usage is in the file.

**Spec acceptance checks** (the HLS items were checked in Edge with this build; see the next section):

- [ ] Loads unpacked with zero errors on `chrome://extensions`.
- [ ] Wikipedia article: `srcset` images show at least two resolutions, plus "Original".
- [ ] Unsplash photo page: "Original" (the default) saves the full-resolution file.
- [ ] A page with a plain `<video src="…mp4">`: the video downloads and plays in VLC.
- [ ] DRM site (e.g. a Netflix trailer page): entries show "Protected" and nothing downloads.
- [ ] Hover button appears on large images, not on icons, and can be disabled per site.
- [ ] Bulk download saves into `<site>_<date>/`.
- [ ] Apple HLS sample stream: all variants are listed, and the 720p download plays start to end with audio.
- [ ] Cancelling an HLS download stops all network requests within 2 seconds.

**What the automated HLS run verified** (real extension in Edge, on trimmed Apple streams plus the synthetic one):
- **Muxed TS:** saves a valid `.ts`. With **Convert to MP4** on, it saves an MP4 with video and audio tracks that decodes at 960×720 for 29.9 s, with audible stereo.
- **TS video + separate AAC, and fMP4 + separate AAC:** each saves one MP4, 1280×720 for 18 s, with audible stereo audio and frames decoding at the end.
- **AES-128:** decrypts to valid TS.
- **Flaky segment:** finishes after retrying.
- **403:** pauses with the spec's message.
- **Live and DRM:** refused.
- **Cancel:** no further bytes arrive after cancelling.
- **Service worker restart:** stopping the worker mid-download still produces the complete file, all 40 segments in order.

## Compliance

Media Grabber doesn't handle DRM, doesn't interact with a CDM, doesn't extract keys, and doesn't decode site-specific signatures or ciphers. DRM detection only *reads* whether a video uses EME so it can refuse. It sends no analytics and talks to no remote servers. Network requests go only to the media's own origin, and all code ships locally. Download only content you have the right to save.
