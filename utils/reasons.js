// Why something can't be downloaded, in plain words. One place for every
// "not downloadable" explanation so the popup, the hover button and download
// errors all say the same thing. content/content-script.js keeps a copy of
// SITE_RULES and the DRM text (content scripts can't import modules).
//
// A reason is { short, detail }: `short` fits a badge or a row label, and
// `detail` explains what happened and what (if anything) the user can do.

// Sites whose videos can't be saved, with the reason. Only applied to videos
// that are already streamed or protected, never to ordinary files or images.
export const SITE_RULES = [
  {
    hosts: /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/,
    short: 'Not supported on YouTube',
    detail:
      'YouTube scrambles its video addresses so they only play in its own player, and Media Grabber doesn’t work ' +
      'around that. For videos you uploaded yourself, use YouTube Studio → Content → ⋮ → Download.',
  },
  ...[
    ['netflix.com', 'Netflix'],
    ['primevideo.com', 'Prime Video'],
    ['disneyplus.com', 'Disney+'],
    ['hotstar.com', 'Disney+ Hotstar'],
    ['hulu.com', 'Hulu'],
    ['max.com', 'Max'],
    ['hbomax.com', 'HBO Max'],
    ['peacocktv.com', 'Peacock'],
    ['paramountplus.com', 'Paramount+'],
    ['tv.apple.com', 'Apple TV+'],
    ['crunchyroll.com', 'Crunchyroll'],
    ['spotify.com', 'Spotify'],
    ['jiocinema.com', 'JioCinema'],
    ['zee5.com', 'ZEE5'],
    ['sonyliv.com', 'SonyLIV'],
  ].map(([host, name]) => ({
    hosts: new RegExp(`(^|\\.)${host.replace(/\./g, '\\.')}$`),
    short: 'Protected (DRM)',
    detail: `${name} protects its videos with DRM (copy protection), so they can only be played in its own player and can’t be saved.`,
  })),
];

export const REASONS = {
  drm: {
    short: 'Protected (DRM)',
    detail: 'This video is encrypted with DRM (copy protection), so it can only be played in the site’s own player and can’t be saved.',
  },
  noStream: {
    short: 'No downloadable stream found',
    detail:
      'This video plays through the site’s own player and no HLS or DASH playlist has been seen yet. Play it for a few ' +
      'seconds, then reopen Media Grabber. If it still doesn’t appear, the site delivers the video in a way that can’t be saved.',
  },
  live: {
    short: 'Live stream',
    detail: 'This is a live broadcast with no fixed end, so it can’t be saved as one file (live recording isn’t supported in v1).',
  },
  useStream: {
    short: 'Download its stream',
    detail: 'This video plays from a stream. Download it from its stream entry in the list, or with the button on the video.',
  },
  analyzing: {
    short: 'Reading stream…',
    detail: 'Media Grabber is still reading this stream’s playlist. Try again in a moment.',
  },
  empty: {
    short: 'Nothing to download',
    detail: 'The playlist has no video segments in it.',
  },
};

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/** Site-specific reason for a page URL, or null. */
export function siteReason(pageUrl) {
  const host = hostOf(pageUrl);
  const rule = host && SITE_RULES.find((r) => r.hosts.test(host));
  return rule ? { short: rule.short, detail: rule.detail } : null;
}

/** Explain a failure to read a stream playlist ("HTTP 403", "not a playlist", …). */
export function streamErrorReason(error) {
  const text = String(error || '');
  const status = Number((/HTTP (\d{3})/.exec(text) || [])[1]);
  let detail;
  if (status === 401 || status === 403) {
    detail = `The site refused access to the stream’s playlist (HTTP ${status}). The link may have expired or need you to be signed in — reload the page and try again.`;
  } else if (status === 404 || status === 410) {
    detail = `The stream’s playlist no longer exists (HTTP ${status}). Reload the page and play the video again.`;
  } else if (status >= 500) {
    detail = `The site’s server had a problem (HTTP ${status}). Try again later.`;
  } else if (/abort|timeout/i.test(text)) {
    detail = 'The site didn’t answer in time. Check your connection, reload the page and try again.';
  } else if (/not a (playlist|DASH manifest|HLS playlist)/i.test(text)) {
    detail = 'A link that looked like a stream turned out not to be a playlist Media Grabber can read.';
  } else if (/fetch|network/i.test(text)) {
    detail = 'The stream’s playlist couldn’t be reached. Check your connection, reload the page and try again.';
  } else {
    detail = `The stream’s playlist couldn’t be read (${text || 'unknown error'}). Reload the page and try again.`;
  }
  return { short: 'Couldn’t read the stream', detail };
}

/**
 * Why an item can't be downloaded, or null if it can. `pageUrl` lets
 * site-specific explanations (YouTube, streaming services) apply.
 */
export function itemBlockReason(item, pageUrl = item?.pageUrl) {
  if (!item) return null;
  const site = siteReason(pageUrl);
  switch (item.type) {
    case 'protected':
      return site || REASONS.drm;
    case 'streamed':
      if (site) return site;
      if (item.streamDetected) return item.streamReason || REASONS.useStream;
      return REASONS.noStream;
    case 'hls':
    case 'dash':
      if (item.analyzing) return REASONS.analyzing;
      if (item.live) return REASONS.live;
      if (item.streamError) return streamErrorReason(item.streamError);
      return null;
    default:
      return null;
  }
}

// chrome.downloads interrupt reasons → what to tell the user.
const DOWNLOAD_ERRORS = {
  SERVER_FORBIDDEN: 'This site blocked the download (login or expired link). Reload the page and try again.',
  SERVER_UNAUTHORIZED: 'This site blocked the download (login or expired link). Reload the page and try again.',
  SERVER_BAD_CONTENT: 'The file is no longer available on the site (it may have moved or expired). Reload the page and try again.',
  SERVER_CERT_PROBLEM: 'The site’s security certificate isn’t valid, so the browser refused to download from it.',
  SERVER_NO_RANGE: 'The site stopped the download part-way. Try again.',
  SERVER_FAILED: 'The site’s server failed while sending the file. Try again later.',
  SERVER_CONTENT_LENGTH_MISMATCH: 'The site sent an incomplete file. Try again.',
  SERVER_CROSS_ORIGIN_REDIRECT: 'The site redirected the download somewhere it isn’t allowed to go.',
  NETWORK_FAILED: 'The connection dropped while downloading. Check your connection and try again.',
  NETWORK_TIMEOUT: 'The site took too long to respond. Try again.',
  NETWORK_DISCONNECTED: 'You went offline during the download. Reconnect and try again.',
  NETWORK_SERVER_DOWN: 'The site’s server is down. Try again later.',
  NETWORK_INVALID_REQUEST: 'The browser couldn’t request this file.',
  FILE_NO_SPACE: 'Your disk is full. Free up some space and try again.',
  FILE_ACCESS_DENIED: 'Chrome isn’t allowed to save to your download folder. Check the folder in Chrome’s download settings.',
  FILE_NAME_TOO_LONG: 'The file name is too long for your system. Shorten the filename pattern in Settings.',
  FILE_TOO_LARGE: 'The file is too large for your disk’s file system.',
  FILE_VIRUS_INFECTED: 'Your antivirus blocked the file.',
  FILE_BLOCKED: 'Your system’s security settings blocked the file.',
  FILE_SECURITY_CHECK_FAILED: 'Your system’s security check failed for this file.',
  FILE_TRANSIENT_ERROR: 'The file couldn’t be written right now. Try again.',
  FILE_FAILED: 'The file couldn’t be saved to disk.',
  CRASH: 'The browser closed before the download finished.',
};

/** Message for a chrome.downloads error code, or null for user cancels. */
export function downloadErrorMessage(code) {
  if (!code || code === 'USER_CANCELED' || code === 'USER_SHUTDOWN') return null;
  return DOWNLOAD_ERRORS[code] || `The download failed (${code}).`;
}
