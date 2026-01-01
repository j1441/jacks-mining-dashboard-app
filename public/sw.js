/**
 * Service Worker for Home Mining Dashboard PWA
 *
 * Caching Strategy:
 * - App shell (HTML, icons): Cache-first with network fallback
 * - API requests: Network-first with cache fallback (for offline support)
 * - CDN resources (React, Babel): Cache-first (they're versioned)
 */

const CACHE_NAME = 'mining-dashboard-v1';
const STATIC_CACHE = 'mining-dashboard-static-v1';
const API_CACHE = 'mining-dashboard-api-v1';

// Static assets to cache immediately on install
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/manifest.json',
    '/icons/icon-192x192.png',
    '/icons/icon-512x512.png',
    // CDN resources
    'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js'
];

// API endpoints that can be cached for offline use
const CACHEABLE_API_PATTERNS = [
    '/api/config',
    '/api/btc/price',
    '/api/network/stats',
    '/api/electricity/prices'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .then(() => {
                console.log('[SW] Static assets cached');
                return self.skipWaiting();
            })
            .catch((err) => {
                console.error('[SW] Failed to cache static assets:', err);
            })
    );
});

// Activate event - cleanup old caches
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames
                        .filter((name) => {
                            // Delete old versions of our caches
                            return name.startsWith('mining-dashboard-') &&
                                   name !== STATIC_CACHE &&
                                   name !== API_CACHE;
                        })
                        .map((name) => {
                            console.log('[SW] Deleting old cache:', name);
                            return caches.delete(name);
                        })
                );
            })
            .then(() => {
                console.log('[SW] Service worker activated');
                return self.clients.claim();
            })
    );
});

// Fetch event - serve from cache or network
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') {
        return;
    }

    // Skip WebSocket requests
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
        return;
    }

    // Handle API requests with network-first strategy
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(networkFirstWithCache(request, API_CACHE));
        return;
    }

    // Handle static assets with cache-first strategy
    event.respondWith(cacheFirstWithNetwork(request));
});

/**
 * Cache-first strategy with network fallback
 * Best for: static assets, CDN resources, app shell
 */
async function cacheFirstWithNetwork(request) {
    try {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            // Return cached version and update cache in background
            updateCache(request);
            return cachedResponse;
        }

        // Not in cache, fetch from network
        const networkResponse = await fetch(request);

        // Cache successful responses
        if (networkResponse.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, networkResponse.clone());
        }

        return networkResponse;
    } catch (error) {
        console.error('[SW] Cache-first fetch failed:', error);

        // Return offline fallback for navigation requests
        if (request.mode === 'navigate') {
            const cachedIndex = await caches.match('/index.html');
            if (cachedIndex) {
                return cachedIndex;
            }
        }

        throw error;
    }
}

/**
 * Network-first strategy with cache fallback
 * Best for: API requests, dynamic data
 */
async function networkFirstWithCache(request, cacheName) {
    try {
        const networkResponse = await fetch(request);

        // Cache successful API responses
        if (networkResponse.ok && isCacheableApi(request.url)) {
            const cache = await caches.open(cacheName);
            cache.put(request, networkResponse.clone());
        }

        return networkResponse;
    } catch (error) {
        console.log('[SW] Network failed, trying cache:', request.url);

        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            // Return cached data with a header indicating it's stale
            const headers = new Headers(cachedResponse.headers);
            headers.set('X-From-Cache', 'true');
            return new Response(cachedResponse.body, {
                status: cachedResponse.status,
                statusText: cachedResponse.statusText,
                headers
            });
        }

        // No cached data available
        return new Response(JSON.stringify({
            error: 'Offline',
            message: 'No cached data available',
            offline: true
        }), {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * Check if an API endpoint should be cached
 */
function isCacheableApi(url) {
    const urlPath = new URL(url).pathname;
    return CACHEABLE_API_PATTERNS.some(pattern => urlPath.includes(pattern));
}

/**
 * Update cache in background (stale-while-revalidate pattern)
 */
async function updateCache(request) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse.ok) {
            const cache = await caches.open(STATIC_CACHE);
            cache.put(request, networkResponse);
        }
    } catch (error) {
        // Silently fail - we already served from cache
    }
}

// Handle messages from the main app
self.addEventListener('message', (event) => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }

    if (event.data === 'clearCache') {
        caches.keys().then((names) => {
            names.forEach((name) => {
                if (name.startsWith('mining-dashboard-')) {
                    caches.delete(name);
                }
            });
        });
    }
});

// Background sync for when coming back online
self.addEventListener('sync', (event) => {
    console.log('[SW] Background sync:', event.tag);

    if (event.tag === 'sync-dashboard') {
        event.waitUntil(
            // Refresh cached API data
            Promise.all(
                CACHEABLE_API_PATTERNS.map(async (pattern) => {
                    try {
                        const response = await fetch(pattern);
                        if (response.ok) {
                            const cache = await caches.open(API_CACHE);
                            cache.put(pattern, response);
                        }
                    } catch (e) {
                        // Ignore sync failures
                    }
                })
            )
        );
    }
});

console.log('[SW] Service worker script loaded');
