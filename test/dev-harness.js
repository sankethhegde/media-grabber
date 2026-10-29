// Dev harness: runs the real service worker and content script together in
// an ordinary page, with an in-memory stand-in for the chrome.* APIs they use.
// Useful for checking logic without reloading the unpacked extension.
//
// Usage from the DevTools console on http://localhost:8080/test/ :
//   await import('/test/dev-harness.js').then((m) => m.start())
// Then: harness.getMedia(), harness.download(itemId, qualityId),
//       harness.web(url, status, headers), harness.downloads

export async function start({ shimAnimationFrame = false } = {}) {
  if (shimAnimationFrame) window.requestAnimationFrame = (cb) => setTimeout(cb, 16);

  const L = { sw: [], cs: [], web: [], storage: [] };
  const session = {};
  const local = {};
  const downloads = [];
  const mk = (arr) => ({ addListener: (f) => arr.push(f), removeListener() {} });
  const dispatch = (arr, msg, sender) =>
    new Promise((res) => {
      for (const f of arr) if (f(msg, sender, res) === true) return;
      res(undefined);
    });

  let loadingWorker = true;
  window.chrome = {
    runtime: {
      id: 'dev-harness',
      onMessage: { addListener: (f) => (loadingWorker ? L.sw : L.cs).push(f), removeListener() {} },
      sendMessage: (msg) => dispatch(L.sw, msg, { tab: { id: 1, url: location.href, title: document.title }, frameId: 0 }),
      openOptionsPage() {},
    },
    storage: {
      session: {
        get: async (k) => ({ [k]: session[k] && structuredClone(session[k]) }),
        set: async (o) => { for (const k in o) session[k] = structuredClone(o[k]); },
        remove: async (k) => { delete session[k]; },
      },
      local: {
        get: async (k) => ({ [k]: local[k] }),
        set: async (o) => {
          Object.assign(local, o);
          if (o.settings) L.storage.forEach((f) => f({ settings: { newValue: o.settings } }, 'local'));
        },
      },
      onChanged: mk(L.storage),
    },
    webRequest: { onHeadersReceived: mk(L.web) },
    downloads: { download: async (o) => { downloads.push(o); return downloads.length; }, onChanged: mk([]) },
    tabs: { onUpdated: mk([]), onRemoved: mk([]), sendMessage: (_tabId, msg) => dispatch(L.cs, msg, {}) },
  };

  await import(`/background/service-worker.js?${Date.now()}`);
  loadingWorker = false;
  (0, eval)(await (await fetch(`/content/content-script.js?${Date.now()}`)).text());

  const harness = {
    downloads,
    getMedia: () => dispatch(L.sw, { type: 'GET_MEDIA', tabId: 1 }, {}),
    download: (itemId, qualityId) => dispatch(L.sw, { type: 'DOWNLOAD', tabId: 1, itemId, qualityId }, {}),
    web: (url, statusCode, headers) =>
      L.web[0]({
        tabId: 1,
        frameId: 0,
        statusCode,
        url,
        responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
      }),
    setSettings: (settings) => window.chrome.storage.local.set({ settings }),
  };
  window.harness = harness;
  return harness;
}
