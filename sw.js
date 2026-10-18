// 让小手机断网也能打开:第一次打开时把页面文件存进手机,之后都从手机里读
// 版本号由 tools/build-site.js 在生成上传文件夹时自动填上。每次上传的版本号都不一样,
// 浏览器发现这个文件变了,就会把整套新文件下载好,再让页面自动刷新一次换成新版
const VERSION = '20261019140000';
const CACHE = `xiaoshouji-${VERSION}`;

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
  // cache: 'reload' 表示绕过浏览器自己的缓存,一定去网上拿最新的
  const fresh = FILES.map((file) => new Request(file, { cache: 'reload' }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 新版就位后,把旧版本的文件删掉
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // 只管自己的页面文件。发给 AI 的请求不经过这里
  if (event.request.method !== 'GET' || url.origin !== location.origin) return;

  // 同一版本的文件都从手机里读,保证页面和代码是配套的;手机里没有的才去网上拿
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(event.request, { ignoreSearch: true }))
      .then((cached) => cached || fetch(event.request)),
  );
});
