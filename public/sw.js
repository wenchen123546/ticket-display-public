// /public/sw.js (v3.6 修改版)

// 【v3.6】 變更快取名稱為 v3
const CACHE_NAME = 'callsys-cache-v3'; 

// v15 (與您的 CSS/JS 版本號同步)
const ASSETS_TO_CACHE = [
    '/',
    '/index.html',
    '/css/style.css?v=15',
    '/js/main.js?v=15',
    
    // 【v3.6 修復】 新增 QRCode CDN，確保 PWA 完整
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',

    '/ding.mp3',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

// 1. 安裝 Service Worker 並快取核心資產
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] 正在快取核心資產 (v3.6)...');
                return cache.addAll(ASSETS_TO_CACHE);
            })
            .catch(err => console.error('[SW] v3.6 快取失敗', err))
    );
    self.skipWaiting(); // 強制新的 SW 立即生效
});

// 2. 啟用 Service Worker
self.addEventListener('activate', (event) => {
    // 移除 v1, v2 的舊快取
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cacheName) => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] 正在移除舊快取:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim()) // 取得頁面控制權
    );
});

// 3. 攔截網路請求 (Cache First 策略)
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') {
        return;
    }
    
    // 對於 /socket.io/ (包含 WS/Polling) 永遠使用網路
    if (event.request.url.includes('/socket.io/')) {
        return event.respondWith(fetch(event.request));
    }

    // 對於其他所有請求 (App Shell)
    event.respondWith(
        caches.match(event.request)
            .then((response) => {
                // 1. 優先從快取回傳
                if (response) {
                    return response;
                }

                // 2. 快取未命中，從網路擷取
                return fetch(event.request);
            })
            .catch(err => {
                console.error('[SW] Fetch 錯誤', err);
            })
    );
});
