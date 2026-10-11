// PDF圧縮の Service Worker
// 公開ファイルを更新したら VERSION を上げる。古いキャッシュは activate 時に削除される
const VERSION = 'v1.0.0';
const APP_CACHE = `pdfcomp-${VERSION}`;
const FONT_CACHE = 'pdfcomp-fonts';

// オフラインで動かすために事前に保存するファイル
// 圧縮エンジン（gs.wasm、約 15 MB）はここに入れず、最初に使ったときに保存する（見るだけの人に読ませないため）
const ASSETS = [
  './',
  './index.html',
  './js/app.js',
  './js/options.js',
  './js/zip.js',
  './js/worker.js',
  './vendor/ghostpdl-wasm/gs.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith('pdfcomp-') && k !== APP_CACHE && k !== FONT_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Google Fonts: 一度取得したらキャッシュから返す（オフライン時は代替フォントで表示される）
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res.ok || res.type === 'opaque') c.put(req, res.clone());
          return res;
        } catch (e) {
          return new Response('', { status: 503 });
        }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 圧縮エンジン（gs.wasm）: 大きいのでキャッシュを優先する。エンジンを更新したときは VERSION を上げて入れ替える
  if (url.pathname.endsWith('/gs.wasm')) {
    event.respondWith(
      caches.open(APP_CACHE).then(async c => {
        const hit = await c.match(req, { ignoreSearch: true });
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) c.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // ページ本体: ネットワークを優先し、オフライン時は保存した index.html を返す
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(APP_CACHE).then(c => c.put('./index.html', copy)); }
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // JS・アイコンなど: ページ本体と同じくネットワークを優先し、オフライン時だけキャッシュを返す
  // （キャッシュを先に返すと、更新直後に新しい index.html と古い JS が組み合わさり、ボタンが動かないことがある）
  event.respondWith(
    caches.open(APP_CACHE).then(async c => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) c.put(req, res.clone());
        return res;
      } catch (e) {
        return (await c.match(req, { ignoreSearch: true })) || new Response('', { status: 504 });
      }
    })
  );
});
