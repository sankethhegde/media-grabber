// Join segmented WebVTT (HLS subtitle playlists, segmented DASH text tracks)
// into one .vtt file. Pure; unit-tested in Node.

/**
 * Each segment starts with its own "WEBVTT" header block (often with an
 * X-TIMESTAMP-MAP line); keep one header, then every cue once — streams often
 * repeat a cue that spans a segment boundary.
 */
export function combineVtt(segments) {
  const seen = new Set();
  const cues = [];
  for (const raw of segments) {
    const text = String(raw).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const blocks = text.split(/\n{2,}/);
    for (const [i, block] of blocks.entries()) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      if (i === 0 && trimmed.startsWith('WEBVTT')) continue; // segment header
      if (/^(NOTE|STYLE|REGION)\b/.test(trimmed) && cues.length) continue; // keep only the first file's
      if (!/-->/.test(trimmed) && !/^(NOTE|STYLE|REGION)\b/.test(trimmed)) continue;
      // Ignore cue ids when de-duplicating: segments renumber them.
      const key = trimmed.replace(/^[^\n]*\n(?=[^\n]*-->)/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      cues.push(trimmed);
    }
  }
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

/** Safe language tag for a filename suffix: "en", "pt-BR", or a fallback. */
export function languageSuffix(language, name, index) {
  const tag = String(language || name || '').trim().replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return tag || `sub${index + 1}`;
}
