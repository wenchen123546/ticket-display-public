/* 安全標頭 (Helmet + CSP)
 * 外部資源只允許頁面實際用到的 CDN 路徑 (鎖定版本)，新增 CDN 套件時要同步加到這裡，否則瀏覽器會擋下
 * - script-src 不允許 inline：頁面上不可再寫 onclick="" 之類的 HTML 事件屬性，一律在 JS 綁定
 * - style-src 保留 'unsafe-inline'：頁面大量使用 style="" 屬性與 JS 產生的樣式
 */
const helmet = require('helmet');
const { IS_PROD } = require('./config');

const CDN_SCRIPTS = [
    'https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/',   // 前台到號彩帶
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/', // 前台 QR Code
    'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/'          // 後台預約時間選擇器
];
// 部分瀏覽器的 'self' 不涵蓋 WebSocket，明確允許同主機的 ws / wss (Host 格式不合法時不加)
const sameHostSocket = req => { const h = req.headers.host || ''; return /^[\w.-]+(:\d+)?$/.test(h) ? `${req.protocol === 'https' ? 'wss' : 'ws'}://${h}` : "'self'"; };

module.exports = helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", ...CDN_SCRIPTS],
            scriptSrcAttr: ["'none'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:'],       // QR Code 以 data: 圖片輸出
            connectSrc: ["'self'", sameHostSocket],
            mediaSrc: ["'self'"],
            workerSrc: ["'self'", 'blob:'],             // Service Worker；canvas-confetti 以 blob: Worker 繪製
            manifestSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'self'"],
            // 本機 http 開發時不強制升級 https，否則靜態資源會載入失敗
            upgradeInsecureRequests: IS_PROD ? [] : null
        }
    }
});
