// Media Grabber — offscreen document: HLS download engine (spec HLS-3 to HLS-8).
// Fetches every segment (in parallel, with retries), decrypts standard
// AES-128, keeps segments in order, optionally remuxes TS → MP4 with mux.js,
// merges separate audio, and hands a blob: URL back to the service worker.
// Job state lives here, so a download survives service-worker restarts.

import { MSG, OFFSCREEN } from '../utils/messages.js';
import { ivFor, parsePlaylist, qualitiesFromMaster } from '../background/hls.js';
import { findRep, parseMpd, segmentsFor } from '../background/dash.js';
import { describeInit, fragmentStartTime, hasBox, mergeInits, parseSidx, remapFragment, splitInit } from './mp4.js';
import { combineVtt, languageSuffix } from './vtt.js';
import { REASONS } from '../utils/reasons.js';

const MAX_TOTAL_BYTES = 2 * 1024 ** 3; // spec §5: about 2 GB
const RETRY_DELAYS_MS = [1000, 2000, 4000]; // HLS-6
const PROGRESS_INTERVAL_MS = 250;
const SPEED_WINDOW_MS = 3000;
const RAW_BACKUP_SEGMENTS = 3; // keep raw TS until the remux has proved itself

const TEXT = {
  blocked: 'This site blocked the download (login or expired link). Reload the page and try again.',
  live: REASONS.live.detail,
  protected: REASONS.drm.detail,
  too_large:
    'File too large to merge in browser (limit about 2 GB). Pick a lower quality, or a shorter video.',
  empty: REASONS.empty.detail,
  key: 'The stream’s decryption key could not be loaded. Reload the page and try again.',
  convert: 'Converting to MP4 failed part-way. Turn off “Convert HLS to MP4” in Settings and try again.',
};

const SEPARATE_FILES_NOTE =
  'This stream keeps video and audio separate and they could not be combined, so they were saved as two files. ' +
  'VLC can play them together, or combine them with ffmpeg.';

const MIME_BY_EXT = {
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  ts: 'video/mp2t',
  aac: 'audio/aac',
  ac3: 'audio/ac3',
  webm: 'video/webm',
  vtt: 'text/vtt',
};

const jobs = new Map();

class JobError extends Error {
  constructor(code, message = TEXT[code] || code) {
    super(message);
    this.code = code;
  }
}

const isAbort = (err) => err?.name === 'AbortError';

// ----------------------------------------------------------- reporting

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

function speedOf(job) {
  const now = Date.now();
  job.samples = job.samples.filter((s) => now - s.t <= SPEED_WINDOW_MS);
  if (!job.samples.length) return 0;
  const span = Math.max(1000, now - job.samples[0].t);
  return Math.round((job.samples.reduce((n, s) => n + s.bytes, 0) * 1000) / span);
}

function publicJob(job) {
  return {
    jobId: job.jobId,
    title: job.title,
    label: job.label,
    state: job.state, // starting | running | paused | merging | done | error | cancelled
    done: job.done,
    total: job.total,
    bytes: job.bytes,
    speed: job.state === 'running' ? speedOf(job) : 0,
    error: job.error,
    note: job.note,
    startedAt: job.startedAt,
    pendingFiles: job.files.length, // blob URLs not yet handed back for revoking
    subtitles: job.subtitleCount || 0,
  };
}

function report(job, force = false) {
  const now = Date.now();
  if (!force && now - job.lastReport < PROGRESS_INTERVAL_MS) return;
  job.lastReport = now;
  broadcast({ type: MSG.HLS_PROGRESS, ...publicJob(job) });
}

// ------------------------------------------------------------- network

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function request(job, url, range, as = 'bytes') {
  const headers = {};
  if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
  let res;
  try {
    // Cookies go only to the media's own origin (spec §5).
    res = await fetch(url, { credentials: 'include', headers, signal: job.controller.signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new Error(`network error (${err.message})`);
  }
  if (res.status === 401 || res.status === 403) throw new JobError('blocked');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (as === 'text') return res.text();
  let bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignores Range sends the whole file; cut out our piece.
  if (range && res.status === 200 && bytes.length >= range.offset + range.length) {
    bytes = bytes.slice(range.offset, range.offset + range.length);
  }
  return bytes;
}

async function withRetry(job, fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isAbort(err) || err instanceof JobError || attempt >= RETRY_DELAYS_MS.length) throw err;
      await sleep(RETRY_DELAYS_MS[attempt], job.controller.signal);
    }
  }
}

async function fetchPlaylist(job, url) {
  const text = await withRetry(job, () => request(job, url, null, 'text'));
  return parsePlaylist(text, url);
}

// HLS-4: standard AES-128 with a key the page itself loads.
function cryptoKey(job, uri) {
  if (!job.keys.has(uri)) {
    const promise = withRetry(job, () => request(job, uri)).then((raw) => {
      if (raw.length !== 16) throw new JobError('key');
      return crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
    });
    promise.catch(() => job.keys.delete(uri)); // let a retry fetch it again
    job.keys.set(uri, promise);
  }
  return job.keys.get(uri);
}

async function fetchSegment(job, seg) {
  return withRetry(job, async () => {
    let bytes = await request(job, seg.url, seg.byteRange);
    if (seg.key) {
      const key = await cryptoKey(job, seg.key.uri);
      bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, key, bytes));
    }
    return bytes;
  });
}

function checkPlayable(playlist) {
  if (playlist.encryption === 'drm') throw new JobError('protected');
  if (!playlist.endList) throw new JobError('live'); // HLS-7
  if (!playlist.segments.length) throw new JobError('empty');
}

// -------------------------------------------------------------- tracks

function timescalesOf(init) {
  return new Map(describeInit(init).map((t) => [t.id, t.timescale]));
}

function makeTrack(kind, playlist) {
  const container = playlist.container;
  const rawExt = { ts: 'ts', aac: 'aac', ac3: 'ac3', webm: 'webm', fmp4: kind === 'audio' ? 'm4a' : 'mp4' }[container] || 'ts';
  return {
    kind,
    playlist,
    container,
    rawExt,
    segments: playlist.segments,
    next: 0, // next segment index to hand to the sink, in order
    ready: new Map(), // finished but waiting for earlier segments
    init: null, // fMP4 init segment (EXT-X-MAP)
    timescales: null,
    raw: [], // Blobs, in order
    keepRaw: true,
    mux: null, // mux.js transmuxer
    muxInit: null,
    muxParts: [],
    muxFailed: false,
    goodMuxSegments: 0,
    fragments: [], // [{ time, blob }] when audio and video are merged later
  };
}

function setupMux(job, track) {
  if (!globalThis.muxjs?.mp4?.Transmuxer) return;
  const tm = new globalThis.muxjs.mp4.Transmuxer({ remux: true });
  tm.on('data', (segment) => {
    if (!track.muxInit) {
      track.muxInit = segment.initSegment.slice();
      track.timescales = timescalesOf(track.muxInit);
    }
    const data = segment.data;
    if (job.merge) track.fragments.push({ time: fragmentStartTime(data, track.timescales), blob: new Blob([data]) });
    else track.muxParts.push(new Blob([data]));
    track.sawData = true;
  });
  track.mux = tm;
}

// Hand a finished segment to its track, in playlist order.
function consume(job, track, bytes, seg) {
  if (track.container === 'fmp4') {
    // A self-contained file (DASH BaseURL only): its own init comes first.
    if (seg?.wholeFile && !track.init) {
      const parts = splitInit(bytes);
      if (!parts) throw new JobError('format', 'This video file is not in a format that can be combined.');
      track.init = parts.init;
      track.timescales = timescalesOf(track.init);
      bytes = parts.rest;
    }
    if (job.merge) track.fragments.push({ time: fragmentStartTime(bytes, track.timescales), blob: new Blob([bytes]) });
    else track.raw.push(new Blob([bytes]));
    return;
  }
  if (track.container === 'webm') {
    track.raw.push(new Blob([bytes]));
    return;
  }
  if (track.keepRaw) track.raw.push(new Blob([bytes]));
  if (!track.mux || track.muxFailed) return;
  try {
    track.sawData = false;
    track.mux.push(bytes);
    track.mux.flush();
    if (!track.sawData && !track.muxInit) throw new Error('no output');
    if (++track.goodMuxSegments >= RAW_BACKUP_SEGMENTS && track.keepRaw && job.dropRawWhenMuxed) {
      track.keepRaw = false;
      track.raw = [];
    }
  } catch {
    track.muxFailed = true;
    track.mux = null;
    if (!track.keepRaw) throw new JobError('convert');
  }
}

function drain(job, track) {
  while (track.ready.has(track.next)) {
    const bytes = track.ready.get(track.next);
    track.ready.delete(track.next);
    consume(job, track, bytes, track.segments[track.next]);
    track.next++;
  }
}

// ----------------------------------------------------------- scheduling

function wake(job) {
  const waiters = job.waiters;
  job.waiters = [];
  waiters.forEach((resolve) => resolve());
}

function nextEvent(job) {
  return new Promise((resolve) => job.waiters.push(resolve));
}

function pause(job, err) {
  if (job.state !== 'running') return;
  job.state = 'paused';
  job.error = err instanceof JobError ? err.message : `A segment failed after 3 retries (${err.message}).`;
  report(job, true);
}

function resume(job) {
  if (job.state !== 'paused') return;
  job.queue.unshift(...job.failed);
  job.failed = [];
  job.error = null;
  job.state = 'running';
  report(job, true);
  wake(job);
}

// HLS-6: up to N segments in flight; each fails over to a paused job only
// after its 3 retries. Downloads stay at most `window` segments ahead of the
// oldest unfinished one, so memory stays bounded.
async function runTasks(job, tasks) {
  job.queue = tasks;
  const window = Math.max(job.parallel * 4, 12);

  const worker = async () => {
    for (;;) {
      if (job.state === 'cancelled' || job.fatal) return;
      if (job.state === 'paused') {
        await nextEvent(job);
        continue;
      }
      const i = job.queue.findIndex((t) => t.index - t.track.next < window);
      if (i < 0) {
        if (!job.queue.length && !job.inFlight) return;
        await nextEvent(job);
        continue;
      }
      const [task] = job.queue.splice(i, 1);
      job.inFlight++;
      try {
        const bytes = await fetchSegment(job, task.seg);
        job.bytes += bytes.length;
        job.samples.push({ t: Date.now(), bytes: bytes.length });
        if (job.bytes > MAX_TOTAL_BYTES) throw new JobError('too_large');
        task.track.ready.set(task.index, bytes);
        drain(job, task.track);
        job.done++;
        report(job);
      } catch (err) {
        if (isAbort(err) || job.state === 'cancelled') return;
        if (err.code === 'too_large' || err.code === 'convert') {
          job.fatal = err;
          job.controller.abort();
        } else {
          job.failed.push(task);
          pause(job, err);
        }
      } finally {
        job.inFlight--;
        wake(job);
      }
    }
  };

  await Promise.all(Array.from({ length: job.parallel }, worker));
  if (job.fatal) throw job.fatal;
  if (job.state === 'cancelled') throw new DOMException('Aborted', 'AbortError');
}

// --------------------------------------------------------------- output

function rawFile(track, suffix) {
  const parts = track.fragments.length ? track.fragments.map((f) => f.blob) : track.raw;
  // fMP4 and WebM DASH need their init segment in front.
  return { blob: new Blob(track.init ? [track.init, ...parts] : parts), ext: track.rawExt, suffix };
}

function asFmp4(track) {
  if (track.container === 'fmp4') return { init: track.init, fragments: track.fragments };
  if (track.muxInit && !track.muxFailed) return { init: track.muxInit, fragments: track.fragments };
  return null;
}

async function assemble(job, tracks, wantMp4) {
  const [video, audio] = tracks;

  if (!audio) {
    if (video.container === 'fmp4') return { files: [rawFile(video, '')] };
    if (wantMp4 && video.muxInit && !video.muxFailed) {
      return { files: [{ blob: new Blob([video.muxInit, ...video.muxParts]), ext: 'mp4', suffix: '' }] };
    }
    const note = wantMp4 && video.container === 'ts' ? 'This stream could not be converted to MP4, so it was saved as .ts.' : null;
    return { files: [rawFile(video, '')], note };
  }

  // HLS-5: separate audio. Combine into one MP4 when both sides are fMP4.
  const v = asFmp4(video);
  const a = asFmp4(audio);
  if (v && a) {
    try {
      const videoTracks = describeInit(v.init);
      if (videoTracks.some((t) => t.handler === 'soun')) {
        // The video already carries audio; the separate rendition isn't needed.
        return { files: [{ blob: new Blob([v.init, ...v.fragments.map((f) => f.blob)]), ext: 'mp4', suffix: '' }] };
      }
      const { init, maps } = mergeInits([
        { init: v.init, handlers: ['vide'] },
        { init: a.init, handlers: ['soun'] },
      ]);
      if (!maps[0].size || !maps[1].size) throw new Error('missing track');
      // Some streams start their timeline later than 0 (Apple's at ~10 s). Move
      // both tracks back by the same amount: the file starts at 0, sync is kept.
      const start = Math.min(v.fragments[0]?.time ?? 0, a.fragments[0]?.time ?? 0);
      const shiftsFor = (timescales) => new Map([...timescales].map(([id, ts]) => [id, start * ts]));
      const sources = [
        { fragments: v.fragments, map: maps[0], shifts: shiftsFor(video.timescales) },
        { fragments: a.fragments, map: maps[1], shifts: shiftsFor(audio.timescales) },
      ];
      // Interleave by decode time so players can stream the file front to back.
      const all = sources
        .flatMap((s) => s.fragments.map((f) => ({ ...f, map: s.map, shifts: s.shifts })))
        .sort((x, y) => x.time - y.time);
      const parts = [init];
      for (const f of all) {
        if (job.state === 'cancelled') throw new DOMException('Aborted', 'AbortError');
        const bytes = new Uint8Array(await f.blob.arrayBuffer());
        // A plain (non-fragmented) MP4 can't be interleaved this way.
        if (!hasBox(bytes, 'moof')) throw new Error('not fragmented');
        parts.push(new Blob([remapFragment(bytes, f.map, f.shifts)]));
      }
      return { files: [{ blob: new Blob(parts), ext: 'mp4', suffix: '' }] };
    } catch (err) {
      if (isAbort(err)) throw err;
      /* fall back to two files */
    }
  }
  return { files: [rawFile(video, '_video'), rawFile(audio, '_audio')], note: SEPARATE_FILES_NOTE };
}

// ----------------------------------------------------------------- jobs

// HLS: media playlists for the video (and separate audio) rendition.
async function hlsTracks(job) {
  let playlist = await fetchPlaylist(job, job.playlistUrl);
  if (playlist.kind === 'master') {
    if (playlist.drm) throw new JobError('protected');
    const best = qualitiesFromMaster(playlist)[0];
    if (!best) throw new JobError('empty');
    job.audioUrl = job.audioUrl || best.audioUrl;
    playlist = await fetchPlaylist(job, best.url);
  }
  checkPlayable(playlist);
  const tracks = [makeTrack('video', playlist)];
  if (job.audioUrl) {
    const audioPlaylist = await fetchPlaylist(job, job.audioUrl);
    checkPlayable(audioPlaylist);
    tracks.push(makeTrack('audio', audioPlaylist));
  }
  return tracks;
}

// DASH: one segment list per chosen representation, shaped like an HLS
// media playlist so the rest of the pipeline is shared.
async function dashPlaylist(job, mpd, repId) {
  const found = findRep(mpd, repId);
  if (!found) throw new JobError('empty', 'That quality is no longer in the manifest. Reopen the popup and try again.');
  const { rep, period } = found;
  if (rep.protected) throw new JobError('protected');
  const info = segmentsFor(rep, period);
  let { segments, init } = info;
  if (info.index) {
    // SegmentBase: read the sidx to find each subsegment's byte range.
    const end = info.index.range.offset + info.index.range.length;
    const head = await withRetry(job, () => request(job, info.index.url, { offset: 0, length: end }));
    const sidx = parseSidx(head.slice(info.index.range.offset), info.index.range.offset);
    init = { url: info.index.url, byteRange: info.index.initRange || { offset: 0, length: sidx ? sidx.initEnd : info.index.range.offset } };
    segments = sidx
      ? sidx.segments.map((s, i) => ({ url: info.index.url, byteRange: { offset: s.offset, length: s.length }, duration: s.duration, sequence: i + 1 }))
      : [{ url: info.index.url, byteRange: null, duration: period.duration || 0, sequence: 1, wholeFile: true }];
    if (!sidx) init = null;
  }
  return {
    container: info.container,
    endList: true,
    encryption: 'none',
    segments: segments.map((s) => ({ ...s, key: null, map: init })),
  };
}

async function dashTracks(job) {
  const text = await withRetry(job, () => request(job, job.playlistUrl, null, 'text'));
  const mpd = parseMpd(text, job.playlistUrl);
  if (mpd.live) throw new JobError('live');
  const tracks = [];
  if (job.dash.videoId) tracks.push(makeTrack('video', await dashPlaylist(job, mpd, job.dash.videoId)));
  if (job.dash.audioId) tracks.push(makeTrack(tracks.length ? 'audio' : 'video', await dashPlaylist(job, mpd, job.dash.audioId)));
  if (!tracks.length || !tracks[0].segments.length) throw new JobError('empty');
  job.mpd = mpd;
  return tracks;
}

// #5: subtitles (WebVTT) saved next to the video. Never fails the job.
async function fetchSubtitles(job) {
  const files = [];
  const failures = [];
  const list = job.options.saveSubtitles === false ? [] : job.subtitles || [];
  for (const [i, sub] of list.entries()) {
    try {
      let segments;
      if (job.kind === 'dash') {
        const found = job.mpd && findRep(job.mpd, sub.id);
        if (!found) continue;
        const info = segmentsFor(found.rep, found.period);
        if (info.container !== 'vtt') continue;
        segments = info.segments;
      } else {
        const playlist = await fetchPlaylist(job, sub.url);
        segments = playlist.segments;
      }
      const texts = [];
      for (const seg of segments) {
        texts.push(new TextDecoder().decode(await withRetry(job, () => request(job, seg.url, seg.byteRange))));
      }
      const suffix = `.${languageSuffix(sub.language, sub.name, i)}`;
      const unique = files.some((f) => f.suffix === suffix) ? `${suffix}-${i + 1}` : suffix;
      files.push({ blob: new Blob([combineVtt(texts)]), ext: 'vtt', suffix: unique });
    } catch (err) {
      if (isAbort(err)) throw err;
      failures.push(sub.language || sub.name || `track ${i + 1}`);
    }
  }
  return { files, note: failures.length ? `Some subtitles could not be saved (${failures.join(', ')}).` : null };
}

async function runJob(job) {
  try {
    const tracks = job.kind === 'dash' ? await dashTracks(job) : await hlsTracks(job);
    job.merge = tracks.length > 1;
    // Separate audio can only be combined as MP4, so it is converted either way.
    const wantMp4 = Boolean(job.options.convertToMp4) || job.merge;
    job.dropRawWhenMuxed = true;

    for (const track of tracks) {
      const map = track.segments[0]?.map;
      if (map && (track.container === 'fmp4' || track.container === 'webm')) {
        track.init = await withRetry(job, () => request(job, map.url, map.byteRange));
        if (track.container === 'fmp4') track.timescales = timescalesOf(track.init);
      } else if (wantMp4 && (track.container === 'ts' || track.container === 'aac')) {
        setupMux(job, track);
      }
    }

    // One task per segment, interleaved by start time across tracks.
    const tasks = [];
    for (const track of tracks) {
      let t = 0;
      track.segments.forEach((seg, index) => {
        tasks.push({ track, index, seg, start: t });
        t += seg.duration;
      });
    }
    tasks.sort((x, y) => x.start - y.start);
    job.total = tasks.length;
    job.state = 'running';
    report(job, true);

    await runTasks(job, tasks);

    job.state = 'merging';
    report(job, true);
    const { files, note } = await assemble(job, tracks, wantMp4);
    const subtitles = await fetchSubtitles(job);
    files.push(...subtitles.files);
    const notes = [note, subtitles.note].filter(Boolean);
    job.files = files.map((f) => {
      const typed = new Blob([f.blob], { type: MIME_BY_EXT[f.ext] || 'application/octet-stream' });
      return { blobUrl: URL.createObjectURL(typed), ext: f.ext, suffix: f.suffix, size: typed.size };
    });
    job.note = notes.join(' ') || null;
    job.subtitleCount = subtitles.files.length;
    job.state = 'done';
    report(job, true);
    broadcast({
      type: MSG.HLS_DONE,
      jobId: job.jobId,
      files: job.files,
      filenameBase: job.options.filenameBase,
      saveAs: Boolean(job.options.saveAs),
      note: job.note,
    });
  } catch (err) {
    if (isAbort(err) || job.state === 'cancelled') {
      job.state = 'cancelled';
      job.error = null;
      report(job, true);
      return;
    }
    job.state = 'error';
    job.error = err instanceof JobError ? err.message : `Download failed: ${err.message}`;
    report(job, true);
    broadcast({ type: MSG.HLS_ERROR, jobId: job.jobId, code: err.code || 'failed', message: job.error });
  } finally {
    job.queue = [];
    job.failed = [];
    wake(job);
  }
}

function startJob(msg) {
  const job = {
    jobId: msg.jobId,
    title: msg.title || 'Stream',
    label: msg.label || '',
    playlistUrl: msg.playlistUrl,
    audioUrl: msg.audioUrl || null,
    options: msg.options || {},
    kind: msg.kind === 'dash' ? 'dash' : 'hls',
    dash: msg.dash || null, // { videoId, audioId }
    subtitles: Array.isArray(msg.subtitles) ? msg.subtitles : [],
    parallel: Math.min(10, Math.max(1, Number(msg.options?.parallel) || 6)),
    controller: new AbortController(),
    state: 'starting',
    done: 0,
    total: 0,
    bytes: 0,
    samples: [],
    keys: new Map(),
    queue: [],
    failed: [],
    waiters: [],
    inFlight: 0,
    error: null,
    note: null,
    files: [],
    startedAt: Date.now(),
    lastReport: 0,
  };
  jobs.set(job.jobId, job);
  report(job, true);
  runJob(job);
}

function cancelJob(job) {
  if (['done', 'error', 'cancelled'].includes(job.state)) return;
  job.state = 'cancelled';
  job.controller.abort(); // stops every in-flight request immediately
  report(job, true);
  wake(job);
}

function revoke(blobUrl) {
  URL.revokeObjectURL(blobUrl);
  for (const [id, job] of jobs) {
    job.files = job.files.filter((f) => f.blobUrl !== blobUrl);
    if (job.state === 'done' && !job.files.length && job.dismissed) jobs.delete(id);
  }
}

// -------------------------------------------------------------- routing

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== OFFSCREEN || sender.id !== chrome.runtime.id) return false;
  const job = msg.jobId ? jobs.get(msg.jobId) : null;
  switch (msg.type) {
    case MSG.HLS_START:
      if (!jobs.has(msg.jobId)) startJob(msg);
      sendResponse({ ok: true });
      break;
    case MSG.CANCEL:
      if (job) cancelJob(job);
      sendResponse({ ok: Boolean(job) });
      break;
    case MSG.RETRY:
      if (job) resume(job);
      sendResponse({ ok: Boolean(job) });
      break;
    case MSG.DISMISS:
      if (job && job.state !== 'running' && job.state !== 'merging' && job.state !== 'starting') {
        job.dismissed = true;
        if (!job.files.length) jobs.delete(job.jobId);
      }
      sendResponse({ ok: true });
      break;
    case MSG.HLS_JOBS:
      sendResponse({ jobs: [...jobs.values()].filter((j) => msg.includeDismissed || !j.dismissed).map(publicJob) });
      break;
    case MSG.HLS_REVOKE:
      revoke(msg.blobUrl);
      sendResponse({ ok: true, active: [...jobs.values()].some((j) => j.files.length || !['done', 'error', 'cancelled'].includes(j.state)) });
      break;
    default:
      return false;
  }
  return false;
});
