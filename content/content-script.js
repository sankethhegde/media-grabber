// Media Grabber — content script.
// Scans the page for images (spec IMG-1 to IMG-8) and videos (VID-1, VID-4),
// reports them to the service worker, and renders the on-page hover download
// button (spec §3.5). Content scripts are not ES modules, so this file must
// not use `import`; the message strings below mirror utils/messages.js.

(() => {
  // Mirrors BUILD in utils/messages.js.
  const BUILD = '1.3.3';

  // The popup may inject this file into a tab that already has a copy. Keep
  // a live copy of this build; replace anything else (an older build, or one
  // orphaned when the extension was reloaded, which no longer gets messages).
  const previous = window.__mediaGrabber;
  try {
    if (previous && previous.build === BUILD && previous.isAlive()) return;
    previous?.shutdown();
  } catch {
    /* the old copy's context is gone */
  }
  // Builds before 1.1.0 left only this flag and no way to stop them.
  document.querySelectorAll('media-grabber-hover').forEach((el) => el.remove());
  window.__mediaGrabber = {
    build: BUILD,
    isAlive: () => alive && Boolean(chrome.runtime?.id),
    shutdown: () => shutdown(),
  };

  const MSG = {
    MEDIA_FOUND: 'MEDIA_FOUND',
    DOWNLOAD: 'DOWNLOAD',
    RESCAN: 'RESCAN',
    FETCH_AS_DATA_URL: 'FETCH_AS_DATA_URL',
    STREAM_FOR_TAB: 'STREAM_FOR_TAB',
  };

  // Mirrors the hover-related defaults in utils/settings.js.
  const DEFAULT_SETTINGS = { hoverButton: true, hoverDisabledSites: [] };
  let settings = { ...DEFAULT_SETTINGS };

  const RESCAN_DEBOUNCE_MS = 500;      // IMG-7
  const RESCAN_MAX_WAIT_MS = 2000;
  // Small images and logos are listed too (the popup's size filters hide them
  // when not wanted); only invisible 1×1 tracking pixels are dropped.
  const MIN_BACKGROUND_SIZE = 8;       // IMG-3 (was 100 px): CSS backgrounds on elements ≥ 8×8
  const MIN_INLINE_SVG = 16;           // inline <svg> drawings ≥ 16×16 on screen
  const MAX_INLINE_SVGS = 300;
  const MAX_PSEUDO_CHECKS = 4000;      // ::before/::after backgrounds
  const ICON_MAX_SHOWN = 64;           // drawn at ≤ 64 px on screen → tagged as an icon
  const MAX_ELEMENTS_FOR_BACKGROUNDS = 8000;
  const MAX_ITEMS = 2000;
  const MAX_DIMENSION_PROBES = 400;
  const MAX_THUMBNAIL_DATA_URL = 40_000; // keep storage.session small

  // url → { w, h } once known (from loaded <img> elements or probes).
  const dimsCache = new Map();
  // url → true while an Image() probe is in flight or has failed.
  const probed = new Set();
  // url → small data: URL thumbnail for blob:/huge data: images.
  const thumbCache = new Map();
  // <img>/<video> element → the URL of its best quality (for the hover button).
  const elementKey = new WeakMap();
  // Videos that fired an "encrypted" event (EME / DRM in use).
  const encryptedVideos = new WeakSet();
  // <video> element → its item id. Two players can share a file, so videos are
  // matched by element rather than by URL.
  const videoItemId = new WeakMap();
  // From the latest scan: quality URL → MediaItem, and id → MediaItem.
  let urlOwner = new Map();
  let itemsById = new Map();

  let lastSignature = '';
  let scanTimer = null;
  let firstScheduledAt = 0;
  let alive = true;

  // ---------------------------------------------------------------- helpers

  function absUrl(raw) {
    if (!raw) return null;
    const s = String(raw).trim();
    if (!s || /^(javascript|about|chrome|chrome-extension):/i.test(s)) return null;
    try {
      return new URL(s, document.baseURI).href;
    } catch {
      return null;
    }
  }

  // 64-bit-ish FNV-1a (two 32-bit lanes) → 16 hex chars. Used for item ids.
  function hash(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
  }

  // IMG-6: a 1×1 image is a tracking pixel or spacer, never a picture.
  function isKnownPixel(url) {
    const d = dimsCache.get(url);
    return Boolean(d && d.w <= 1 && d.h <= 1);
  }

  // Logos: the element or a close ancestor says "logo"/"brand", or it is the
  // home link in the page header. Returns 'logo' or null.
  const LOGO_WORDS = /(^|[\s_\-/.])(logo|logotype|brand|wordmark|site-?mark)([\s_\-/.]|$)/i;
  function logoHint(el) {
    let node = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (!(node instanceof Element)) break;
      const words = [
        node.id,
        typeof node.className === 'string' ? node.className : node.getAttribute('class'),
        node.getAttribute('alt'),
        node.getAttribute('aria-label'),
        node.getAttribute('title'),
        depth === 0 ? node.getAttribute('src') : '',
      ].join(' ');
      if (LOGO_WORDS.test(words)) return 'logo';
    }
    const home = el.closest?.('a[href="/"], a[rel~="home"]');
    return home && el.closest('header, [role="banner"], nav') ? 'logo' : null;
  }

  // ------------------------------------------------- video thumbnails
  // Poster frames and video preview stills belong to videos, not to the
  // Images list, so they are left out of it.

  // Thumbnail CDNs of the big video sites.
  const VIDEO_THUMB_URL =
    /^https?:\/\/(?:[^/]*\.ytimg\.com\/(?:vi|vi_webp|an_webp)\/|img\.youtube\.com\/vi\/|i\.vimeocdn\.com\/video\/|[^/]*\.dmcdn\.net\/|cdn\.jwplayer\.com\/v2\/media\/|[^/]*\.jwpsrv\.com\/thumbs\/)/i;
  // Class/id/tag names players and video grids give their thumbnails.
  const VIDEO_THUMB_NAMES =
    /(?:^|[^a-z])(?:video|player|clip|vid|reel|movie)[-_]?(?:thumb|poster|preview|cover|still|splash|image|img)|(?:thumb|poster|preview|cover)[-_]?(?:video|player|clip)|vjs-poster|jw-preview|plyr__poster|mejs__poster|fp-splash|ytp-|ytd-thumbnail|ytd-moving-thumbnail|ytd-playlist-thumbnail|ytd-video-preview|yt-thumbnail|ytm-media-item/i;
  // Links to a page that plays a video.
  const VIDEO_PAGE_LINK =
    /(?:youtube\.com|youtube-nocookie\.com)\/(?:watch|shorts\/|embed\/|live\/)|youtu\.be\/|vimeo\.com\/(?:\d+|video\/)|dailymotion\.com\/video\/|dai\.ly\/|twitch\.tv\/videos\/|\/(?:watch|video|videos|reel|reels|shorts|clip|clips)(?:[/?#]|$)/i;

  // URLs known to be video thumbnails on this page: <video poster>, and the
  // preview image of a video page (og:image next to og:video, JSON-LD).
  function videoThumbUrls() {
    const out = new Set();
    for (const video of deepQueryAll('video[poster]')) {
      const u = absUrl(video.getAttribute('poster'));
      if (u) out.add(u);
    }
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
    const isVideoPage =
      /^video/i.test(meta('meta[property="og:type"]')) ||
      Boolean(document.querySelector('meta[property^="og:video"], meta[name="twitter:player"], meta[property="twitter:player"]')) ||
      /player/i.test(meta('meta[name="twitter:card"]'));
    if (isVideoPage) {
      for (const el of document.querySelectorAll(
        'meta[property="og:image"], meta[property="og:image:url"], meta[property="og:image:secure_url"], meta[name="twitter:image"], meta[name="twitter:image:src"], meta[property="twitter:image"]',
      )) {
        const u = absUrl(el.getAttribute('content'));
        if (u) out.add(u);
      }
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text = script.textContent || '';
      if (text.length > MAX_JSONLD_BYTES || !/VideoObject/i.test(text)) continue;
      try {
        for (const v of videoObjectsIn(JSON.parse(text), [])) {
          for (const t of [v.thumbnailUrl, v.thumbnail].flat()) {
            const u = absUrl(typeof t === 'string' ? t : t?.url || t?.contentUrl);
            if (u) out.add(u);
          }
        }
      } catch {
        /* not JSON */
      }
    }
    return out;
  }

  // Set at the start of each scan by collectAll().
  let videoThumbs = { urls: new Set(), rects: [] };

  const isVideoThumbUrl = (url) => videoThumbs.urls.has(url) || VIDEO_THUMB_URL.test(url);

  // The element is a video's thumbnail: it sits over a <video>, inside a
  // player or video-thumbnail container, or inside a link to a video page.
  function isVideoThumbElement(el, videoRects = videoThumbs.rects) {
    let node = el;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement || node.getRootNode?.().host) {
      if (!(node instanceof Element)) break;
      const cls = typeof node.className === 'string' ? node.className : node.getAttribute('class') || '';
      if (VIDEO_THUMB_NAMES.test(`${node.localName} ${node.id} ${cls}`)) return true;
    }
    const link = el.closest?.('a[href]');
    if (link && VIDEO_PAGE_LINK.test(link.href)) return true;
    if (videoRects.length) {
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > 0) {
        for (const v of videoRects) {
          const w = Math.min(r.right, v.right) - Math.max(r.left, v.left);
          const h = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
          if (w > 0 && h > 0 && (w * h) / area >= 0.8) return true; // a poster overlay
        }
      }
    }
    return false;
  }

  // Parse a srcset attribute into [{ url, w?, x? }]. URLs may contain commas
  // (e.g. Cloudinary transforms), so this follows the HTML spec's tokenizer
  // rather than a naive split(',').
  function parseSrcset(srcset) {
    const out = [];
    if (!srcset) return out;
    const s = String(srcset);
    let i = 0;
    while (i < s.length) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      const start = i;
      while (i < s.length && !/\s/.test(s[i])) i++;
      let url = s.slice(start, i);
      let descriptor = '';
      if (url.endsWith(',')) {
        url = url.replace(/,+$/, '');
      } else {
        const dStart = i;
        let depth = 0;
        while (i < s.length) {
          const c = s[i];
          if (c === '(') depth++;
          else if (c === ')') depth--;
          else if (c === ',' && depth <= 0) break;
          i++;
        }
        descriptor = s.slice(dStart, i).trim();
        i++;
      }
      const abs = absUrl(url);
      if (!abs) continue;
      const cand = { url: abs };
      const w = descriptor.match(/(\d+)w\b/);
      const x = descriptor.match(/([\d.]+)x\b/);
      if (w) cand.w = parseInt(w[1], 10);
      else if (x) cand.x = parseFloat(x[1]);
      else cand.x = 1;
      out.push(cand);
    }
    return out;
  }

  // Some image CDNs serve a resized copy; the original lives at a predictable
  // URL. These are plain URL rewrites of public files (no signatures/ciphers).
  function originalCandidates(url) {
    const out = [];
    try {
      const u = new URL(url);
      // Wikimedia: /thumb/a/ab/File.jpg/220px-File.jpg → /a/ab/File.jpg
      if (u.hostname === 'upload.wikimedia.org' && u.pathname.includes('/thumb/')) {
        const parts = u.pathname.split('/');
        const idx = parts.indexOf('thumb');
        if (idx >= 0 && parts.length - idx >= 5) {
          const orig = [...parts.slice(0, idx), ...parts.slice(idx + 1, -1)].join('/');
          out.push(`${u.origin}${orig}`);
        }
      }
      // Unsplash: drop the resize/crop parameters to get the full-resolution file.
      if (u.hostname === 'images.unsplash.com' || u.hostname === 'plus.unsplash.com') {
        const resize = ['w', 'h', 'fit', 'crop', 'q', 'dpr', 'auto', 'fm', 'cs', 'ixlib', 'ixid', 'rect', 'max-w', 'max-h'];
        const hadResize = resize.some((k) => u.searchParams.has(k));
        if (hadResize) {
          resize.forEach((k) => u.searchParams.delete(k));
          out.push(u.href);
        }
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  function rememberDims(url, w, h) {
    if (url && w > 0 && h > 0) dimsCache.set(url, { w, h });
  }

  // Load an image off-DOM just to learn its size (for CSS backgrounds and
  // meta images, which have no naturalWidth to read). Mostly cache hits.
  function probeDims(url) {
    if (dimsCache.has(url) || probed.has(url) || probed.size >= MAX_DIMENSION_PROBES) return;
    if (url.startsWith('blob:')) return;
    probed.add(url);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      rememberDims(url, img.naturalWidth, img.naturalHeight);
      scheduleScan();
    };
    img.src = url;
  }

  // Small JPEG thumbnail from an already-loaded <img>. Needed for blob: URLs,
  // which the popup (a different origin) cannot display.
  function canvasThumbnail(img, url) {
    if (thumbCache.has(url)) return thumbCache.get(url);
    let result = null;
    try {
      const scale = Math.min(1, 160 / Math.max(img.naturalWidth, img.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      result = canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      result = null; // cross-origin (tainted) canvas
    }
    thumbCache.set(url, result);
    return result;
  }

  function textOf(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  }

  function titleForImg(img) {
    const fig = img.closest('figure');
    return (
      img.getAttribute('alt')?.trim() ||
      img.getAttribute('title')?.trim() ||
      (fig && textOf(fig.querySelector('figcaption'))) ||
      document.title ||
      ''
    );
  }

  // ------------------------------------------------------ building an entry

  // Turn a list of raw candidates for ONE image into a MediaItem (IMG-5).
  function makeItem({ candidates, title, thumbnailHint, element, category = null }) {
    // Merge duplicate URLs, keeping whatever descriptors/dimensions we know.
    const byUrl = new Map();
    for (const c of candidates) {
      if (!c.url || isKnownPixel(c.url)) continue;
      const prev = byUrl.get(c.url);
      byUrl.set(c.url, prev ? { ...c, ...prev, width: prev.width || c.width, height: prev.height || c.height } : { ...c });
    }
    const list = [...byUrl.values()];
    if (!list.length) return null;

    for (const c of list) {
      const known = dimsCache.get(c.url);
      if (known && !c.width) {
        c.width = known.w;
        c.height = known.h;
      }
    }

    // Rank: originals first, then by pixel width (or descriptor), largest first.
    const score = (c) => (c.original ? 1e9 : 0) + (c.width || c.w || 0) + (c.x || 0);
    list.sort((a, b) => score(b) - score(a));

    const qualities = list.map((c) => {
      let label;
      if (c.original) label = 'Original';
      else if (c.w) label = `${c.w}w`;
      else if (c.x && list.length > 1) label = `${c.x}x`;
      else if (c.label) label = c.label;
      else if (c.width && c.height) label = `${c.width}×${c.height}`;
      else label = 'Default';
      return {
        id: hash(c.url).slice(0, 10),
        label,
        url: c.url,
        width: c.width || null,
        height: c.height || null,
        bandwidth: null,
        sizeBytes: c.url.startsWith('data:') ? Math.round(c.url.length * 0.75) : null,
      };
    });

    // Thumbnail: the version the page already loaded, unless the popup can't
    // display it (blob:) or it is a huge inline data: URL.
    let thumbnail = thumbnailHint || qualities[qualities.length - 1].url;
    if (thumbnail.startsWith('blob:') || (thumbnail.startsWith('data:') && thumbnail.length > MAX_THUMBNAIL_DATA_URL)) {
      thumbnail = element instanceof HTMLImageElement && element.complete ? canvasThumbnail(element, thumbnail) : null;
    }

    return {
      id: hash(qualities[0].url),
      kind: 'image',
      source: 'dom',
      type: 'direct',
      // 'logo' | 'icon' | null — drives the LOGO/ICON badge and the "Show" filter.
      category: category || (element ? logoHint(element) : null),
      pageUrl: location.href,
      title: title || document.title || '',
      thumbnail,
      qualities,
    };
  }

  // ----------------------------------------------------------- shadow DOM

  // #2: many players keep their <video> inside a shadow root. Content scripts
  // may open closed roots too (chrome.dom.openOrClosedShadowRoot).
  const MAX_SHADOW_ROOTS = 500;
  let shadowRoots = [];
  const watchedRoots = new WeakSet();

  function shadowRootOf(el) {
    if (el === hover.host) return null; // our own button
    try {
      return chrome.dom?.openOrClosedShadowRoot?.(el) || el.shadowRoot || null;
    } catch {
      return el.shadowRoot || null;
    }
  }

  // #3: same-origin about:blank / about:srcdoc frames that a page fills in
  // with script. Chrome doesn't always run content scripts in those, so the
  // parent reads them directly (duplicates merge by id in the service worker).
  function aboutFrameDocument(el) {
    if (el.tagName !== 'IFRAME') return null;
    // Decide by the element: after the parent calls document.open(), the
    // frame's own URL becomes the parent's, so it can't be told apart that way.
    const src = (el.getAttribute('src') || '').trim();
    if (src && !/^about:/i.test(src) && !el.hasAttribute('srcdoc')) return null;
    try {
      const doc = el.contentDocument; // null when cross-origin (sandboxed)
      return doc && doc.documentElement ? doc : null;
    } catch {
      return null;
    }
  }

  function findShadowRoots() {
    const roots = [];
    const visit = (scope, depth) => {
      const all = scope.querySelectorAll('*');
      for (let i = 0; i < all.length && roots.length < MAX_SHADOW_ROOTS; i++) {
        const root = shadowRootOf(all[i]) || (depth < 3 ? aboutFrameDocument(all[i]) : null);
        if (root && !roots.includes(root)) {
          roots.push(root);
          visit(root, depth + 1);
        }
      }
    };
    if (document.documentElement) visit(document, 0);
    shadowRoots = roots;
    for (const root of roots) watchRoot(root);
    return roots;
  }

  // Changes and media events inside a shadow root never reach document-level
  // observers/listeners, so each root gets its own.
  function watchRoot(root) {
    if (watchedRoots.has(root)) return;
    watchedRoots.add(root);
    observer.observe(root, OBSERVE_OPTIONS);
    for (const [type, fn, opts] of MEDIA_LISTENERS) root.addEventListener(type, fn, opts);
  }

  /** querySelectorAll across the document and every shadow root. */
  function deepQueryAll(selector) {
    const out = [...document.querySelectorAll(selector)];
    for (const root of shadowRoots) out.push(...root.querySelectorAll(selector));
    return out;
  }

  /** elementsFromPoint that also looks inside shadow roots under the point. */
  function deepElementsFromPoint(x, y) {
    const out = [];
    const seenRoots = new Set();
    const walk = (scope, depth) => {
      for (const el of scope.elementsFromPoint(x, y)) {
        out.push(el);
        const root = depth < 4 ? shadowRootOf(el) : null;
        if (root && !seenRoots.has(root)) {
          seenRoots.add(root);
          walk(root, depth + 1);
        }
      }
    };
    walk(document, 0);
    return out;
  }

  // ------------------------------------------------------------- collectors

  // IMG-1, IMG-2: <img> (currentSrc + srcset) and <picture><source srcset>.
  function collectImgs() {
    const items = [];
    for (const img of deepQueryAll('img')) {
      // IMG-6: tracking pixels. A 1×1 that is only a lazy-load placeholder
      // still counts, via its data-src/srcset candidates below.
      const isPixel =
        (img.complete && img.naturalWidth > 0 && img.naturalWidth <= 1 && img.naturalHeight <= 1) ||
        (img.getAttribute('width') === '1' && img.getAttribute('height') === '1');
      const loaded = img.complete && img.naturalWidth > 0 && !isPixel;
      if (isVideoThumbElement(img)) continue;

      const candidates = [];
      candidates.push(...parseSrcset(img.getAttribute('srcset')));
      // Common lazy-load attributes hold the real image before it is swapped in.
      candidates.push(...parseSrcset(img.getAttribute('data-srcset')));
      for (const attr of ['data-src', 'data-lazy-src', 'data-original']) {
        const u = absUrl(img.getAttribute(attr));
        if (u) candidates.push({ url: u });
      }

      const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
      if (picture) {
        for (const source of picture.querySelectorAll(':scope > source')) {
          candidates.push(...parseSrcset(source.getAttribute('srcset') || source.getAttribute('data-srcset')));
        }
      }

      const current = absUrl(img.currentSrc || img.getAttribute('src'));
      const src = absUrl(img.getAttribute('src'));
      if (isPixel) {
        // Keep only the real candidates (if any); drop the pixel itself.
        for (let i = candidates.length - 1; i >= 0; i--) {
          if (candidates[i].url === current || candidates[i].url === src) candidates.splice(i, 1);
        }
      } else {
        if (current) candidates.push({ url: current });
        if (src && src !== current) candidates.push({ url: src });
      }
      if (!candidates.length) continue;

      // Measured size of what the browser actually loaded. For srcset picks,
      // naturalWidth is density-corrected (a 2x file reports half its pixels,
      // a "800w" file shown at 600px reports 600), so convert back to the
      // file's real pixel size.
      const ratio = loaded ? img.naturalHeight / img.naturalWidth : null;
      const currentCand = candidates.find((c) => c.url === current && (c.w || c.x));
      let fileWidth = null;
      if (loaded && current) {
        fileWidth = currentCand?.w || Math.round(img.naturalWidth * (currentCand?.x || 1));
        const fileHeight = Math.round(fileWidth * ratio);
        rememberDims(current, fileWidth, fileHeight);
        for (const c of candidates) {
          if (c.url === current) {
            c.width = fileWidth;
            c.height = fileHeight;
          }
        }
      }

      // Derive sizes for the other candidates from their descriptors.
      const baseWidth = fileWidth && currentCand?.x ? fileWidth / currentCand.x : fileWidth;
      for (const c of candidates) {
        if (c.width) continue;
        if (c.w) {
          c.width = c.w;
          if (ratio) c.height = Math.round(c.w * ratio);
        } else if (c.x && baseWidth) {
          c.width = Math.round(baseWidth * c.x);
          if (ratio) c.height = Math.round(c.width * ratio);
        }
      }

      // Full-resolution originals for known CDNs.
      const originals = new Set();
      for (const c of candidates) originalCandidates(c.url).forEach((u) => originals.add(u));
      for (const u of originals) candidates.push({ url: u, original: true });

      const item = makeItem({
        candidates,
        title: titleForImg(img),
        thumbnailHint: isPixel ? null : current,
        element: img,
      });
      if (item) {
        elementKey.set(img, item.qualities[0].url);
        items.push(item);
      }
    }
    return items;
  }

  // IMG-3: CSS background-image on visible elements (and their ::before /
  // ::after), down to 8×8 so logos, icons and sprites are included.
  function backgroundUrls(style) {
    const out = [];
    const values = [style.backgroundImage, style.content, style.maskImage || style.webkitMaskImage].filter(
      (v) => v && v !== 'none' && v.includes('url('),
    );
    for (const value of values) {
      const re = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
      let m;
      while ((m = re.exec(value))) {
        const url = absUrl(m[2]);
        if (url) out.push(url);
      }
    }
    return out;
  }

  function collectBackgrounds() {
    const items = [];
    if (!document.body) return items;
    const all = [...document.body.getElementsByTagName('*')];
    for (const root of shadowRoots) all.push(...root.querySelectorAll('*'));
    const limit = Math.min(all.length, MAX_ELEMENTS_FOR_BACKGROUNDS);
    let pseudoChecks = 0;
    // Drawn small on screen = an icon, whatever the file's own size.
    const add = (url, el, shownWidth, shownHeight) => {
      if (isVideoThumbUrl(url) || isVideoThumbElement(el)) return;
      probeDims(url);
      const title = el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el).slice(0, 60) || document.title;
      const shownSmall = shownWidth > 0 && shownHeight > 0 && Math.max(shownWidth, shownHeight) <= ICON_MAX_SHOWN;
      const category = logoHint(el) || (shownSmall ? 'icon' : null);
      const item = makeItem({ candidates: [{ url }], title, thumbnailHint: url, category });
      if (item) items.push(item);
    };
    for (let i = 0; i < limit; i++) {
      const el = all[i];
      // offsetWidth is undefined on SVG elements, so test for "not ≥".
      if (!(el.offsetWidth >= MIN_BACKGROUND_SIZE && el.offsetHeight >= MIN_BACKGROUND_SIZE)) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.opacity === '0') continue;
      for (const url of backgroundUrls(style)) add(url, el, el.offsetWidth, el.offsetHeight);
      if (pseudoChecks < MAX_PSEUDO_CHECKS) {
        pseudoChecks++;
        for (const pseudo of ['::before', '::after']) {
          const ps = getComputedStyle(el, pseudo);
          if (ps.content === 'none' && ps.backgroundImage === 'none') continue;
          for (const url of backgroundUrls(ps)) add(url, el, parseFloat(ps.width), parseFloat(ps.height));
        }
      }
    }
    return items;
  }

  // Inline <svg> drawings — most site logos and icons today. Each is saved as
  // a standalone .svg: <use> references are copied in, and the colour it
  // inherits from the page is fixed on the root so it looks the same.
  function serializeSvg(svg) {
    const clone = svg.cloneNode(true);
    const rect = svg.getBoundingClientRect();
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.round(rect.width)));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.round(rect.height)));
    const style = getComputedStyle(svg);
    clone.style.color = style.color;
    if (!clone.getAttribute('fill') && style.fill && style.fill !== 'rgb(0, 0, 0)') clone.setAttribute('fill', style.fill);
    // <use href="#icon"> pointing elsewhere in the page: bring the target along.
    const root = svg.getRootNode();
    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const copied = new Set();
    for (const use of clone.querySelectorAll('use')) {
      const ref = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
      if (!ref.startsWith('#') || copied.has(ref)) continue;
      const target = (root.getElementById ? root : document).getElementById(ref.slice(1));
      if (target && !clone.querySelector(ref.replace(/([^\w#-])/g, '\\$1'))) {
        defs.append(target.cloneNode(true));
        copied.add(ref);
      }
    }
    if (defs.childNodes.length) clone.prepend(defs);
    const xml = new XMLSerializer().serializeToString(clone);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  }

  function collectInlineSvgs() {
    const items = [];
    for (const svg of deepQueryAll('svg')) {
      if (items.length >= MAX_INLINE_SVGS) break;
      if (svg.parentElement?.closest('svg')) continue; // part of a bigger drawing
      // Only a frame around raster <image>s: those images are listed on their own.
      if (svg.querySelector('image') && !svg.querySelector('path, rect, circle, ellipse, line, polyline, polygon, text, use')) continue;
      const rect = svg.getBoundingClientRect();
      if (rect.width < MIN_INLINE_SVG || rect.height < MIN_INLINE_SVG) continue;
      const style = getComputedStyle(svg);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
      let url;
      try {
        url = serializeSvg(svg);
      } catch {
        continue;
      }
      if (url.length > 2_000_000) continue; // a chart or map, not a picture
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      const titleEl = svg.querySelector('title');
      const category = logoHint(svg) || (width <= ICON_MAX_SHOWN && height <= ICON_MAX_SHOWN ? 'icon' : null);
      const item = makeItem({
        candidates: [{ url, width, height, label: 'SVG (vector)' }],
        title:
          svg.getAttribute('aria-label') || textOf(titleEl) || (category === 'logo' ? `${location.hostname} logo` : '') || document.title,
        thumbnailHint: url.length <= MAX_THUMBNAIL_DATA_URL ? url : null,
        category,
      });
      if (item) items.push(item);
    }
    return items;
  }

  // Favicons and app icons the page declares (<link rel="icon"> and friends).
  function collectPageIcons() {
    const items = [];
    const seen = new Set();
    const add = (url, sizes) => {
      if (!url || seen.has(url)) return;
      seen.add(url);
      const [w, h] = String(sizes || '').split(/x/i).map((n) => parseInt(n, 10));
      if (w > 0 && h > 0 && !dimsCache.has(url)) rememberDims(url, w, h);
      probeDims(url);
      const item = makeItem({
        candidates: [{ url }],
        title: `${document.title || location.hostname} icon`,
        thumbnailHint: url,
        category: 'icon',
      });
      if (item) items.push(item);
    };
    for (const link of document.querySelectorAll('link[rel][href]')) {
      if (/(^|\s)(icon|shortcut|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|fluid-icon)(\s|$)/i.test(link.rel)) {
        add(absUrl(link.getAttribute('href')), link.getAttribute('sizes'));
      }
    }
    add(absUrl(document.querySelector('meta[name="msapplication-TileImage"]')?.content), null);
    // No declared icon: browsers fall back to /favicon.ico. List it only once
    // a probe has shown it exists.
    if (!seen.size && /^https?:$/.test(location.protocol) && window === window.top) {
      const fallback = `${location.origin}/favicon.ico`;
      probeDims(fallback);
      if (dimsCache.has(fallback)) add(fallback, null);
    }
    return items;
  }

  // Images that aren't <img> or CSS: SVG <image>, <input type="image">,
  // and <object>/<embed> showing an image file.
  function collectOtherImages() {
    const items = [];
    const add = (url, el) => {
      if (!url || isVideoThumbUrl(url) || isVideoThumbElement(el)) return;
      probeDims(url);
      const item = makeItem({ candidates: [{ url }], title: el.getAttribute('aria-label') || el.getAttribute('alt') || document.title, thumbnailHint: url, element: el });
      if (item) items.push(item);
    };
    for (const el of deepQueryAll('svg image')) add(absUrl(el.getAttribute('href') || el.getAttribute('xlink:href')), el);
    for (const el of deepQueryAll('input[type="image"]')) add(absUrl(el.getAttribute('src')), el);
    for (const el of deepQueryAll('object[data], embed[src]')) {
      const url = absUrl(el.getAttribute('data') || el.getAttribute('src'));
      const type = el.getAttribute('type') || '';
      if (/^image\//i.test(type) || /\.(svg|png|jpe?g|gif|webp|avif)(?:$|[?#])/i.test(url || '')) add(url, el);
    }
    return items;
  }

  // IMG-4: og:image and twitter:image meta tags.
  function collectMetaImages() {
    const items = [];
    const selectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:url"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[name="twitter:image:src"]',
      'meta[property="twitter:image"]',
    ].join(',');
    const ogW = parseInt(document.querySelector('meta[property="og:image:width"]')?.content, 10);
    const ogH = parseInt(document.querySelector('meta[property="og:image:height"]')?.content, 10);
    for (const meta of document.querySelectorAll(selectors)) {
      const url = absUrl(meta.getAttribute('content'));
      if (!url) continue;
      const isOg = (meta.getAttribute('property') || '').startsWith('og:');
      if (isOg && ogW > 0 && ogH > 0 && !dimsCache.has(url)) rememberDims(url, ogW, ogH);
      probeDims(url);
      const candidates = [{ url }, ...originalCandidates(url).map((u) => ({ url: u, original: true }))];
      const item = makeItem({ candidates, title: document.title, thumbnailHint: url });
      if (item) items.push(item);
    }
    return items;
  }

  // VID-1: quality label from the attributes players commonly use.
  function qualityLabelFrom(el) {
    // <source title="720p"> is a common convention; on <video> title is the video's name.
    const attrs = ['label', 'res', 'size', 'data-quality', 'data-res', 'data-label', 'quality'];
    if (el.tagName === 'SOURCE') attrs.push('title');
    for (const attr of attrs) {
      const v = el.getAttribute(attr)?.trim();
      if (!v) continue;
      return /^\d{3,4}$/.test(v) ? `${v}p` : v.slice(0, 24);
    }
    return null;
  }

  function heightFromLabel(label) {
    if (!label) return null;
    const m = String(label).match(/(\d{3,4})\s*p\b/i) || String(label).match(/^(\d{3,4})$/);
    if (m) return parseInt(m[1], 10);
    if (/\b(4k|uhd)\b/i.test(label)) return 2160;
    if (/full\s*hd|fhd/i.test(label)) return 1080;
    if (/\bhd\b/i.test(label)) return 720;
    if (/\bsd\b/i.test(label)) return 480;
    return null;
  }

  // First-frame thumbnail when there is no poster. Fails quietly on
  // cross-origin video (the canvas would be tainted).
  function videoFrameThumbnail(video, key) {
    if (thumbCache.has(key)) return thumbCache.get(key);
    if (video.readyState < 2 || !video.videoWidth) return null;
    let result = null;
    try {
      const scale = Math.min(1, 160 / Math.max(video.videoWidth, video.videoHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      result = canvas.toDataURL('image/jpeg', 0.7);
    } catch {
      result = null;
    }
    thumbCache.set(key, result);
    return result;
  }

  // A URL (plus optional MIME type) that is a stream manifest, not a file.
  function streamTypeOf(url, mime = '') {
    const m = String(mime || '').toLowerCase();
    let path = '';
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      return null;
    }
    if (path.endsWith('.m3u8') || m.includes('mpegurl')) return 'hls';
    if (path.endsWith('.mpd') || m.includes('dash+xml')) return 'dash';
    return null;
  }

  // Streams found in this scan (page data, <video src="x.m3u8">). The
  // service worker reads them like playlists it saw on the network.
  let scanStreams = [];
  function addStream(url, type) {
    if (url && type && /^https?:/i.test(url) && !scanStreams.some((s) => s.url === url)) scanStreams.push({ url, type });
  }

  // VID-1 (<video src>, <source src>) and VID-4 (blob: = MediaSource stream).
  function collectVideos() {
    const items = [];
    for (const video of deepQueryAll('video')) {
      const candidates = [];
      const seen = new Set();
      let hasStream = false;
      const add = (url, label, mime) => {
        if (!url || seen.has(url)) return;
        seen.add(url);
        // Chrome plays HLS natively now, so <video src="x.m3u8"> happens.
        const streamType = streamTypeOf(url, mime);
        if (streamType) {
          addStream(url, streamType);
          hasStream = true;
          return;
        }
        candidates.push({ url, label, mime: mime || null });
      };
      add(absUrl(video.getAttribute('src')), qualityLabelFrom(video), video.getAttribute('type'));
      for (const source of video.querySelectorAll('source')) {
        add(absUrl(source.getAttribute('src')), qualityLabelFrom(source), source.getAttribute('type'));
      }
      const current = video.currentSrc ? absUrl(video.currentSrc) : null;
      add(current, null, null);
      if (!candidates.length && hasStream && current) candidates.push({ url: current, label: null, mime: null });
      if (!candidates.length) continue;

      const isProtected = encryptedVideos.has(video) || Boolean(video.mediaKeys);
      const direct = hasStream ? [] : candidates.filter((c) => !c.url.startsWith('blob:'));
      const isStreamed = !direct.length || (current && current.startsWith('blob:'));
      const type = isProtected ? 'protected' : isStreamed ? 'streamed' : 'direct';
      const list = type === 'direct' ? direct : candidates;

      const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9;
      const qualities = list.map((c) => {
        let width = null;
        let height = heightFromLabel(c.label);
        if (c.url === current && video.videoWidth) {
          width = video.videoWidth;
          height = video.videoHeight;
        } else if (height) {
          width = Math.round(height * aspect);
        }
        return {
          id: hash(c.url).slice(0, 10),
          label: c.label || (height ? `${height}p` : 'Default'),
          url: c.url,
          width,
          height,
          bandwidth: null,
          sizeBytes: null,
          mime: c.mime,
        };
      });
      qualities.sort((a, b) => (b.height || 0) - (a.height || 0));

      const poster = absUrl(video.getAttribute('poster'));
      // Two players with the same file and state are one entry; if one of
      // them is protected (or streamed) they stay separate.
      const urls = qualities.map((q) => q.url).join('\n');
      const twin = items.find((it) => it.type === type && it.qualities.map((q) => q.url).join('\n') === urls);
      if (twin) {
        videoItemId.set(video, twin.id);
        continue;
      }
      let id = hash(`video:${qualities[0].url}`);
      while (items.some((it) => it.id === id)) id = hash(`${id}+`);
      videoItemId.set(video, id);
      items.push({
        id,
        kind: 'video',
        source: 'dom',
        type,
        pageUrl: location.href,
        title: video.getAttribute('title') || video.getAttribute('aria-label') || document.title || '',
        thumbnail: poster || videoFrameThumbnail(video, qualities[0].url),
        qualities,
      });
      elementKey.set(video, qualities[0].url);
    }
    return items;
  }

  // #4: videos named only in page data — og:video meta tags, schema.org
  // VideoObject (JSON-LD or microdata). Files become entries; .m3u8/.mpd
  // become streams. Player pages (embedUrl, text/html) are skipped.
  const VIDEO_FILE = /\.(mp4|webm|mov|m4v|ogv)(?:$|[?#])/i;
  const MAX_JSONLD_BYTES = 500_000;

  function videoObjectsIn(node, out, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 8 || out.length > 50) return out;
    if (Array.isArray(node)) {
      node.forEach((n) => videoObjectsIn(n, out, depth + 1));
      return out;
    }
    const types = [].concat(node['@type'] || []).map(String);
    if (types.some((t) => /VideoObject$/i.test(t))) out.push(node);
    for (const value of Object.values(node)) if (value && typeof value === 'object') videoObjectsIn(value, out, depth + 1);
    return out;
  }

  const firstString = (v) => (Array.isArray(v) ? v.map(firstString).find(Boolean) : typeof v === 'string' ? v : v?.url || v?.contentUrl || null);

  function collectPageDataVideos(knownUrls) {
    const found = []; // { url, mime, title, thumbnail, width, height }
    const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || null;

    const ogTitle = meta('meta[property="og:title"]');
    const ogImage = absUrl(meta('meta[property="og:image"]'));
    const ogType = meta('meta[property="og:video:type"]') || '';
    const ogW = parseInt(meta('meta[property="og:video:width"]'), 10) || null;
    const ogH = parseInt(meta('meta[property="og:video:height"]'), 10) || null;
    const ogSelectors = [
      'meta[property="og:video"]',
      'meta[property="og:video:url"]',
      'meta[property="og:video:secure_url"]',
      'meta[name="twitter:player:stream"]',
      'meta[property="twitter:player:stream"]',
    ];
    for (const sel of ogSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        found.push({ url: absUrl(el.getAttribute('content')), mime: ogType, title: ogTitle, thumbnail: ogImage, width: ogW, height: ogH });
      }
    }

    for (const el of document.querySelectorAll('[itemprop="contentUrl"]')) {
      const scope = el.closest('[itemscope]');
      if (scope && !/VideoObject/i.test(scope.getAttribute('itemtype') || '')) continue;
      found.push({ url: absUrl(el.getAttribute('content') || el.getAttribute('href') || el.getAttribute('src')), mime: '' });
    }

    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      const text = script.textContent || '';
      if (text.length > MAX_JSONLD_BYTES || !/VideoObject/i.test(text)) continue;
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      for (const v of videoObjectsIn(data, [])) {
        found.push({
          url: absUrl(firstString(v.contentUrl)),
          mime: v.encodingFormat || '',
          title: firstString(v.name),
          thumbnail: absUrl(firstString(v.thumbnailUrl) || firstString(v.thumbnail)),
          width: parseInt(firstString(v.width), 10) || null,
          height: parseInt(firstString(v.height), 10) || null,
        });
      }
    }

    const items = [];
    for (const f of found) {
      if (!f.url || knownUrls.has(f.url)) continue;
      const streamType = streamTypeOf(f.url, f.mime);
      if (streamType) {
        addStream(f.url, streamType);
        continue;
      }
      const isFile = VIDEO_FILE.test(f.url) || /^video\//i.test(f.mime || '');
      if (!isFile) continue; // a player page, not a file
      knownUrls.add(f.url);
      const height = f.height || null;
      items.push({
        id: hash(`pagedata:${f.url}`),
        kind: 'video',
        source: 'dom',
        type: 'direct',
        pageUrl: location.href,
        title: f.title || document.title || '',
        thumbnail: f.thumbnail || null,
        qualities: [
          {
            id: hash(f.url).slice(0, 10),
            label: height ? `${height}p` : 'Default',
            url: f.url,
            width: f.width || null,
            height,
            bandwidth: null,
            sizeBytes: null,
            mime: /^video\//i.test(f.mime || '') ? f.mime : null,
          },
        ],
      });
    }
    return items;
  }

  // Merge entries that share any URL (IMG-5, IMG-6 duplicates): e.g. the
  // og:image is usually also an <img> on the page.
  function mergeItems(items) {
    const result = [];
    const owner = new Map(); // url → item
    for (const item of items) {
      const existing = item.qualities.map((q) => owner.get(q.url)).find(Boolean);
      if (!existing) {
        result.push(item);
        item.qualities.forEach((q) => owner.set(q.url, item));
        continue;
      }
      for (const q of item.qualities) {
        if (!owner.has(q.url)) {
          existing.qualities.push(q);
          owner.set(q.url, existing);
        }
      }
      const score = (q) => (q.label === 'Original' ? 1e9 : 0) + (q.width || 0);
      existing.qualities.sort((a, b) => score(b) - score(a));
      if (!existing.thumbnail) existing.thumbnail = item.thumbnail;
    }
    return result.slice(0, MAX_ITEMS);
  }

  // ------------------------------------------------------------------- scan

  function collectAll() {
    scanStreams = [];
    findShadowRoots();
    videoThumbs = {
      urls: videoThumbUrls(),
      rects: deepQueryAll('video')
        .map((v) => v.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0),
    };
    // Video posters and preview stills are not listed as images.
    const images = mergeItems([
      ...collectImgs(),
      ...collectBackgrounds(),
      ...collectMetaImages(),
      ...collectInlineSvgs(),
      ...collectPageIcons(),
      ...collectOtherImages(),
    ]).filter((item) => !item.qualities.some((q) => isVideoThumbUrl(q.url)));
    const videos = collectVideos();
    const known = new Set(videos.flatMap((v) => v.qualities.map((q) => q.url)));
    return [...images, ...videos, ...collectPageDataVideos(known)];
  }

  async function scan(force = false) {
    if (!alive) return 0;
    let items;
    try {
      items = collectAll();
    } catch (err) {
      console.warn('[Media Grabber] scan failed', err);
      return 0;
    }
    urlOwner = new Map();
    itemsById = new Map(items.map((it) => [it.id, it]));
    for (const item of items) {
      if (item.kind !== 'image') continue;
      for (const q of item.qualities) if (!urlOwner.has(q.url)) urlOwner.set(q.url, item);
    }
    // A video can turn protected after the button appeared (late "encrypted").
    if (hover.target && hover.main) {
      hover.main.classList.toggle('blocked', Boolean(currentReason()));
    }

    // Only message the service worker when something changed.
    const signature =
      location.href +
      '|' +
      items
        .map((it) => it.id + it.type + ':' + it.qualities.map((q) => `${q.width || 0}x${q.height || 0}`).join(',') + (it.thumbnail ? 't' : ''))
        .join(';') +
      '|' +
      scanStreams.map((s) => s.url).join(';');
    if (!force && signature === lastSignature) return items.length;
    lastSignature = signature;
    try {
      await chrome.runtime.sendMessage({
        type: MSG.MEDIA_FOUND,
        items,
        streams: scanStreams,
        pageUrl: location.href,
        pageTitle: document.title,
      });
    } catch (err) {
      // "Extension context invalidated": the extension was reloaded. Stop.
      if (!chrome.runtime?.id) shutdown();
    }
    return items.length;
  }

  // Debounce, but never wait longer than RESCAN_MAX_WAIT_MS: pages that
  // animate constantly would otherwise keep pushing the scan back forever.
  function scheduleScan() {
    if (!alive) return;
    const now = Date.now();
    if (scanTimer && now - firstScheduledAt > RESCAN_MAX_WAIT_MS) return;
    if (!scanTimer) firstScheduledAt = now;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, RESCAN_DEBOUNCE_MS);
  }

  // ---------------------------------------------------------- IMG-8 support

  // The popup and service worker cannot read this page's blob: URLs, so the
  // content script turns them into data: URLs for chrome.downloads.
  async function fetchAsDataUrl(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, mime: blob.type };
  }

  // ------------------------------------------------- hover button (§3.5)

  const HOVER_DELAY_MS = 300;
  const HOVER_MIN_IMAGE = 200; // px, rendered size
  const HOVER_STACK_DEPTH = 8; // how deep under the cursor to look for media

  // Same artwork as icons/icon.svg, trimmed for a 34 px button.
  const ICON_SVG = `
    <svg viewBox="0 0 128 128" aria-hidden="true">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#6d28d9"/><stop offset=".5" stop-color="#db2777"/><stop offset="1" stop-color="#f97316"/>
        </linearGradient>
        <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#fff" stop-opacity=".4"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="120" height="120" rx="32" fill="url(#bg)"/>
      <path d="M4 36C4 18 18 4 36 4H92C110 4 124 18 124 36V50C88 64 40 64 4 50Z" fill="url(#gloss)"/>
      <g class="glyph" fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
        <path d="M64 26V78" stroke-width="15"/><path d="M41 57L64 80L87 57" stroke-width="15"/>
        <path d="M31 84V94C31 100 35 104 41 104H87C93 104 97 100 97 94V84" stroke-width="11"/>
      </g>
      <path d="M101 17Q103 27 113 29Q103 31 101 41Q99 31 89 29Q99 27 101 17Z" fill="#fff" opacity=".95"/>
    </svg>`;

  const HOVER_CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; display: none; align-items: stretch; gap: 0;
      pointer-events: auto; font: 500 12px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      filter: drop-shadow(0 4px 10px rgba(30, 0, 60, .35));
      animation: pop .16s ease-out;
    }
    .wrap.show { display: flex; }
    @keyframes pop { from { transform: scale(.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    button { all: unset; cursor: pointer; box-sizing: border-box; }
    .main { width: 34px; height: 34px; display: block; transition: transform .12s; }
    .main:hover { transform: scale(1.08); }
    .main:active { transform: scale(.95); }
    .main svg { width: 100%; height: 100%; display: block; }
    .main.busy svg { animation: pulse .8s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .6; } }
    .main.blocked { filter: grayscale(1); opacity: .8; cursor: not-allowed; }
    .more {
      width: 18px; margin-left: -6px; padding-left: 6px; border-radius: 0 9px 9px 0;
      background: rgba(20, 16, 32, .82); color: #fff; display: flex; align-items: center; justify-content: center;
    }
    .more:hover { background: rgba(20, 16, 32, .95); }
    .more svg { width: 10px; height: 10px; }
    .badge {
      position: absolute; right: -4px; bottom: -4px; width: 16px; height: 16px; border-radius: 50%;
      display: none; align-items: center; justify-content: center; color: #fff; font-size: 11px; font-weight: 700;
    }
    .badge.ok { display: flex; background: #16a34a; }
    .badge.err { display: flex; background: #dc2626; }
    .menu {
      position: absolute; top: 40px; right: 0; min-width: 190px; max-height: 260px; overflow: auto;
      background: #1c1a24; color: #f4f2f8; border-radius: 10px; padding: 4px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .35); display: none;
    }
    .menu.open { display: block; }
    .menu button { display: block; width: 100%; padding: 7px 10px; border-radius: 6px; white-space: nowrap; }
    .menu button:hover, .menu button:focus-visible { background: rgba(255, 255, 255, .1); }
    .menu .dim { color: #a7a2b5; margin-left: 6px; }
    .menu hr { border: 0; border-top: 1px solid rgba(255, 255, 255, .12); margin: 4px 2px; }
    .menu .note { padding: 7px 10px; color: #c9c4d6; white-space: normal; max-width: 220px; }
    .tip {
      position: absolute; top: 40px; right: 0; background: #1c1a24; color: #f4f2f8; padding: 7px 10px;
      border-radius: 6px; width: max-content; max-width: 280px; white-space: normal; line-height: 1.4; display: none;
    }
    .tip.show { display: block; }
  `;

  const hover = {
    host: null,
    wrap: null,
    main: null,
    more: null,
    menu: null,
    badge: null,
    tip: null,
    target: null, // element the button belongs to
    pending: null, // element waiting out the delay
    timer: null,
    menuOpen: false,
    pointer: { x: -1, y: -1 },
    frame: 0,
  };

  function topHostname() {
    // In an iframe, per-site settings should follow the tab's site.
    const origins = location.ancestorOrigins;
    try {
      if (origins && origins.length) return new URL(origins[origins.length - 1]).hostname;
    } catch {
      /* fall through */
    }
    return location.hostname;
  }

  function normaliseSite(s) {
    return String(s || '').trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  }

  function siteMatches(hostname, list) {
    const host = normaliseSite(hostname);
    return (list || []).some((entry) => {
      const site = normaliseSite(entry);
      return site && (host === site || host.endsWith(`.${site}`));
    });
  }

  function hoverAllowed() {
    return (
      settings.hoverButton !== false &&
      !siteMatches(location.hostname, settings.hoverDisabledSites) &&
      !siteMatches(topHostname(), settings.hoverDisabledSites)
    );
  }

  function ensureHoverUi() {
    if (hover.host) return;
    const host = document.createElement('media-grabber-hover');
    host.setAttribute(
      'style',
      'all: initial !important; position: fixed !important; top: 0 !important; left: 0 !important; ' +
        'width: 0 !important; height: 0 !important; z-index: 2147483647 !important; pointer-events: none !important;',
    );
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>${HOVER_CSS}</style>
      <div class="wrap" part="wrap">
        <button class="main" title="Download (best quality)" aria-label="Download (best quality)">${ICON_SVG}</button>
        <button class="more" title="Choose quality" aria-label="Choose quality">
          <svg viewBox="0 0 10 10"><path d="M1.5 3.5L5 7L8.5 3.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="badge"></span>
        <div class="menu" role="menu"></div>
        <div class="tip"></div>
      </div>`;
    hover.host = host;
    hover.wrap = root.querySelector('.wrap');
    hover.main = root.querySelector('.main');
    hover.more = root.querySelector('.more');
    hover.menu = root.querySelector('.menu');
    hover.badge = root.querySelector('.badge');
    hover.tip = root.querySelector('.tip');

    // Keep the site's own handlers (lightboxes, players) from seeing our clicks.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu']) {
      hover.wrap.addEventListener(type, (e) => e.stopPropagation());
    }
    hover.main.addEventListener('click', (e) => {
      e.preventDefault();
      hoverDownload(null);
    });
    hover.more.addEventListener('click', (e) => {
      e.preventDefault();
      if (hover.menuOpen) closeMenu();
      else openMenu();
    });
    hover.main.addEventListener('mouseenter', () => showTip());
    hover.main.addEventListener('mouseleave', () => hover.tip.classList.remove('show'));
    (document.documentElement || document.body).appendChild(host);
  }

  function itemForElement(el) {
    if (el instanceof HTMLVideoElement) return itemsById.get(videoItemId.get(el)) || null;
    const key = elementKey.get(el);
    return key ? urlOwner.get(key) || null : null;
  }

  // Why a video can't be saved. Mirrors SITE_RULES and REASONS.drm in
  // utils/reasons.js (content scripts can't import modules) — keep in sync.
  const DRM_SERVICES = [
    ['netflix.com', 'Netflix'], ['primevideo.com', 'Prime Video'], ['disneyplus.com', 'Disney+'],
    ['hotstar.com', 'Disney+ Hotstar'], ['hulu.com', 'Hulu'], ['max.com', 'Max'], ['hbomax.com', 'HBO Max'],
    ['peacocktv.com', 'Peacock'], ['paramountplus.com', 'Paramount+'], ['tv.apple.com', 'Apple TV+'],
    ['crunchyroll.com', 'Crunchyroll'], ['spotify.com', 'Spotify'], ['jiocinema.com', 'JioCinema'],
    ['zee5.com', 'ZEE5'], ['sonyliv.com', 'SonyLIV'],
  ];
  const DRM_REASON = {
    short: 'Protected (DRM)',
    detail: 'This video is encrypted with DRM (copy protection), so it can only be played in the site’s own player and can’t be saved.',
  };
  const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);

  function siteReason() {
    const host = topHostname().toLowerCase();
    if (['youtube.com', 'youtube-nocookie.com', 'youtu.be'].some((d) => hostIs(host, d))) {
      return {
        short: 'Not supported on YouTube',
        detail:
          'YouTube scrambles its video addresses so they only play in its own player, and Media Grabber doesn’t work ' +
          'around that. For videos you uploaded yourself, use YouTube Studio → Content → ⋮ → Download.',
      };
    }
    const service = DRM_SERVICES.find(([d]) => hostIs(host, d));
    return service
      ? { short: 'Protected (DRM)', detail: `${service[1]} protects its videos with DRM (copy protection), so they can only be played in its own player and can’t be saved.` }
      : null;
  }

  /** { short, detail } when this element's video can't be saved, else null. */
  function blockedReason(item) {
    if (!item) return null;
    if (item.type === 'protected') return siteReason() || DRM_REASON;
    if (item.type === 'streamed') return siteReason();
    return null;
  }

  // #3: a "Streamed" (MediaSource) video downloads through the HLS/DASH
  // stream the page is playing, which the service worker has seen. If there
  // is none it can save, the answer says why.
  async function downloadableItemFor(item) {
    if (item?.type !== 'streamed') return { item };
    try {
      const res = await chrome.runtime.sendMessage({ type: MSG.STREAM_FOR_TAB });
      if (res?.item) return { item: res.item };
      return { item: null, reason: { short: res?.short || 'Can’t download', detail: res?.reason || 'No downloadable stream was found for this video.' } };
    } catch {
      if (!chrome.runtime?.id) shutdown();
      return { item: null, reason: { short: 'Reload needed', detail: 'Media Grabber was updated. Reload the page and try again.' } };
    }
  }

  // The reason for the element under the button: local rules first, then what
  // the service worker said about its stream (filled in by showHover).
  const currentReason = () => blockedReason(itemForElement(hover.target)) || hover.streamReason || null;

  function showTip() {
    const reason = currentReason();
    if (!reason) return;
    hover.tip.textContent = `${reason.short}. ${reason.detail}`;
    hover.tip.classList.add('show');
  }

  function isHoverable(el) {
    if (el instanceof HTMLVideoElement) {
      const r = el.getBoundingClientRect();
      return r.width >= 80 && r.height >= 60;
    }
    if (el instanceof HTMLImageElement) {
      const r = el.getBoundingClientRect();
      return r.width >= HOVER_MIN_IMAGE && r.height >= HOVER_MIN_IMAGE;
    }
    return false;
  }

  function positionHover() {
    const el = hover.target;
    if (!el || !el.isConnected) return hideHover();
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return hideHover();
    const width = hover.wrap.offsetWidth || 46;
    const top = Math.max(r.top, 0) + 8;
    const left = Math.min(r.right, innerWidth) - width - 8;
    hover.wrap.style.top = `${Math.round(top)}px`;
    hover.wrap.style.left = `${Math.round(Math.max(left, r.left + 4, 4))}px`;
  }

  function showHover(el) {
    ensureHoverUi();
    if (!hover.host.isConnected) (document.documentElement || document.body).appendChild(hover.host);
    hover.target = el;
    hover.streamReason = null;
    const item = itemForElement(el);
    hover.main.classList.toggle('blocked', Boolean(blockedReason(item)));
    hover.badge.className = 'badge';
    hover.wrap.classList.add('show');
    positionHover();
    // A streamed video: find out now whether its stream can be saved, so the
    // button is greyed with the reason before anyone clicks.
    if (item?.type === 'streamed' && !blockedReason(item)) {
      downloadableItemFor(item).then(({ reason }) => {
        if (hover.target !== el || !reason) return;
        hover.streamReason = reason;
        hover.main.classList.add('blocked');
      });
    }
  }

  function hideHover() {
    clearTimeout(hover.timer);
    hover.pending = null;
    hover.target = null;
    if (!hover.wrap) return;
    closeMenu();
    hover.wrap.classList.remove('show');
    hover.tip.classList.remove('show');
  }

  // Runs at most once per animation frame while the mouse moves.
  function evaluateHover() {
    hover.frame = 0;
    if (!alive || !hoverAllowed()) return hideHover();
    if (hover.menuOpen) return;
    const { x, y } = hover.pointer;
    const stack = deepElementsFromPoint(x, y); // sees into shadow roots (#2)
    if (hover.host && stack.includes(hover.host)) return; // over our own button
    const media = stack.slice(0, HOVER_STACK_DEPTH).find(isHoverable) || null;
    if (media === hover.target) return;
    if (media === hover.pending) return;
    if (hover.target) {
      hover.wrap.classList.remove('show');
      hover.target = null;
    }
    clearTimeout(hover.timer);
    hover.pending = media;
    if (!media) return;
    hover.timer = setTimeout(() => {
      if (hover.pending === media) {
        hover.pending = null;
        showHover(media);
      }
    }, HOVER_DELAY_MS);
  }

  function onPointerMove(e) {
    hover.pointer = { x: e.clientX, y: e.clientY };
    if (!hover.frame) hover.frame = requestAnimationFrame(evaluateHover);
  }

  function onScrollOrResize() {
    if (hover.target) positionHover();
  }

  function flash(ok, message) {
    hover.badge.className = `badge ${ok ? 'ok' : 'err'}`;
    hover.badge.textContent = ok ? '✓' : '!';
    hover.main.title = message || (ok ? 'Saved' : 'Download failed');
    if (!ok && message) {
      hover.tip.textContent = message;
      hover.tip.classList.add('show');
    }
    setTimeout(() => {
      if (!hover.badge) return;
      hover.badge.className = 'badge';
      hover.tip.classList.remove('show');
      hover.main.title = 'Download (best quality)';
    }, ok ? 1500 : 4000);
  }

  async function hoverDownload(qualityId) {
    const el = hover.target;
    if (!el) return;
    closeMenu();
    await scan(); // make sure the service worker has this element's entry
    const found = itemForElement(el);
    if (!found) return flash(false, 'Nothing to download here yet. Try again in a moment.');
    const reason = blockedReason(found);
    if (reason) return flash(false, `${reason.short}. ${reason.detail}`);
    hover.main.classList.add('busy');
    const { item, reason: streamReason } = await downloadableItemFor(found);
    if (!item) {
      hover.main.classList.remove('busy');
      hover.streamReason = streamReason;
      return flash(false, `${streamReason.short}. ${streamReason.detail}`);
    }
    try {
      const res = await chrome.runtime.sendMessage({
        type: MSG.DOWNLOAD,
        itemId: item.id,
        qualityId: qualityId || item.qualities[0].id,
      });
      if (!res?.ok) throw new Error(res?.error || 'Download failed');
      flash(true, res.hls ? 'Stream download started — progress is in the Media Grabber popup' : null);
    } catch (err) {
      if (!chrome.runtime?.id) shutdown();
      flash(false, String(err?.message || err));
    } finally {
      hover.main?.classList.remove('busy');
    }
  }

  function addMenuButton(text, dim, onClick) {
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.textContent = text;
    if (dim) {
      const span = document.createElement('span');
      span.className = 'dim';
      span.textContent = dim;
      b.append(span);
    }
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    hover.menu.append(b);
  }

  async function openMenu() {
    const el = hover.target;
    if (!el) return;
    await scan();
    const found = itemForElement(el);
    let reason = blockedReason(found);
    let item = found;
    if (found && !reason) ({ item, reason } = await downloadableItemFor(found));
    hover.menu.replaceChildren();
    if (reason || !item) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = reason ? `${reason.short}. ${reason.detail}` : 'Nothing to download here yet. Try again in a moment.';
      hover.menu.append(note);
    } else {
      for (const q of item.qualities) {
        const dims = q.width && q.height && q.label !== `${q.width}×${q.height}` ? `${q.width}×${q.height}` : '';
        addMenuButton(q.label, dims, () => hoverDownload(q.id));
      }
    }
    hover.menu.append(document.createElement('hr'));
    addMenuButton(`Hide button on ${normaliseSite(topHostname())}`, '', hideOnThisSite);
    hover.menu.classList.add('open');
    hover.menuOpen = true;
  }

  function closeMenu() {
    if (!hover.menu) return;
    hover.menu.classList.remove('open');
    hover.menuOpen = false;
  }

  async function hideOnThisSite() {
    const site = normaliseSite(topHostname());
    hideHover();
    try {
      const { settings: stored } = await chrome.storage.local.get('settings');
      const next = { ...(stored || {}) };
      const list = new Set(next.hoverDisabledSites || []);
      list.add(site);
      next.hoverDisabledSites = [...list];
      await chrome.storage.local.set({ settings: next });
    } catch {
      /* extension reloaded */
    }
  }

  function onDocumentPointerDown(e) {
    // Close the quality menu on any click outside it.
    if (hover.menuOpen && !e.composedPath().includes(hover.host)) closeMenu();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && hover.menuOpen) closeMenu();
  }

  // --------------------------------------------------------------- settings

  function applySettings(stored) {
    settings = { ...DEFAULT_SETTINGS, ...(stored || {}) };
    if (!hoverAllowed()) hideHover();
  }

  function onStorageChanged(changes, area) {
    if (area === 'local' && changes.settings) applySettings(changes.settings.newValue);
  }

  // ------------------------------------------------------------- lifecycle

  const observer = new MutationObserver(scheduleScan);

  function onMessage(msg, _sender, sendResponse) {
    if (msg?.type === MSG.RESCAN) {
      scan(true).then((count) => sendResponse({ ok: true, count, build: BUILD }));
      return true;
    }
    if (msg?.type === MSG.FETCH_AS_DATA_URL) {
      fetchAsDataUrl(msg.url)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    return false;
  }

  // Lazy-loaded images fire "load" when they arrive, and videos learn their
  // size/source on "loadedmetadata". Neither bubbles, so listen in capture.
  function onMediaEvent(e) {
    if (e.target instanceof HTMLImageElement || e.target instanceof HTMLMediaElement) scheduleScan();
  }

  // EME: a video that hits encrypted data is DRM-protected (never downloaded).
  function onEncrypted(e) {
    if (e.target instanceof HTMLMediaElement) {
      encryptedVideos.add(e.target);
      scheduleScan();
    }
  }

  // Also attached to every shadow root found (see watchRoot).
  const MEDIA_LISTENERS = [
    ['load', onMediaEvent, true],
    ['loadedmetadata', onMediaEvent, true],
    ['emptied', onMediaEvent, true],
    ['encrypted', onEncrypted, true],
  ];

  const OBSERVE_OPTIONS = {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'srcset', 'style', 'class', 'data-src', 'data-srcset', 'poster'],
  };

  const DOC_LISTENERS = [
    ...MEDIA_LISTENERS,
    ['mousemove', onPointerMove, { capture: true, passive: true }],
    ['pointerdown', onDocumentPointerDown, true],
    ['keydown', onKeyDown, true],
    ['scroll', onScrollOrResize, { capture: true, passive: true }],
  ];

  function shutdown() {
    alive = false;
    observer.disconnect();
    clearTimeout(scanTimer);
    hideHover();
    hover.host?.remove();
    for (const [type, fn, opts] of DOC_LISTENERS) document.removeEventListener(type, fn, opts);
    for (const root of shadowRoots) for (const [type, fn, opts] of MEDIA_LISTENERS) root.removeEventListener(type, fn, opts);
    window.removeEventListener('resize', onScrollOrResize);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    } catch {
      /* context already gone */
    }
  }

  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  chrome.storage.local
    .get('settings')
    .then((r) => applySettings(r.settings))
    .catch(() => {});

  observer.observe(document.documentElement, OBSERVE_OPTIONS);
  for (const [type, fn, opts] of DOC_LISTENERS) document.addEventListener(type, fn, opts);
  window.addEventListener('resize', onScrollOrResize, { passive: true });

  // First scan when the browser is idle, so it never delays page load.
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 200));
  idle(() => scan(), { timeout: 2000 });
})();
