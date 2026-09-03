// Gemba service worker — offline app shell + new-event notifications.
// Bump CACHE when the shell file list changes to force an update.
const CACHE = 'gemba-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

const DATA_URL = './data/events.json';
const SEEN_KEY = './__state/seen-links';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first for the data file, cache-first for everything else in scope.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.endsWith('/data/events.json')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request))
  );
});

// Triggered by the page ("check now") and by periodic background sync.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'check-events') {
    e.waitUntil(checkForNewEvents({ silentFirstRun: false }));
  }
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'gemba-refresh') {
    e.waitUntil(checkForNewEvents({ silentFirstRun: true }));
  }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('./');
    })
  );
});

async function readSeen() {
  const cache = await caches.open(CACHE);
  const res = await cache.match(SEEN_KEY);
  if (!res) return null; // null => never checked before
  try { return new Set(await res.json()); } catch { return new Set(); }
}

async function writeSeen(set) {
  const cache = await caches.open(CACHE);
  await cache.put(SEEN_KEY, new Response(JSON.stringify([...set]), {
    headers: { 'Content-Type': 'application/json' },
  }));
}

async function checkForNewEvents() {
  let store;
  try {
    const res = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    store = await res.json();
  } catch {
    return;
  }

  const items = Array.isArray(store.items) ? store.items : [];
  const links = items.map((i) => i.link).filter(Boolean);
  const seen = await readSeen();

  // First ever check: seed the baseline quietly so we don't notify for the backlog.
  if (seen === null) {
    await writeSeen(new Set(links));
    return;
  }

  const fresh = items.filter((i) => i.link && !seen.has(i.link));
  await writeSeen(new Set([...seen, ...links]));
  if (!fresh.length) return;

  const title = fresh.length === 1
    ? 'Gemba: 1 new result'
    : `Gemba: ${fresh.length} new results`;
  const body = fresh.slice(0, 4).map((i) => '• ' + i.title).join('\n')
    + (fresh.length > 4 ? `\n…and ${fresh.length - 4} more` : '');

  await self.registration.showNotification(title, {
    body,
    icon: './icon-192.png',
    badge: './icon-192.png',
    tag: 'gemba-new-events',
    renotify: true,
    data: { url: './' },
  });
}
