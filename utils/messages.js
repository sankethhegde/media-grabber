// Shared message type constants (spec §4.3).
// The content script cannot import modules, so it keeps its own copy of the
// strings it uses — keep the two in sync.

// Bump on every release. The popup compares it with the running service worker
// and content scripts: Chrome reloads popup files from disk on every open, but
// keeps old background/content code running until the extension is reloaded.
// content/content-script.js keeps a copy.
export const BUILD = '1.3.3';

// Messages meant for the offscreen document carry `target: OFFSCREEN`; every
// other listener ignores them (runtime messages reach all extension pages).
export const OFFSCREEN = 'offscreen';

export const MSG = Object.freeze({
  // Popup → service worker: {} → { build }
  PING: 'PING',
  // Content script → service worker: { items: MediaItem[], pageUrl, pageTitle }
  MEDIA_FOUND: 'MEDIA_FOUND',
  // Popup → service worker: { tabId } → { items: MediaItem[], pageUrl, pageTitle }
  GET_MEDIA: 'GET_MEDIA',
  // Popup or content script → service worker: { itemId, qualityId, tabId?, bulk? }
  DOWNLOAD: 'DOWNLOAD',

  // HLS (spec §4.3).
  // SW → offscreen: { jobId, title, playlistUrl, audioUrl, options }
  HLS_START: 'HLS_START',
  // Offscreen → SW + popup: { jobId, state, done, total, bytes, speed, error, note, title }
  HLS_PROGRESS: 'HLS_PROGRESS',
  // Offscreen → SW: { jobId, files: [{ blobUrl, ext, suffix }], filenameBase, saveAs, note }
  HLS_DONE: 'HLS_DONE',
  // Offscreen → SW + popup: { jobId, code, message }
  HLS_ERROR: 'HLS_ERROR',
  // Popup → SW → offscreen: { jobId }
  CANCEL: 'CANCEL',
  RETRY: 'RETRY',
  DISMISS: 'DISMISS',
  // Popup → SW → offscreen: {} → { jobs: [...] }
  HLS_JOBS: 'HLS_JOBS',
  // SW → offscreen: { blobUrl } once chrome.downloads has finished with it.
  HLS_REVOKE: 'HLS_REVOKE',

  // Content script → SW: {} → { item: MediaItem | null, reason? }. The best
  // HLS/DASH stream on the sender's tab, for the hover button on a streamed video.
  STREAM_FOR_TAB: 'STREAM_FOR_TAB',

  // Internal helpers (not in the spec table, but part of the same contract).
  // Popup → content script (all frames): scan immediately and report.
  RESCAN: 'RESCAN',
  // Service worker → content script (one frame): turn a blob: URL into a data: URL.
  FETCH_AS_DATA_URL: 'FETCH_AS_DATA_URL',
  // Service worker → popup: the media list for a tab changed.
  MEDIA_UPDATED: 'MEDIA_UPDATED',
  // Service worker → popup: a download failed after it started.
  DOWNLOAD_FAILED: 'DOWNLOAD_FAILED',
});
