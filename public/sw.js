/**
 * Veil Service Worker
 * 提供基础的静态资源缓存（Stale-While-Revalidate）
 */

const CACHE_NAME = 'veil-v2';
const STATIC_ASSETS = [
    '/css/styles.css',
    '/css/icons/regular.css',
    '/css/icons/bold.css',
    '/css/icons/fill.css',
    '/css/icons/Phosphor.woff2',
    '/css/icons/Phosphor-Bold.woff2',
    '/css/icons/Phosphor-Fill.woff2',
    '/js/common.js',
    '/js/theme.js',
    '/js/auth.js',
    '/js/api.js',
    '/js/aurora.js',
    '/js/inbox.js',
    '/js/compose.js',
    '/js/domain-selector.js',
    '/js/admin.js',
    '/js/user.js',
    '/js/mailbox.js',
    '/manifest.json',
    '/favicon.svg'
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((names) => {
            return Promise.all(
                names.filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/') || url.pathname === '/receive') return;
    if (req.mode === 'navigate' || req.destination === 'document') return;

    e.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(req).then((cached) => {
                const fetchPromise = fetch(req).then((response) => {
                    if (response.ok) {
                        cache.put(req, response.clone());
                    }
                    return response;
                }).catch(() => cached);

                return cached || fetchPromise;
            });
        })
    );
});
