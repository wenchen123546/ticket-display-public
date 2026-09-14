/* Service Worker - 只負責 Web Push 背景通知 (不快取頁面，避免叫號畫面顯示舊資料) */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
    let d = {};
    try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
    e.waitUntil(self.registration.showNotification(d.title || '叫號通知', {
        body: d.body || '', tag: d.tag, renotify: true, vibrate: [200, 100, 200],
        icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: '/' }
    }));
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
        const c = list.find(x => new URL(x.url).pathname === '/');
        return c ? c.focus() : self.clients.openWindow('/');
    }));
});
