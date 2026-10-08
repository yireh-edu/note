/*
 * 이레 노트 서비스 워커 — "인터넷 먼저" 방식
 * - 사이트 파일(페이지·문제·프로그램): 항상 인터넷에서 새로 받고, 받은 것을 저장해 둠.
 *   인터넷이 안 되거나 4초 안에 응답이 없을 때만 저장해 둔 것을 보여 줌.
 * - 버전 번호(?v=)가 붙은 파일(프로그램·문제·글꼴 모양): 같은 번호면 내용이 같으므로 저장본을 바로 씀 (화면이 빨리 뜸).
 *   새로 올리면 페이지가 새 번호로 부르므로 그때 새로 받음.
 * - 글꼴·수식 도구(다른 사이트 파일): 자주 바뀌지 않으므로 저장본을 먼저 씀.
 * - 학생 기록(localStorage)은 건드리지 않음.
 * 이 파일은 빌드할 때마다 새 버전 번호가 들어가서, 올리면 자동으로 새 버전으로 바뀝니다.
 */
const VERSION = '202610080735';
const SITE_CACHE = `yireh-note-site-${VERSION}`;
const CDN_CACHE = 'yireh-cdn-v1';
const PRECACHE = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/note.css?v=202610080735",
  "assets/note.js?v=202610080735",
  "assets/vendor/pdf.min.js?v=202610080735",
  "assets/vendor/pdf.worker.min.js?v=202610080735",
  "assets/vendor/pdf-lib.min.js?v=202610080735",
  "icons/app-192.png",
  "icons/app-512.png",
  "icons/app-maskable-512.png",
  "icons/app-180.png"
];
const TIMEOUT_MS = 4000;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SITE_CACHE);
    // 하나가 실패해도 나머지는 저장되도록 파일마다 따로 받음
    await Promise.all(PRECACHE.map(url =>
      fetch(new Request(url, { cache: 'reload' })).then(res => res.ok && cache.put(url, res)).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('yireh-note-site-') && key !== SITE_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) event.respondWith(url.searchParams.has('v') ? versionedFirst(req) : networkFirst(req));
  else if (/fonts\.(googleapis|gstatic)\.com$|cdn\.jsdelivr\.net$/.test(url.hostname)) event.respondWith(cacheFirst(req));
});

// 숙제 파일처럼 ?t=시각 이 붙는 요청은 t를 뺀 주소 하나로 저장 (저장본이 쌓이지 않게)
function cacheKey(req) {
  const u = new URL(req.url);
  if (!u.searchParams.has('t')) return req;
  u.searchParams.delete('t');
  return u.href;
}

async function networkFirst(req) {
  const cache = await caches.open(SITE_CACHE);
  const key = cacheKey(req);
  const network = fetch(req).then(res => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS));
  try {
    return await Promise.race([network, timeout]);
  } catch (e) {
    const saved = await cache.match(key) || await cache.match(req, { ignoreSearch: true });
    if (saved) { network.catch(() => {}); return saved; }
    try { return await network; } catch (e2) {
      if (req.mode === 'navigate') {
        const home = await cache.match('index.html');
        if (home) return home;
      }
      return Response.error();
    }
  }
}

// ?v=버전 이 붙은 파일: 같은 버전 저장본이 있으면 인터넷을 기다리지 않음. 없으면 평소처럼 인터넷 먼저
async function versionedFirst(req) {
  const saved = await (await caches.open(SITE_CACHE)).match(req);
  return saved || networkFirst(req);
}

async function cacheFirst(req) {
  const cache = await caches.open(CDN_CACHE);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}
