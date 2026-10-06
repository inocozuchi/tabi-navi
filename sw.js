// オフライン用：アプリの部品を保存しておき、通信が無くても開けるようにする
const VERSION = 'tabinavi-v4';
const CORE = [
  './', './index.html', './app.css', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './js/main.js', './js/util.js', './js/alarm.js', './js/alarm-ui.js', './js/sounds.js', './js/home.js', './js/trip.js',
  './firebase-config.js', './js/ai.js', './js/parse.js', './js/transit.js', './js/weather.js', './js/settings.js', './js/tools.js', './js/shiori.js', './js/social.js',
  './js/imageprep.js', './js/planner.js',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 自分のファイル：通信を先に試し、だめなら保存分（更新がすぐ届くように）
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); } return r; }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // 地図の部品・ライブラリ：保存分を先に使う
  if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|esm\.sh|gstatic\.com\/firebasejs/.test(url.host + url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { if (r.ok || r.type === 'opaque') { const cp = r.clone(); caches.open(VERSION + '-lib').then((c) => c.put(req, cp)); } return r; })));
  }
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('./'))));
});
