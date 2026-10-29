// Media Grabber — popup (spec §3.4).
// Asks the page to rescan, fetches the media list from the service worker,
// and renders Images and Videos with filters, quality choice and downloads.

import { BUILD, MSG } from '../utils/messages.js';
import { extFromUrl } from '../utils/filename.js';
import { getSettings } from '../utils/settings.js';

const $ = (id) => document.getElementById(id);

const RESTRICTED_URL = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|chrome-search|devtools|view-source):/i;
const RESTRICTED_HOSTS = ['chromewebstore.google.com', 'microsoftedge.microsoft.com'];
const KNOWN_TYPES = new Set(['jpg', 'png', 'webp', 'gif', 'svg', 'avif']);

const VIDEO_TYPE_LABEL = { direct: 'Direct', hls: 'HLS', dash: 'DASH', streamed: 'Streamed', protected: 'Protected' };
const VIDEO_TYPE_ORDER = { direct: 0, hls: 1, dash: 2, streamed: 3, protected: 4 };

const state = {
  tabId: null,
  items: [],
  activeTab: 'images',
  minSize: 0, // "Min" filter: longest side ≥ this (0 = any)
  maxSize: 0, // "Max" filter: longest side ≤ this (0 = any)
  show: 'all', // 'all' | 'logos' (logos & icons) | 'other'
  floorSize: 0, // settings.minImageSize: images smaller than this are never listed
  type: 'all',
  quality: new Map(), // itemId → qualityId the user picked
  checked: new Set(), // itemIds ticked for bulk download
  signature: '',
};

// ------------------------------------------------------------------ helpers

function isRestricted(url) {
  if (!url) return true;
  if (RESTRICTED_URL.test(url)) return true;
  try {
    const u = new URL(url);
    return RESTRICTED_HOSTS.includes(u.hostname) || (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore'));
  } catch {
    return true;
  }
}

function svgUse(symbol, className = '') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

function downloadButton(text = 'Download') {
  const button = document.createElement('button');
  button.className = 'btn-dl';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = text;
  button.append(svgUse('glyph-download', 'glyph'), label);
  return button;
}

function setButtonLabel(button, text) {
  button.querySelector('.label').textContent = text;
}

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = false;
  $('empty').hidden = true;
  $('list-images').hidden = true;
  $('list-videos').hidden = true;
  $('toolbar').hidden = true;
  $('actionbar').hidden = true;
}

let toastTimer;
function toast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
}

function selectedQuality(item) {
  const id = state.quality.get(item.id);
  return item.qualities.find((q) => q.id === id) || item.qualities[0];
}

function typeOf(url) {
  if (url.startsWith('blob:')) return 'blob';
  return extFromUrl(url, '') || 'other';
}

// Longest side of the biggest version we know the size of.
function largestSide(item) {
  let best = 0;
  for (const q of item.qualities) best = Math.max(best, q.width || 0, q.height || 0);
  return best;
}

function formatBytes(n) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function dimensionsText(q) {
  if (q.width && q.height) return `${q.width} × ${q.height}`;
  if (q.label === 'Original') return 'Full size';
  return 'Size unknown';
}

function sizeText(q) {
  if (!q.sizeBytes) return '';
  return `${q.estimated ? '≈ ' : ''}${formatBytes(q.sizeBytes)}`;
}

function formatDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function qualityOptionText(q) {
  const dims = q.width && q.height ? `${q.width}×${q.height}` : '';
  const parts = [q.label];
  // HLS labels already say "720p"; repeating the dimensions adds nothing.
  if (dims && q.label !== dims && !q.estimated) parts.push(dims);
  if (q.sizeBytes) parts.push(sizeText(q));
  return parts.join(' · ');
}

// ----------------------------------------------------------------- filters

const ICON_MAX_SIDE = 64; // images this small count as icons

// 'logo', 'icon' or null: what the page told us, else small means icon.
function imageCategory(item) {
  if (item.category) return item.category;
  const side = largestSide(item);
  return side > 0 && side <= ICON_MAX_SIDE ? 'icon' : null;
}

function visibleImages() {
  return state.items.filter((item) => {
    if (item.kind !== 'image') return false;
    // Unknown size (e.g. a lazy image not loaded yet) stays visible: those are
    // usually real content, and hiding them would look like a missed image.
    const side = largestSide(item);
    if (side > 0) {
      if (side < Math.max(state.minSize, state.floorSize)) return false;
      if (state.maxSize > 0 && side > state.maxSize) return false;
    }
    if (state.show !== 'all') {
      const isLogoOrIcon = Boolean(imageCategory(item));
      if (state.show === 'logos' ? !isLogoOrIcon : isLogoOrIcon) return false;
    }
    if (state.type !== 'all') {
      const t = typeOf(selectedQuality(item).url);
      const bucket = KNOWN_TYPES.has(t) ? t : 'other';
      if (bucket !== state.type) return false;
    }
    return true;
  });
}

function visibleVideos() {
  return state.items
    .filter((i) => i.kind === 'video')
    .sort((a, b) => (VIDEO_TYPE_ORDER[a.type] ?? 9) - (VIDEO_TYPE_ORDER[b.type] ?? 9));
}

// ------------------------------------------------------------------ render

function render() {
  const images = visibleImages();
  const videos = visibleVideos();

  $('count-images').textContent = images.length;
  $('count-videos').textContent = videos.length;

  const onImages = state.activeTab === 'images';
  $('list-images').hidden = !onImages;
  $('list-videos').hidden = onImages;
  $('toolbar').hidden = !onImages;
  $('actionbar').hidden = !onImages;
  $('empty').hidden = (onImages ? images : videos).length > 0;
  $('message').hidden = true;

  // Drop ticks on items that are filtered out or gone.
  const visibleIds = new Set(images.map((i) => i.id));
  for (const id of state.checked) if (!visibleIds.has(id)) state.checked.delete(id);

  const imageFragment = document.createDocumentFragment();
  for (const item of images) imageFragment.appendChild(renderImageRow(item));
  $('list-images').replaceChildren(imageFragment);

  const videoFragment = document.createDocumentFragment();
  for (const item of videos) videoFragment.appendChild(renderVideoRow(item));
  $('list-videos').replaceChildren(videoFragment);

  updateBulkControls(images);
}

function thumbnailImg(src, className = 'thumb') {
  const thumb = document.createElement('img');
  thumb.className = className;
  thumb.alt = '';
  thumb.loading = 'lazy';
  thumb.referrerPolicy = 'no-referrer';
  if (src && !src.startsWith('blob:')) thumb.src = src;
  else thumb.classList.add('broken');
  thumb.addEventListener('error', () => {
    thumb.removeAttribute('src');
    thumb.classList.add('broken');
  });
  return thumb;
}

function qualitySelect(item, onChange) {
  const q = selectedQuality(item);
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Quality');
  for (const option of item.qualities) {
    const opt = document.createElement('option');
    opt.value = option.id;
    opt.textContent = qualityOptionText(option);
    opt.selected = option.id === q.id;
    select.append(opt);
  }
  select.disabled = item.qualities.length < 2;
  select.addEventListener('change', () => {
    state.quality.set(item.id, select.value);
    onChange?.(selectedQuality(item));
  });
  return select;
}

function renderImageRow(item) {
  const q = selectedQuality(item);
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.id = item.id;
  li.classList.toggle('checked', state.checked.has(item.id));

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = state.checked.has(item.id);
  check.setAttribute('aria-label', 'Select for bulk download');
  check.addEventListener('change', () => {
    if (check.checked) state.checked.add(item.id);
    else state.checked.delete(item.id);
    li.classList.toggle('checked', check.checked);
    updateBulkControls(visibleImages());
  });

  const thumb = thumbnailImg(item.thumbnail || item.qualities[item.qualities.length - 1].url);

  const info = document.createElement('div');
  info.className = 'info';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title || '(untitled)';
  title.title = q.url.startsWith('data:') ? item.title : `${item.title}\n${q.url}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const dims = document.createElement('span');
  dims.textContent = dimensionsText(q);
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = typeOf(q.url).toUpperCase();
  meta.append(dims, badge);
  const category = imageCategory(item);
  if (category) {
    const tag = document.createElement('span');
    tag.className = `badge ${category}`;
    tag.textContent = category === 'logo' ? 'LOGO' : 'ICON';
    meta.append(tag);
  }
  if (q.sizeBytes) {
    const size = document.createElement('span');
    size.textContent = formatBytes(q.sizeBytes);
    meta.append(size);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const select = qualitySelect(item, (picked) => {
    dims.textContent = dimensionsText(picked);
    badge.textContent = typeOf(picked.url).toUpperCase();
  });
  const button = downloadButton();
  button.addEventListener('click', () => downloadOne(item, button));

  actions.append(select, button);
  info.append(title, meta, actions);
  li.append(check, thumb, info);
  return li;
}

// Why a row can't be downloaded (computed by the service worker from
// utils/reasons.js), or a helpful note for rows that can.
function videoNote(item) {
  if (item.blockReason) return { ...item.blockReason, blocked: true };
  if ((item.type === 'hls' || item.type === 'dash') && item.qualities.some((q) => q.subtitles?.length)) {
    return { short: 'Subtitles included', detail: 'Subtitles are saved alongside the video.', blocked: false };
  }
  return null;
}

function renderVideoRow(item) {
  const q = selectedQuality(item);
  const li = document.createElement('li');
  li.className = 'row video';
  li.dataset.id = item.id;

  let thumb;
  if (item.thumbnail) {
    thumb = thumbnailImg(item.thumbnail);
  } else {
    thumb = document.createElement('div');
    thumb.className = 'thumb-placeholder';
    thumb.append(svgUse('glyph-play'));
    thumb.firstChild.setAttribute('width', '18');
    thumb.firstChild.setAttribute('height', '18');
  }

  const info = document.createElement('div');
  info.className = 'info';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = item.title || '(untitled video)';
  title.title = `${item.title}\n${q.url}`;

  const meta = document.createElement('div');
  meta.className = 'meta';
  const badge = document.createElement('span');
  badge.className = `badge ${item.type}`;
  if (item.type === 'protected') badge.append(svgUse('glyph-lock'));
  badge.append(VIDEO_TYPE_LABEL[item.type] || item.type);
  const dims = document.createElement('span');
  const size = document.createElement('span');
  const describe = (picked) => {
    dims.textContent = picked.width && picked.height ? `${picked.width} × ${picked.height}` : '';
    size.textContent = picked.sizeBytes ? sizeText(picked) : item.type === 'direct' ? 'Size unknown' : '';
  };
  describe(q);
  const duration = document.createElement('span');
  duration.textContent = item.duration ? formatDuration(item.duration) : '';
  const origin = document.createElement('span');
  origin.textContent = item.source === 'network' ? 'from network' : '';
  meta.append(badge, dims, duration, size, origin);

  info.append(title, meta);

  const note = videoNote(item);
  if (note) {
    const p = document.createElement('div');
    const tone = item.type === 'protected' || /DRM|YouTube/.test(note.short) ? 'protected' : note.blocked ? 'blocked' : '';
    p.className = `note ${tone}`;
    if (tone === 'protected') p.append(svgUse('glyph-lock'));
    const text = document.createElement('span');
    const label = document.createElement('strong');
    label.textContent = note.blocked ? `${note.short}. ` : '';
    text.append(label, note.detail);
    p.append(text);
    info.append(p);
  }

  const isStream = item.type === 'hls' || item.type === 'dash';
  const downloadable = (item.type === 'direct' || isStream) && !item.blockReason;
  // Rows that can never download (DRM, live, a streamed player) have no button.
  if (item.type !== 'protected' && item.type !== 'streamed' && !(isStream && item.live)) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const select = qualitySelect(item, describe);
    const button = downloadButton();
    button.disabled = !downloadable;
    if (item.blockReason) button.title = item.blockReason.detail;
    button.addEventListener('click', () => downloadOne(item, button));
    actions.append(select, button);
    info.append(actions);
  }

  li.append(thumb, info);
  return li;
}

function updateBulkControls(images) {
  const selectAll = $('select-all');
  const n = state.checked.size;
  selectAll.checked = images.length > 0 && n === images.length;
  selectAll.indeterminate = n > 0 && n < images.length;
  selectAll.disabled = images.length === 0;
  const bulk = $('download-selected');
  bulk.disabled = n === 0;
  setButtonLabel(bulk, n ? `Download selected (${n})` : 'Download selected');
  $('selection-note').textContent = n ? `${n} of ${images.length} selected` : 'Tick images to download several at once';
}

// --------------------------------------------------------------- downloads

async function requestDownload(item, bulk) {
  const q = selectedQuality(item);
  return chrome.runtime.sendMessage({
    type: MSG.DOWNLOAD,
    tabId: state.tabId,
    itemId: item.id,
    qualityId: q.id,
    bulk,
  });
}

async function downloadOne(item, button) {
  button.disabled = true;
  setButtonLabel(button, 'Saving…');
  button.classList.remove('done', 'failed');
  button.classList.add('busy');
  try {
    const res = await requestDownload(item, false);
    if (!res?.ok) throw new Error(res?.error || 'Download failed.');
    setButtonLabel(button, res.hls ? 'Started' : 'Saved');
    button.classList.add('done');
    if (res.hls) {
      upsertJob({ jobId: res.jobId, title: item.title, label: selectedQuality(item).label, state: 'starting', done: 0, total: 0, bytes: 0 });
    }
  } catch (err) {
    setButtonLabel(button, 'Failed');
    button.classList.add('failed');
    toast(err.message, true);
  } finally {
    button.classList.remove('busy');
    setTimeout(() => {
      button.disabled = false;
      setButtonLabel(button, 'Download');
      button.classList.remove('done', 'failed');
    }, 2500);
  }
}

async function downloadSelected() {
  const items = visibleImages().filter((i) => state.checked.has(i.id));
  if (!items.length) return;
  const bulk = $('download-selected');
  bulk.disabled = true;
  bulk.classList.add('busy');
  let ok = 0;
  let failed = 0;
  for (const item of items) {
    setButtonLabel(bulk, `Saving ${ok + failed + 1} / ${items.length}…`);
    try {
      const res = await requestDownload(item, true);
      if (res?.ok) ok++;
      else failed++;
    } catch {
      failed++;
    }
  }
  bulk.classList.remove('busy');
  toast(failed ? `Saved ${ok}, ${failed} failed.` : `Saved ${ok} file${ok === 1 ? '' : 's'}.`, failed > 0);
  state.checked.clear();
  render();
}

// ------------------------------------------------------ stream downloads

const jobs = new Map(); // jobId → latest progress from the offscreen document
const FINISHED = new Set(['done', 'error', 'cancelled']);

function upsertJob(update) {
  const prev = jobs.get(update.jobId) || {};
  jobs.set(update.jobId, { ...prev, ...update });
  renderJobs();
}

function jobCommand(type, jobId) {
  return chrome.runtime.sendMessage({ type, jobId }).catch(() => null);
}

function jobStatusText(job) {
  const pct = job.total ? Math.floor((job.done / job.total) * 100) : 0;
  switch (job.state) {
    case 'starting':
      return 'Reading playlist…';
    case 'running': {
      const parts = [`${pct}%`, `${job.done} / ${job.total} segments`];
      if (job.speed) parts.push(`${formatBytes(job.speed)}/s`);
      if (job.bytes) parts.push(formatBytes(job.bytes));
      return parts.join(' · ');
    }
    case 'paused':
      return `${job.error || 'Paused.'} (${job.done} / ${job.total} done)`;
    case 'merging':
      return `Merging ${formatBytes(job.bytes)}…`;
    case 'done': {
      const subs = job.subtitles ? ` + ${job.subtitles} subtitle file${job.subtitles === 1 ? '' : 's'}` : '';
      return job.note ? `Saved${subs}. ${job.note}` : `Saved · ${formatBytes(job.bytes)}${subs}`;
    }
    case 'cancelled':
      return 'Cancelled';
    case 'error':
      return job.error || 'Download failed.';
    default:
      return '';
  }
}

function smallButton(text, onClick, className = '') {
  const b = document.createElement('button');
  b.className = `btn-small ${className}`;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function renderJobs() {
  const panel = $('jobs');
  const list = [...jobs.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  panel.hidden = list.length === 0;
  const fragment = document.createDocumentFragment();
  for (const job of list) {
    const row = document.createElement('div');
    row.className = 'job';

    const title = document.createElement('div');
    title.className = 'job-title';
    title.textContent = job.title || 'Stream';
    if (job.label) {
      const dim = document.createElement('span');
      dim.className = 'dim';
      dim.textContent = ` · ${job.label.split(' · ')[0]}`;
      title.append(dim);
    }

    const actions = document.createElement('div');
    actions.className = 'job-actions';
    if (job.state === 'paused') actions.append(smallButton('Retry', () => jobCommand(MSG.RETRY, job.jobId)));
    if (!FINISHED.has(job.state)) {
      actions.append(smallButton('Cancel', () => jobCommand(MSG.CANCEL, job.jobId)));
    } else {
      const dismiss = smallButton('✕', () => {
        jobCommand(MSG.DISMISS, job.jobId);
        jobs.delete(job.jobId);
        renderJobs();
      }, 'icon');
      dismiss.title = 'Remove from list';
      dismiss.setAttribute('aria-label', 'Remove from list');
      actions.append(dismiss);
    }

    const status = document.createElement('div');
    status.className = `job-status ${job.state === 'error' || job.state === 'paused' ? 'error' : job.state === 'done' ? 'done' : ''}`;
    status.textContent = jobStatusText(job);

    row.append(title, actions);
    if (!FINISHED.has(job.state)) {
      const bar = document.createElement('div');
      bar.className = 'bar';
      bar.setAttribute('role', 'progressbar');
      const fill = document.createElement('span');
      if (job.state === 'starting' || job.state === 'merging') bar.classList.add('indeterminate');
      else fill.style.width = `${job.total ? (job.done / job.total) * 100 : 0}%`;
      if (job.state === 'paused') bar.classList.add('paused');
      bar.setAttribute('aria-valuenow', String(job.total ? Math.floor((job.done / job.total) * 100) : 0));
      bar.append(fill);
      row.append(bar);
    }
    row.append(status);
    fragment.append(row);
  }
  panel.replaceChildren(fragment);
}

async function loadJobs() {
  const res = await chrome.runtime.sendMessage({ type: MSG.HLS_JOBS }).catch(() => null);
  for (const job of res?.jobs || []) upsertJob(job);
}

// -------------------------------------------------------------------- load

async function loadMedia() {
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_MEDIA, tabId: state.tabId });
  const items = res?.items || [];
  // Skip re-rendering (and losing scroll position) when nothing changed.
  const signature = items
    .map((i) => i.id + i.type + i.qualities.map((q) => `${q.width || 0}.${q.sizeBytes || 0}`).join(',') + (i.thumbnail ? 't' : ''))
    .join('|');
  if (signature === state.signature) return;
  state.signature = signature;
  state.items = items;
  render();
}

let reloadTimer;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadMedia, 150);
}

// Chrome reads popup files fresh from disk on every open, but keeps running
// the old service worker until the extension is reloaded on chrome://extensions.
// Detect that and offer the reload, otherwise new features silently do nothing.
async function backgroundIsCurrent() {
  try {
    const res = await chrome.runtime.sendMessage({ type: MSG.PING });
    return res?.build === BUILD;
  } catch {
    return false;
  }
}

function showUpdateBanner() {
  $('update-banner').hidden = false;
  $('reload-extension').addEventListener('click', () => chrome.runtime.reload(), { once: true });
}

// Make sure a current content script is running in the tab (there is none on
// tabs opened before the extension was installed or reloaded), then scan now.
async function ensureScanned(tab) {
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: MSG.RESCAN });
    if (res?.build === BUILD) return true;
  } catch {
    /* no content script yet */
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id, allFrames: true }, files: ['content/overlay.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content/content-script.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: MSG.RESCAN });
    return true;
  } catch {
    return false;
  }
}

async function savePrefs() {
  try {
    await chrome.storage.local.set({
      popupPrefs: { minSize: state.minSize, maxSize: state.maxSize, show: state.show, type: state.type, activeTab: state.activeTab },
    });
  } catch {
    /* non-essential */
  }
}

function selectTab(name) {
  state.activeTab = name;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === name));
  }
  savePrefs();
  render();
}

async function init() {
  const settings = await getSettings();
  const { popupPrefs } = await chrome.storage.local.get('popupPrefs');
  state.floorSize = Number(settings.minImageSize) || 0;
  state.minSize = popupPrefs?.minSize ?? 0;
  state.maxSize = popupPrefs?.maxSize ?? 0;
  state.show = popupPrefs?.show ?? 'all';
  state.type = popupPrefs?.type ?? 'all';
  state.activeTab = popupPrefs?.activeTab === 'videos' ? 'videos' : 'images';
  // Restore saved choices; anything no longer offered falls back to the first option.
  const restore = (id, value, key) => {
    $(id).value = String(value);
    if ($(id).value !== String(value)) {
      $(id).selectedIndex = 0;
      state[key] = key === 'show' ? 'all' : 0;
    }
  };
  restore('filter-size', state.minSize, 'minSize');
  restore('filter-max', state.maxSize, 'maxSize');
  restore('filter-show', state.show, 'show');
  $('filter-type').value = state.type;
  for (const btn of document.querySelectorAll('.tab')) {
    btn.setAttribute('aria-selected', String(btn.dataset.tab === state.activeTab));
  }

  $('filter-size').addEventListener('change', (e) => {
    state.minSize = Number(e.target.value);
    savePrefs();
    render();
  });
  $('filter-max').addEventListener('change', (e) => {
    state.maxSize = Number(e.target.value);
    savePrefs();
    render();
  });
  $('filter-show').addEventListener('change', (e) => {
    state.show = e.target.value;
    savePrefs();
    render();
  });
  $('filter-type').addEventListener('change', (e) => {
    state.type = e.target.value;
    savePrefs();
    render();
  });
  $('select-all').addEventListener('change', (e) => {
    const images = visibleImages();
    if (e.target.checked) images.forEach((i) => state.checked.add(i.id));
    else state.checked.clear();
    render();
  });
  $('download-selected').addEventListener('click', downloadSelected);
  $('open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => selectTab(btn.dataset.tab));
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || isRestricted(tab.url || tab.pendingUrl)) {
    showMessage("Extensions can't run on this page.");
    return;
  }
  state.tabId = tab.id;

  if (!(await backgroundIsCurrent())) showUpdateBanner();
  loadJobs();

  chrome.runtime.onMessage.addListener((msg) => {
    // Stream jobs aren't tied to the tab: show them wherever the popup opens.
    if (msg?.type === MSG.HLS_PROGRESS && !msg.target) return upsertJob(msg);
    if (msg?.type === MSG.HLS_ERROR && !msg.target) {
      if (jobs.has(msg.jobId)) upsertJob({ jobId: msg.jobId, state: 'error', error: msg.message });
      return;
    }
    // A merged stream file that failed to save isn't tied to a tab either.
    if (msg?.type === MSG.DOWNLOAD_FAILED && msg.tabId == null) return toast(msg.message, true);
    if (msg?.tabId !== state.tabId) return;
    if (msg.type === MSG.MEDIA_UPDATED) scheduleReload();
    if (msg.type === MSG.DOWNLOAD_FAILED) toast(msg.message, true);
  });

  const scanned = await ensureScanned(tab);
  if (!scanned) {
    showMessage(
      tab.url?.startsWith('file:')
        ? 'To scan local files, open chrome://extensions, click Details on Media Grabber and turn on "Allow access to file URLs".'
        : "Extensions can't run on this page.",
    );
    return;
  }
  await loadMedia();
  render();
}

init().catch((err) => {
  console.error(err);
  showMessage(`Something went wrong: ${err.message}`);
});
