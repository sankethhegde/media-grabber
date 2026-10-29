// Media Grabber — settings page (spec §3.7). Every change saves immediately
// to chrome.storage.local; content scripts pick it up via storage.onChanged.

import { DEFAULT_SETTINGS, getSettings } from '../utils/settings.js';
import { buildFilename } from '../utils/filename.js';

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULT_SETTINGS };

function normaliseSite(input) {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
}

let savedTimer;
async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  const el = $('saved');
  el.textContent = 'Saved';
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function renderSites() {
  const list = $('site-list');
  list.replaceChildren();
  const sites = settings.hoverDisabledSites || [];
  if (!sites.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'None. The button shows on every site.';
    list.append(li);
    return;
  }
  for (const site of sites) {
    const li = document.createElement('li');
    li.textContent = site;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = `Show the button on ${site} again`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', async () => {
      await save({ hoverDisabledSites: sites.filter((s) => s !== site) });
      renderSites();
    });
    li.append(remove);
    list.append(li);
  }
}

function renderPreview() {
  $('pattern-preview').textContent = buildFilename({
    pattern: $('filenamePattern').value || DEFAULT_SETTINGS.filenamePattern,
    site: 'example.com',
    title: 'Sunset over the bay',
    quality: '1080w',
    ext: 'jpg',
  });
}

function fill() {
  $('hoverButton').checked = settings.hoverButton !== false;
  $('minImageSize').value = settings.minImageSize;
  $('filenamePattern').value = settings.filenamePattern;
  $('askWhereToSave').checked = Boolean(settings.askWhereToSave);
  $('convertHlsToMp4').checked = Boolean(settings.convertHlsToMp4);
  $('saveSubtitles').checked = settings.saveSubtitles !== false;
  $('maxParallelSegments').value = settings.maxParallelSegments;
  renderSites();
  renderPreview();
}

async function init() {
  settings = await getSettings();
  fill();

  $('hoverButton').addEventListener('change', (e) => save({ hoverButton: e.target.checked }));
  $('askWhereToSave').addEventListener('change', (e) => save({ askWhereToSave: e.target.checked }));
  $('convertHlsToMp4').addEventListener('change', (e) => save({ convertHlsToMp4: e.target.checked }));
  $('saveSubtitles').addEventListener('change', (e) => save({ saveSubtitles: e.target.checked }));

  $('minImageSize').addEventListener('change', (e) => {
    const v = clampInt(e.target.value, 0, 10000, DEFAULT_SETTINGS.minImageSize);
    e.target.value = v;
    save({ minImageSize: v });
  });
  $('maxParallelSegments').addEventListener('change', (e) => {
    const v = clampInt(e.target.value, 1, 10, DEFAULT_SETTINGS.maxParallelSegments);
    e.target.value = v;
    save({ maxParallelSegments: v });
  });

  $('filenamePattern').addEventListener('input', renderPreview);
  $('filenamePattern').addEventListener('change', (e) => {
    const v = e.target.value.trim() || DEFAULT_SETTINGS.filenamePattern;
    e.target.value = v;
    renderPreview();
    save({ filenamePattern: v });
  });

  $('add-site').addEventListener('submit', async (e) => {
    e.preventDefault();
    const site = normaliseSite($('site-input').value);
    if (!site || !/^[a-z0-9.-]+$/.test(site)) {
      $('site-input').setCustomValidity('Enter a site like example.com');
      $('site-input').reportValidity();
      return;
    }
    $('site-input').setCustomValidity('');
    const sites = new Set(settings.hoverDisabledSites || []);
    sites.add(site);
    await save({ hoverDisabledSites: [...sites] });
    $('site-input').value = '';
    renderSites();
  });
  $('site-input').addEventListener('input', (e) => e.target.setCustomValidity(''));

  $('reset').addEventListener('click', async () => {
    settings = { ...DEFAULT_SETTINGS };
    await save({});
    fill();
  });

  // Keep in sync if the hover menu's "Hide button on this site" changes things.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      renderSites();
    }
  });
}

init();
