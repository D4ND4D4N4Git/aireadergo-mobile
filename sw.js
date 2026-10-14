// アプリ本体だけを保存してオフラインで開けるようにする（本のデータは IndexedDB に保存）
// 通信できるときは常に最新の本体を取りに行き、できないときだけ保存した本体を使う
const CACHE = 'aireadergo-mobile-0.4.0';
const FILES = ['./', 'index.html', 'manifest.webmanifest',
  'marked.min.js', 'pdf.min.js', 'pdf.worker.min.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(FILES.map((f) => fetch(new Request(f, { cache: 'reload' })).then((r) => { if (!r.ok) throw new Error(f); return c.put(f, r); }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const r = await fetch(e.request, { cache: 'no-cache', signal: ctl.signal });
      clearTimeout(timer);
      if (r.ok) c.put(e.request, r.clone());   // 次にオフラインで開くとき用
      return r;
    } catch (err) {
      const hit = await c.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') { const idx = await c.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
