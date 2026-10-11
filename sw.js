// アプリ本体だけを保存してオフラインで開けるようにする（本のデータは IndexedDB に保存）
const CACHE = 'aireadergo-mobile-0.2.1';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'marked.min.js', 'pdf.min.js', 'pdf.worker.min.js',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((r) => r || fetch(e.request)));
});
