// Safe filename builder (spec §3.6). Pure functions, no chrome.* calls, so it
// can be unit-tested in plain Node.

export const MAX_FILENAME_LENGTH = 150;

const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/mp2t': 'ts',
};

const KNOWN_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff',
  'mp4', 'webm', 'mov', 'm4v', 'ts',
]);

/** Remove characters Windows/Chrome reject and tidy whitespace. */
export function sanitize(text) {
  let s = String(text ?? '')
    .replace(ILLEGAL_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // Chrome rejects names that start or end with dots/spaces.
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s;
}

/** "www.example.co.uk" → "example.co.uk"; falls back to "media". */
export function siteFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '');
    return host || 'media';
  } catch {
    return 'media';
  }
}

/** Best guess at a file extension from a URL (or data: MIME type). */
export function extFromUrl(url, fallback = 'jpg') {
  if (typeof url !== 'string') return fallback;
  if (url.startsWith('data:')) {
    const mime = url.slice(5, url.search(/[;,]/)).toLowerCase();
    return MIME_TO_EXT[mime] || fallback;
  }
  try {
    const { pathname, searchParams } = new URL(url);
    const last = pathname.split('/').pop() || '';
    const dot = last.lastIndexOf('.');
    if (dot > 0) {
      const ext = last.slice(dot + 1).toLowerCase();
      if (KNOWN_EXTS.has(ext)) return ext === 'jpeg' ? 'jpg' : ext;
    }
    // CDNs often put the format in the query string (?fm=webp, ?format=png).
    const fmt = (searchParams.get('fm') || searchParams.get('format') || '').toLowerCase();
    if (KNOWN_EXTS.has(fmt)) return fmt === 'jpeg' ? 'jpg' : fmt;
  } catch {
    /* not a parseable URL */
  }
  return fallback;
}

export function extFromMime(mime, fallback = 'jpg') {
  return MIME_TO_EXT[String(mime || '').split(';')[0].trim().toLowerCase()] || fallback;
}

/**
 * Fill the pattern's {site} {title} {quality} {ext} tokens, then sanitise and
 * cap the result at MAX_FILENAME_LENGTH characters (extension included).
 */
export function buildFilename({ pattern, site, title, quality, ext }) {
  const tokens = {
    site: sanitize(site) || 'media',
    title: sanitize(title),
    quality: sanitize(quality),
    ext: sanitize(ext).toLowerCase() || 'bin',
  };
  const filled = String(pattern || '{site}_{title}_{quality}.{ext}')
    .replace(/\{(site|title|quality|ext)\}/g, (_, key) => tokens[key]);

  // Split off the extension so capping never cuts it.
  let name = filled;
  const extension = tokens.ext;
  const dot = filled.lastIndexOf('.');
  if (dot > 0 && filled.slice(dot + 1).toLowerCase() === tokens.ext) {
    name = filled.slice(0, dot);
  }
  // Empty tokens leave stray separators ("site__1080w"); tidy them.
  name = sanitize(name.replace(/([_\-\s])[_\-\s]+/g, '$1').replace(/^[_\-\s]+|[_\-\s]+$/g, ''));
  if (!name) name = tokens.site;

  const room = MAX_FILENAME_LENGTH - extension.length - 1;
  if (name.length > room) name = sanitize(name.slice(0, room));
  return `${name}.${extension}`;
}

/** Subfolder for bulk downloads: {site}_{yyyy-mm-dd}. */
export function bulkFolderName(site, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return sanitize(`${sanitize(site) || 'media'}_${day}`);
}
