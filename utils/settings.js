// Settings stored in chrome.storage.local (spec §3.7). The options page that
// edits them arrives in Phase 2; until then these defaults apply.

export const DEFAULT_SETTINGS = Object.freeze({
  hoverButton: true,              // Phase 2
  hoverDisabledSites: [],         // Phase 2
  minImageSize: 0,                // px, longest side; 0 = list everything
  filenamePattern: '{site}_{title}_{quality}.{ext}',
  askWhereToSave: false,          // saveAs: true
  convertHlsToMp4: false,         // HLS-8
  maxParallelSegments: 6,         // HLS-6, 1–10
  saveSubtitles: true,            // WebVTT next to downloaded streams
});

export async function getSettings() {
  const stored = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}
