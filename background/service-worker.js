// Media Grabber — service worker (the hub, spec §4).
// Stores what each frame's content script finds plus media seen in network
// traffic, answers the popup, and saves files through chrome.downloads. HLS
// streams are fetched and merged by the offscreen document; this worker only
// starts jobs and saves the finished blob, so it holds no job state of its own.

import { BUILD, MSG, OFFSCREEN } from '../utils/messages.js';
import { getSettings } from '../utils/settings.js';
import { hash } from '../utils/hash.js';
import { parsePlaylist, qualitiesFromMaster } from './hls.js';
import { parseMpd, qualitiesFromMpd } from './dash.js';
import { downloadErrorMessage, itemBlockReason, siteReason } from '../utils/reasons.js';
import { buildFilename, bulkFolderName, extFromMime, extFromUrl, siteFromUrl } from '../utils/filename.js';

const MAX_ITEMS_PER_FRAME = 2000;
const MAX_NETWORK_ENTRIES = 300; // per tab (spec §5)
const MIN_NETWORK_VIDEO_BYTES = 100 * 1024; // smaller "videos" are almost always stream segments
const HEAD_TIMEOUT_MS = 4000;
const MAX_SIZE_LOOKUPS = 4; // concurrent HEAD requests
const NETWORK_FLUSH_MS = 300;


// ------------------------------------------------------------ per-tab store
// Kept in chrome.storage.session so it survives service-worker restarts.
// Shape: {
//   pageUrl, pageTitle,
//   frames:  { [frameId]: { pageUrl, items: MediaItem[] } },  // from content scripts
//   network: { [key]: NetworkEntry },                          // from webRequest
// }

const tabKey = (tabId) => `tab:${tabId}`;

async function readTab(tabId) {
  const key = tabKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const data = stored[key] || {};
  return { pageUrl: '', pageTitle: '', frames: {}, network: {}, ...data };
}

// Serialise read-modify-write per tab so frames reporting at the same time
// don't overwrite each other.
const tabLocks = new Map();
function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) || Promise.resolve();
  const next = prev.then(fn, fn);
  tabLocks.set(tabId, next.catch(() => {}));
  return next;
}

async function updateTab(tabId, mutate) {
  await withTabLock(tabId, async () => {
    const data = await readTab(tabId);
    mutate(data);
    await chrome.storage.session.set({ [tabKey(tabId)]: data });
  });
}

async function clearTab(tabId) {
  pendingNetwork.delete(tabId);
  sniffed.delete(tabId);
  await withTabLock(tabId, () => chrome.storage.session.remove(tabKey(tabId)));
}

function notifyPopup(message) {
  // The popup may be closed; that's fine.
  chrome.runtime.sendMessage(message).catch(() => {});
}

async function onMediaFound(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const frameId = sender.frameId ?? 0;
  // #4: stream URLs found in the page itself (page data, <video src="x.m3u8">)
  // join the network log as if the player had requested them.
  for (const s of Array.isArray(msg.streams) ? msg.streams.slice(0, 20) : []) {
    if (/^https?:/i.test(s?.url) && (s.type === 'hls' || s.type === 'dash')) {
      recordNetwork({ url: s.url, tabId, frameId, responseHeaders: [] }, s.type, null);
    }
  }
  await updateTab(tabId, (data) => {
    if (frameId === 0) {
      data.pageUrl = msg.pageUrl || sender.tab.url || '';
      data.pageTitle = msg.pageTitle || sender.tab.title || '';
    }
    data.frames[frameId] = {
      pageUrl: msg.pageUrl,
      items: (Array.isArray(msg.items) ? msg.items : []).slice(0, MAX_ITEMS_PER_FRAME),
    };
  });
  notifyPopup({ type: MSG.MEDIA_UPDATED, tabId });
}

// ------------------------------------------------- network sniffing (VID-2)

const RANGE_PARAMS = /^(range|bytes?|bytestart|byteend|start|end)$/i;
const SEGMENT_NAME = /(?:^|[/_.-])(seg|segment|chunk|frag|fragment|part)[-_]?\d+/i;

function header(details, name) {
  const h = details.responseHeaders?.find((x) => x.name.toLowerCase() === name);
  return h?.value || '';
}

// VID-3: byte-range requests for the same file collapse to one key.
function baseKey(url) {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (RANGE_PARAMS.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

// Responses that might be a playlist served without the usual extension or
// content type (common on CDNs and token-signed URLs): worth a quick look.
const SNIFF_TYPES = /^(text\/plain|application\/octet-stream|binary\/octet-stream|application\/xml|text\/xml|application\/json)?$/;
const NOT_A_PLAYLIST = /\.(js|mjs|css|json|html?|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf|wasm|map|txt|xml|vtt|srt|ts|m4s|mp4|webm|mp3|aac)$/;
const PLAYLIST_HINT = /(manifest|playlist|master|index|chunklist|media|video|stream|hls|dash)/;

function classify(url, contentType, requestType) {
  let path = '';
  let query = '';
  try {
    const u = new URL(url);
    path = u.pathname.toLowerCase();
    query = u.search.toLowerCase();
  } catch {
    return null;
  }
  const ct = contentType.toLowerCase().split(';')[0].trim();
  if (path.endsWith('.m3u8') || ct.includes('mpegurl')) return 'hls';
  if (path.endsWith('.mpd') || ct.includes('dash+xml')) return 'dash';
  // Extension hidden in the query string (?format=m3u8, ?file=x.mpd, …).
  if (/(^|[=&/.])m3u8?(\b|$)/.test(query)) return 'hls';
  if (/(^|[=&/.])mpd(\b|$)/.test(query) && !NOT_A_PLAYLIST.test(path)) return 'dash';
  // Stream pieces and audio are never listed on their own.
  if (/\.(ts|m4s|m4a|m4f|aac|mp3|vtt|key)$/.test(path) || ct.includes('mp2t') || ct.startsWith('audio/')) return null;
  const isVideo = ct.startsWith('video/') || /\.(mp4|webm|mov|m4v)$/.test(path);
  if (isVideo) return SEGMENT_NAME.test(path) ? null : 'direct';
  // #3: maybe a playlist with no extension or a generic content type.
  if (requestType === 'xmlhttprequest' && SNIFF_TYPES.test(ct) && !NOT_A_PLAYLIST.test(path) && PLAYLIST_HINT.test(path + query)) {
    return 'sniff';
  }
  return null;
}

// Peek at the first bytes of a candidate to see whether it is a playlist.
const SNIFF_LIMIT_PER_TAB = 40;
const sniffed = new Map(); // tabId → Set of urls already checked

async function sniffPlaylist(details) {
  const seen = sniffed.get(details.tabId) || new Set();
  sniffed.set(details.tabId, seen);
  const key = baseKey(details.url);
  if (seen.has(key) || seen.size >= SNIFF_LIMIT_PER_TAB) return;
  seen.add(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(details.url, { credentials: 'include', headers: { Range: 'bytes=0-1023' }, signal: controller.signal });
    if (!res.ok) return;
    const head = (await res.text()).slice(0, 1024).replace(/^﻿/, '').trimStart();
    const type = head.startsWith('#EXTM3U') ? 'hls' : /<MPD[\s>]/.test(head) ? 'dash' : null;
    if (type) recordNetwork(details, type, null);
  } catch {
    /* not reachable: ignore */
  } finally {
    clearTimeout(timer);
  }
}

function totalSize(details) {
  const range = header(details, 'content-range').match(/\/(\d+)\s*$/);
  if (range) return Number(range[1]);
  const length = Number(header(details, 'content-length'));
  return details.statusCode === 200 && length > 0 ? length : null;
}

// webRequest fires a lot; buffer per tab and write to storage in batches.
const pendingNetwork = new Map(); // tabId → Map(key → entry)
let flushTimer = null;

function onHeadersReceived(details) {
  if (details.tabId < 0) return;
  if (details.statusCode !== 200 && details.statusCode !== 206) return;
  const type = classify(details.url, header(details, 'content-type'), details.type);
  if (!type) return;
  const sizeBytes = totalSize(details);
  if (type === 'sniff') {
    if (sizeBytes == null || sizeBytes < 4 * 1024 * 1024) sniffPlaylist(details);
    return;
  }
  if (type === 'direct' && sizeBytes != null && sizeBytes < MIN_NETWORK_VIDEO_BYTES) return;
  recordNetwork(details, type, sizeBytes);
}

function recordNetwork(details, type, sizeBytes) {
  const key = baseKey(details.url);
  const tabMap = pendingNetwork.get(details.tabId) || new Map();
  const prev = tabMap.get(key);
  tabMap.set(key, {
    key,
    // The range-free URL, so the download fetches the whole file (VID-3).
    url: key,
    type,
    mime: header(details, 'content-type').split(';')[0].trim() || null,
    sizeBytes: sizeBytes ?? prev?.sizeBytes ?? null,
    frameId: details.frameId ?? 0,
    seenAt: Date.now(),
  });
  pendingNetwork.set(details.tabId, tabMap);
  if (!flushTimer) flushTimer = setTimeout(flushNetwork, NETWORK_FLUSH_MS);
}

async function flushNetwork() {
  flushTimer = null;
  const batches = [...pendingNetwork.entries()];
  pendingNetwork.clear();
  for (const [tabId, entries] of batches) {
    await updateTab(tabId, (data) => {
      for (const [key, entry] of entries) {
        const prev = data.network[key];
        data.network[key] = prev ? { ...prev, ...entry, sizeBytes: entry.sizeBytes ?? prev.sizeBytes } : entry;
      }
      // Cap the log, dropping the oldest entries.
      const keys = Object.keys(data.network);
      if (keys.length > MAX_NETWORK_ENTRIES) {
        keys
          .sort((a, b) => data.network[a].seenAt - data.network[b].seenAt)
          .slice(0, keys.length - MAX_NETWORK_ENTRIES)
          .forEach((k) => delete data.network[k]);
      }
    });
    notifyPopup({ type: MSG.MEDIA_UPDATED, tabId });
  }
}

chrome.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders'],
);

// --------------------------------------------------------- building the list

function labelFromUrl(url) {
  const m = url.match(/(?:^|[^\d])(2160|1440|1080|720|540|480|360|240|144)p?(?:[^\d]|$)/i);
  return m ? `${m[1]}p` : 'Default';
}

function fileTitle(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return last.replace(/\.[a-z0-9]{2,5}$/i, '');
  } catch {
    return '';
  }
}

// --------------------------------------------- HLS stream analysis (HLS-1/2)
// A captured .m3u8 is read once to build its quality list. Media playlists
// that belong to a master (its variants and renditions) are hidden, so each
// stream shows up as one entry.

const HLS_FETCH_TIMEOUT_MS = 8000;
const MAX_ANALYSES = 200;
const hlsAnalyses = new Map(); // playlist URL → { status, ... }

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HLS_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// The body decides, not the label: sniffed or page-reported URLs may be either.
async function analyzeStream(url) {
  const text = await fetchText(url);
  const head = text.slice(0, 2048).replace(/^﻿/, '').trimStart();
  if (head.startsWith('#EXTM3U')) return analyzeHls(text, url);
  if (/<MPD[\s>]/.test(head)) return analyzeDash(text, url);
  throw new Error('not a playlist');
}

function analyzeDash(text, url) {
  const mpd = parseMpd(text, url);
  const { qualities, drm, subtitles } = qualitiesFromMpd(mpd);
  return {
    kind: 'dash',
    qualities: qualities.map((q) => ({
      label: q.label,
      url,
      audioUrl: null,
      dash: { videoId: q.videoId, audioId: q.audioId },
      subtitles: subtitles.map((s) => ({ id: s.id, language: s.language, name: s.name })),
      width: q.width,
      height: q.height,
      bandwidth: q.bandwidth,
    })),
    children: new Set(),
    live: mpd.live,
    drm,
    duration: mpd.duration || null,
  };
}

async function analyzeHls(text, url) {
  const playlist = parsePlaylist(text, url);
  if (playlist.kind === 'master') {
    const qualities = qualitiesFromMaster(playlist);
    const children = new Set([...playlist.variants.map((v) => baseKey(v.url)), ...playlist.renditionUrls.map(baseKey)]);
    let live = false;
    let drm = playlist.drm;
    let duration = null;
    // One variant tells us whether it is live/protected and how long it runs.
    if (qualities[0]) {
      try {
        const media = parsePlaylist(await fetchText(qualities[0].url), qualities[0].url);
        live = !media.endList;
        drm = drm || media.encryption === 'drm';
        duration = media.totalDuration;
      } catch {
        /* keep what the master told us */
      }
    }
    return { kind: 'hls', qualities, children, live, drm, duration };
  }
  return {
    kind: 'hls',
    qualities: [{ label: 'Default', url, audioUrl: null, width: null, height: null, bandwidth: null }],
    children: new Set(),
    live: !playlist.endList,
    drm: playlist.encryption === 'drm',
    duration: playlist.totalDuration,
  };
}

function streamAnalysis(url, tabId) {
  let a = hlsAnalyses.get(url);
  if (!a) {
    if (hlsAnalyses.size >= MAX_ANALYSES) hlsAnalyses.delete(hlsAnalyses.keys().next().value);
    a = { status: 'pending' };
    hlsAnalyses.set(url, a);
    a.promise = analyzeStream(url)
      .then((result) => Object.assign(a, result, { status: 'ready' }))
      .catch((err) => Object.assign(a, { status: 'error', error: String(err?.message || err) }))
      .finally(() => notifyPopup({ type: MSG.MEDIA_UPDATED, tabId }));
  }
  return a;
}

function streamItem(entry, data, tabId) {
  const a = streamAnalysis(entry.url, tabId);
  const kind = a.kind || entry.type; // what the playlist turned out to be
  const qualities = (a.qualities?.length ? a.qualities : [{ label: 'Default', url: entry.url }]).map((q) => ({
    id: hash(`${q.url}|${q.audioUrl || ''}|${q.dash?.videoId || ''}|${q.dash?.audioId || ''}`).slice(0, 10),
    label: q.label,
    url: q.url,
    audioUrl: q.audioUrl || null,
    dash: q.dash || null,
    subtitles: q.subtitles || [],
    width: q.width || null,
    height: q.height || null,
    bandwidth: q.bandwidth || null,
    // Estimate from bitrate × duration; shown with "≈".
    sizeBytes: q.bandwidth && a.duration ? Math.round((q.bandwidth * a.duration) / 8) : null,
    estimated: true,
  }));
  return {
    id: hash(`net:${entry.key}`),
    tabId,
    frameId: entry.frameId ?? 0,
    kind: 'video',
    source: 'network',
    type: a.drm ? 'protected' : kind,
    live: Boolean(a.live),
    seenAt: entry.seenAt || 0,
    analyzing: a.status === 'pending',
    streamError: a.status === 'error' ? a.error : null,
    duration: a.duration || null,
    pageUrl: data.pageUrl,
    title: data.pageTitle || fileTitle(entry.url),
    thumbnail: null,
    qualities,
  };
}

function networkItem(entry, data, tabId) {
  if (entry.type === 'hls' || entry.type === 'dash') return streamItem(entry, data, tabId);
  const label = labelFromUrl(entry.url);
  const height = parseInt(label, 10) || null;
  return {
    id: hash(`net:${entry.key}`),
    tabId,
    frameId: entry.frameId ?? 0,
    kind: 'video',
    source: 'network',
    type: entry.type,
    pageUrl: data.pageUrl,
    title: data.pageTitle || fileTitle(entry.url),
    thumbnail: null,
    qualities: [
      {
        id: hash(entry.url).slice(0, 10),
        label,
        url: entry.url,
        width: height ? Math.round((height * 16) / 9) : null,
        height,
        bandwidth: null,
        sizeBytes: entry.sizeBytes ?? sizeCache.get(entry.url) ?? null,
        mime: entry.mime,
      },
    ],
  };
}

// DOM items first, then network-only entries. A network entry that matches a
// DOM video's source only contributes its size to that entry.
function mergedItems(data, tabId) {
  const seen = new Set();
  const items = [];
  const byUrlKey = new Map(); // baseKey(quality url) → quality
  for (const [frameId, frame] of Object.entries(data.frames)) {
    for (const item of frame.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      const copy = { ...item, tabId, frameId: Number(frameId), qualities: item.qualities.map((q) => ({ ...q })) };
      for (const q of copy.qualities) {
        if (q.sizeBytes == null && sizeCache.has(q.url)) q.sizeBytes = sizeCache.get(q.url);
        byUrlKey.set(baseKey(q.url), q);
      }
      items.push(copy);
    }
  }

  const network = Object.values(data.network || {});
  const hasStream = network.some((e) => e.type === 'hls' || e.type === 'dash');
  // Playlists that a master on this tab already covers.
  const childKeys = new Set();
  for (const entry of network) {
    const a = entry.type === 'hls' || entry.type === 'dash' ? hlsAnalyses.get(entry.url) : null;
    if (a?.status === 'ready') for (const key of a.children) if (key !== entry.key) childKeys.add(key);
  }
  for (const entry of network) {
    if (childKeys.has(entry.key)) continue;
    const match = byUrlKey.get(entry.key);
    if (match) {
      if (match.sizeBytes == null && entry.sizeBytes != null) match.sizeBytes = entry.sizeBytes;
      continue;
    }
    const item = networkItem(entry, data, tabId);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  // VID-4: a MediaSource (blob:) video is linked to any stream seen on the tab.
  // If none of those streams can be saved, the video inherits the reason.
  const streams = items
    .filter((it) => it.type === 'hls' || it.type === 'dash' || (it.type === 'protected' && it.source === 'network'))
    .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
  const usable = streams.some((s) => (s.type === 'hls' || s.type === 'dash') && !itemBlockReason(s, data.pageUrl));
  for (const item of items) {
    if (item.type !== 'streamed') continue;
    item.streamDetected = hasStream;
    if (hasStream && !usable && streams[0]) item.streamReason = itemBlockReason(streams[0], data.pageUrl);
  }
  // Every item that can't be downloaded says why (popup rows, hover button).
  for (const item of items) item.blockReason = itemBlockReason(item, data.pageUrl || item.pageUrl);
  return items;
}

// ------------------------------------------------------ size lookups (VID-5)

const sizeCache = new Map(); // url → bytes (or null when unknown)
const sizeQueue = [];
let sizeActive = 0;
const sizeWaiting = new Set();

async function lookupSize(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    let res = await fetch(url, { method: 'HEAD', credentials: 'include', signal: controller.signal });
    let length = Number(res.headers.get('content-length'));
    if (res.ok && length > 0) return length;
    // Some servers don't answer HEAD properly; ask for one byte instead.
    res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: controller.signal });
    const range = (res.headers.get('content-range') || '').match(/\/(\d+)\s*$/);
    controller.abort(); // don't download the body
    if (range) return Number(range[1]);
    length = Number(res.headers.get('content-length'));
    return res.status === 200 && length > 0 ? length : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function queueSizeLookups(items, tabId) {
  for (const item of items) {
    if (item.kind !== 'video' || item.type !== 'direct') continue;
    for (const q of item.qualities) {
      if (q.sizeBytes != null || sizeCache.has(q.url) || sizeWaiting.has(q.url)) continue;
      if (!/^https?:/i.test(q.url)) continue;
      sizeWaiting.add(q.url);
      sizeQueue.push({ url: q.url, tabId });
    }
  }
  pumpSizeQueue();
}

function pumpSizeQueue() {
  while (sizeActive < MAX_SIZE_LOOKUPS && sizeQueue.length) {
    const { url, tabId } = sizeQueue.shift();
    sizeActive++;
    lookupSize(url).then((bytes) => {
      sizeCache.set(url, bytes);
      sizeWaiting.delete(url);
      sizeActive--;
      if (bytes != null) notifyPopup({ type: MSG.MEDIA_UPDATED, tabId });
      pumpSizeQueue();
    });
  }
}

async function getMedia(tabId) {
  const data = await readTab(tabId);
  const items = mergedItems(data, tabId);
  queueSizeLookups(items, tabId);
  return { items, pageUrl: data.pageUrl, pageTitle: data.pageTitle };
}

// ---------------------------------------------------------------- downloads

// downloadId → { tabId, itemId } for reporting failures back to the popup.
const activeDownloads = new Map();

// Ask the server for the Content-Type when the URL has no usable extension.
async function sniffExtension(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include', signal: controller.signal });
    return extFromMime(res.headers.get('content-type'), '');
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// The explanation shown when a download is refused (see utils/reasons.js).
function notDownloadableReason(item) {
  const reason = item.blockReason ?? itemBlockReason(item);
  return reason ? reason.detail : null;
}

async function handleDownload(msg, sender) {
  const tabId = msg.tabId ?? sender.tab?.id;
  if (tabId == null) throw new Error('No tab for this download.');

  const data = await readTab(tabId);
  let item = mergedItems(data, tabId).find((it) => it.id === msg.itemId);
  if (item?.analyzing) {
    // Still reading the playlist: wait for it rather than failing.
    const entry = Object.values(data.network).find((e) => hash(`net:${e.key}`) === item.id);
    await hlsAnalyses.get(entry?.url)?.promise;
    item = mergedItems(data, tabId).find((it) => it.id === msg.itemId);
  }
  if (!item) throw new Error('That item is no longer on the page. Reopen the popup and try again.');
  const reason = notDownloadableReason(item);
  if (reason) throw new Error(reason);

  const quality = item.qualities.find((q) => q.id === msg.qualityId) || item.qualities[0];
  const settings = await getSettings();
  if (item.type === 'hls' || item.type === 'dash') return startStreamJob(item, quality, data, settings);
  const fallbackExt = item.kind === 'video' ? 'mp4' : 'jpg';

  let url = quality.url;
  let ext = '';

  // IMG-8: blob: URLs only make sense inside the page that created them.
  if (url.startsWith('blob:')) {
    const res = await chrome.tabs.sendMessage(tabId, { type: MSG.FETCH_AS_DATA_URL, url }, { frameId: item.frameId });
    if (!res?.ok) throw new Error(`Could not read the file from the page (${res?.error || 'no response'}).`);
    url = res.dataUrl;
    ext = extFromMime(res.mime, '');
  }

  if (!ext) ext = extFromUrl(url, '');
  if (!ext && quality.mime) ext = extFromMime(quality.mime, '');
  if (!ext && /^https?:/i.test(url)) ext = await sniffExtension(url);
  if (!ext) ext = fallbackExt;

  const site = siteFromUrl(data.pageUrl || item.pageUrl);
  let filename = buildFilename({
    pattern: settings.filenamePattern,
    site,
    title: item.title || data.pageTitle,
    // Labels that say nothing about the file stay out of the name.
    quality: /^(Default|SVG \(vector\))$/.test(quality.label) ? '' : quality.label,
    ext,
  });
  if (msg.bulk) filename = `${bulkFolderName(site)}/${filename}`;

  const options = {
    url,
    filename,
    conflictAction: 'uniquify',
    // A Save As dialog per file would be unusable for bulk downloads.
    saveAs: Boolean(settings.askWhereToSave && !msg.bulk),
  };

  let downloadId;
  try {
    downloadId = await chrome.downloads.download(options);
  } catch (err) {
    // Chrome rejects some filenames it considers unsafe; retry with a plain one.
    if (/filename/i.test(String(err?.message))) {
      downloadId = await chrome.downloads.download({ ...options, filename: `${site}.${ext}` });
    } else if (/invalid url/i.test(String(err?.message))) {
      throw new Error('The browser can’t download from this kind of address.');
    } else {
      throw new Error(`The browser refused to start the download (${err?.message || err}).`);
    }
  }
  activeDownloads.set(downloadId, { tabId, itemId: item.id });
  return { downloadId, filename };
}

// -------------------------------------------- HLS jobs (offscreen document)

const OFFSCREEN_URL = 'offscreen/offscreen.html';
let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Fetch HLS stream segments and merge them into one file for download.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

function toOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: OFFSCREEN });
}

async function startStreamJob(item, quality, data, settings) {
  const site = siteFromUrl(data.pageUrl || item.pageUrl);
  const shortLabel = quality.label === 'Default' ? '' : quality.label.split(' · ')[0];
  const filenameBase = buildFilename({
    pattern: settings.filenamePattern,
    site,
    title: item.title || data.pageTitle,
    quality: shortLabel,
    ext: 'mp4',
  }).replace(/\.mp4$/, '');
  const jobId = crypto.randomUUID();
  cancelOffscreenClose();
  await ensureOffscreen();
  await toOffscreen({
    type: MSG.HLS_START,
    jobId,
    title: item.title || data.pageTitle || 'Stream',
    label: quality.label,
    kind: item.type === 'dash' ? 'dash' : 'hls',
    playlistUrl: quality.url,
    audioUrl: quality.audioUrl || null,
    dash: quality.dash || null,
    subtitles: quality.subtitles || [],
    options: {
      parallel: settings.maxParallelSegments,
      convertToMp4: settings.convertHlsToMp4,
      saveSubtitles: settings.saveSubtitles !== false,
      filenameBase,
      saveAs: Boolean(settings.askWhereToSave),
    },
  });
  return { jobId, hls: true };
}

// #3: the hover button on a "Streamed" video downloads the stream behind it.
// A page usually plays one stream at a time, so pick the most recently seen
// downloadable one (waiting briefly if its playlist is still being read).
async function streamForTab(tabId) {
  const data = await readTab(tabId);
  const streams = () =>
    mergedItems(data, tabId)
      .filter((it) => it.type === 'hls' || it.type === 'dash')
      .sort((a, b) => (b.seenAt || 0) - (a.seenAt || 0));
  const pending = Object.values(data.network)
    .filter((e) => e.type === 'hls' || e.type === 'dash')
    .map((e) => hlsAnalyses.get(e.url)?.promise)
    .filter(Boolean);
  if (streams().some((s) => s.analyzing)) {
    await Promise.race([Promise.allSettled(pending), new Promise((r) => setTimeout(r, 4000))]);
  }
  const list = streams();
  // Sites that never allow it (YouTube, DRM services) say so first.
  const site = siteReason(data.pageUrl);
  if (site) return { item: null, reason: site.detail, short: site.short };
  const usable = list.find((s) => !s.blockReason);
  if (usable) return { item: usable };
  const why = itemBlockReason(
    { type: 'streamed', streamDetected: list.length > 0, streamReason: list[0]?.blockReason || null },
    data.pageUrl,
  );
  return { item: null, reason: why.detail, short: why.short };
}

// blob downloads waiting for chrome.downloads to finish, so the offscreen
// document can free them (spec §4.4). Kept in storage.session in case this
// worker restarts mid-download.
async function rememberBlobDownload(downloadId, blobUrl) {
  const { blobDownloads = {} } = await chrome.storage.session.get('blobDownloads');
  blobDownloads[downloadId] = blobUrl;
  await chrome.storage.session.set({ blobDownloads });
}

async function releaseBlobDownload(downloadId) {
  const { blobDownloads = {} } = await chrome.storage.session.get('blobDownloads');
  const blobUrl = blobDownloads[downloadId];
  if (!blobUrl) return false;
  delete blobDownloads[downloadId];
  await chrome.storage.session.set({ blobDownloads });
  await revokeBlob(blobUrl);
  return true;
}

async function revokeBlob(blobUrl) {
  try {
    const res = await toOffscreen({ type: MSG.HLS_REVOKE, blobUrl });
    if (res && !res.active) scheduleOffscreenClose();
  } catch {
    /* offscreen already gone */
  }
}

// Close the offscreen document once it has been idle for a while, to free its
// memory. Never immediately: a new job may be starting in it right now.
const OFFSCREEN_IDLE_CLOSE_MS = 30_000;
let offscreenCloseTimer = null;

function cancelOffscreenClose() {
  clearTimeout(offscreenCloseTimer);
  offscreenCloseTimer = null;
}

function scheduleOffscreenClose() {
  cancelOffscreenClose();
  offscreenCloseTimer = setTimeout(async () => {
    offscreenCloseTimer = null;
    try {
      if (!(await hasOffscreen())) return;
      const { jobs = [] } = (await toOffscreen({ type: MSG.HLS_JOBS, includeDismissed: true })) || {};
      const busy = jobs.some((j) => j.pendingFiles > 0 || !['done', 'error', 'cancelled'].includes(j.state));
      if (!busy && !creatingOffscreen) await chrome.offscreen.closeDocument();
    } catch {
      /* already closed */
    }
  }, OFFSCREEN_IDLE_CLOSE_MS);
}

async function onHlsDone(msg) {
  for (const file of msg.files || []) {
    const filename = `${msg.filenameBase || 'stream'}${file.suffix || ''}.${file.ext}`;
    try {
      const downloadId = await chrome.downloads.download({
        url: file.blobUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: Boolean(msg.saveAs),
      });
      await rememberBlobDownload(downloadId, file.blobUrl);
    } catch (err) {
      await revokeBlob(file.blobUrl);
      notifyPopup({ type: MSG.HLS_ERROR, jobId: msg.jobId, message: `Could not save the file (${err.message}).` });
    }
  }
}

async function forwardJobCommand(msg) {
  if (!(await hasOffscreen())) return msg.type === MSG.HLS_JOBS ? { jobs: [] } : { ok: false };
  return (await toOffscreen({ type: msg.type, jobId: msg.jobId })) || { ok: false };
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const wasStream = await releaseBlobDownload(delta.id);
  // A merged stream file that couldn't be written (disk full, folder not writable…).
  const message = wasStream && downloadErrorMessage(delta.error?.current);
  if (message) notifyPopup({ type: MSG.DOWNLOAD_FAILED, code: delta.error.current, message });
});

chrome.downloads.onChanged.addListener((delta) => {
  const info = activeDownloads.get(delta.id);
  if (!info) return;
  const message = delta.error?.current && downloadErrorMessage(delta.error.current);
  if (message) {
    notifyPopup({ type: MSG.DOWNLOAD_FAILED, tabId: info.tabId, itemId: info.itemId, code: delta.error.current, message });
  }
  const state = delta.state?.current;
  if (state === 'complete' || state === 'interrupted') activeDownloads.delete(delta.id);
});

// ----------------------------------------------------------------- routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === OFFSCREEN) return false; // addressed to the offscreen document
  switch (msg?.type) {
    case MSG.HLS_DONE:
      if (sender.id === chrome.runtime.id) onHlsDone(msg);
      return false;

    case MSG.STREAM_FOR_TAB:
      if (sender.tab?.id == null) return false;
      streamForTab(sender.tab.id).then(sendResponse, (err) => sendResponse({ item: null, reason: String(err?.message || err) }));
      return true;

    case MSG.HLS_JOBS:
    case MSG.CANCEL:
    case MSG.RETRY:
    case MSG.DISMISS:
      forwardJobCommand(msg).then(sendResponse, (err) => sendResponse({ ok: false, jobs: [], error: String(err?.message || err) }));
      return true;

    case MSG.PING:
      sendResponse({ build: BUILD });
      return false;

    case MSG.MEDIA_FOUND:
      onMediaFound(msg, sender).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    case MSG.GET_MEDIA:
      getMedia(msg.tabId).then(sendResponse, (err) => sendResponse({ items: [], error: String(err?.message || err) }));
      return true;

    case MSG.DOWNLOAD:
      handleDownload(msg, sender).then(
        (result) => sendResponse({ ok: true, ...result }),
        (err) => sendResponse({ ok: false, error: String(err?.message || err) }),
      );
      return true;

    default:
      return false;
  }
});

// --------------------------------------------------------- tab lifecycle

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // A new document is loading in the tab: drop the old page's media.
  if (changeInfo.status === 'loading') {
    clearTab(tabId).then(() => notifyPopup({ type: MSG.MEDIA_UPDATED, tabId }));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  tabLocks.delete(tabId);
});
