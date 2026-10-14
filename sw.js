// 让小手机断网也能打开:第一次打开时把页面文件存进手机,之后都从手机里读
// 每次打开会在后台悄悄拉一次新版,下次打开生效。网址打不开也不影响使用

const CACHE = 'xiaoshouji-v1';

// 新增了页面文件就加到这里
const FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'brain.js',
  'call.js',
  'memory.js',
  'mic-worklet.js',
  'realtime.js',
  'store.js',
  'voice.js',
  'character.txt',
  'chat-rules.txt',
  'manifest.webmanifest',
  'icon.svg',
  'icon-180.png',
  'icon-192.png',
  'icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 只管自己的页面文件。发给 AI 的请求不经过这里
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      const fresh = fetch(event.request)
        .then((res) => {
          if (res.ok) cache.put(event.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
