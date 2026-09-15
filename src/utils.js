/* 純函式工具 (不依賴 Redis / DB，可直接單元測試) */
const crypto = require('crypto');

const TW_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const getTWTime = (date = new Date()) => { const p = Object.fromEntries(TW_FMT.formatToParts(date).map(x => [x.type, x.value])); return { dateStr: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour) % 24, minute: parseInt(p.minute) }; };
const twTimeString = (date = new Date()) => date.toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

const parseCookie = s => { try { return s.split(';').reduce((a, v) => { const [k, ...rest] = v.split('='); if(k) a[k.trim()] = decodeURIComponent(rest.join('=').trim()); return a; }, {}); } catch(e) { return {}; } };
const validateNum = (n, min=0, max=99999) => { const v = parseInt(n, 10); return (!isNaN(v) && v >= min && v <= max) ? v : null; };
const safeJSON = (s, fb = null) => { try { return JSON.parse(s) ?? fb; } catch (e) { return fb; } };
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isAdminUser = u => u?.role === 'super' || u?.userRole === 'ADMIN';
const isSafeUrl = u => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch (e) { return false; } };
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const cleanText = (v, max) => String(v ?? '').replace(/[\r\n<>]/g, '').trim().slice(0, max);
const cleanCounter = v => cleanText(v, 12);
const cleanName = v => cleanText(v, 20);
// 手機號碼：去掉空白 / 橫線 / 括號後需為 8~15 位數字 (可含開頭 +)，不合法回傳 null
const normalizePhone = v => { const s = String(v ?? '').replace(/[\s\-()]/g, ''); return /^\+?\d{8,15}$/.test(s) ? s : null; };
// 前台顯示用遮罩：保留前 2 碼與末 3 碼
const maskPhone = p => !p ? '' : p.length <= 5 ? '*'.repeat(p.length) : `${p.slice(0, 2)}${'*'.repeat(p.length - 5)}${p.slice(-3)}`;
// 暫停服務說明文字，例如「（午休），預計 13:30 恢復」
const formatPause = (p = {}) => `${p.reason ? `（${p.reason}）` : ''}${p.resumeAt ? `，預計 ${p.resumeAt} 恢復` : ''}`;
const maskSecret = v => v ? `••••${v.slice(-4)}` : null;
// MAX 不存在 (舊資料) 時視為與目前叫號相同；叫預約號時 CURRENT 可能大於 MAX
const toMax = (raw, current) => raw === null ? current : (parseInt(raw)||0);

// 每小時淨人次：發號 (_i，舊版為純數字 key) 扣除過號 (_p) 與客人取消 (_c)
const netHourly = h => Array.from({ length: 24 }, (_, i) => h ? Math.max(0, parseInt(h[`${i}_i`]||h[i]||0) - parseInt(h[`${i}_p`]||0) - parseInt(h[`${i}_c`]||0)) : 0);

// 營業時間判斷；start > end 代表跨夜營業 (例如 18:00-02:00)；舊版設定可能是整點數字
const isOpenAt = (cfg, hour, minute) => {
    if (!cfg.enabled) return true;
    const cur = hour * 60 + minute;
    const toMins = t => { if (typeof t === 'number') return t * 60; const [h, m] = String(t || "00:00").split(':').map(Number); return (h||0) * 60 + (m||0); };
    const s = toMins(cfg.start), e = toMins(cfg.end);
    if (s === e) return true;
    return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e);
};

// 平均叫號間隔 (分鐘，取到小數一位)：timestamps 需由新到舊排序；10 秒內或超過 10 分鐘的間隔視為異常略過，沒有有效間隔回傳 null
const avgIntervalMinutes = timestamps => {
    const MIN_MS = 10 * 1000, MAX_MS = 10 * 60 * 1000, valid = [];
    for (let i = 0; i < timestamps.length - 1; i++) { const diff = timestamps[i] - timestamps[i + 1]; if (diff >= MIN_MS && diff <= MAX_MS) valid.push(diff); }
    if (!valid.length) return null;
    return Math.ceil((valid.reduce((a, v) => a + v, 0) / valid.length / 60000) * 10) / 10;
};

// Web Push endpoint 只允許各瀏覽器的推播服務網域，避免伺服器被利用去請求任意網址
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const isPushEndpoint = u => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some(h => x.hostname === h || x.hostname.endsWith(`.${h}`)); } catch (e) { return false; } };
const pushId = ep => crypto.createHash('sha256').update(ep).digest('hex').slice(0, 24);

// 防 CSV 公式注入
const csvEscape = v => { let s = String(v ?? ''); if(/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// 連結僅允許 http/https，避免 javascript: 連結在前台造成 XSS
const parseLink = (text, url) => { const linkText = String(text ?? '').trim().slice(0, 50), linkUrl = String(url ?? '').trim(); if(!linkText || !isSafeUrl(linkUrl)) throw new Error("連結名稱或網址無效 (需 http:// 或 https://)"); return { linkText, linkUrl }; };
const findLinkIdx = (list, text, url) => list.findIndex(x => { const o = safeJSON(x); return o && o.linkUrl === url && (text === undefined || o.linkText === text); });

module.exports = {
    getTWTime, twTimeString, parseCookie, validateNum, safeJSON, safeEqual, isAdminUser, isSafeUrl, HM_RE, cleanText, cleanCounter, cleanName, normalizePhone, maskPhone, formatPause, maskSecret, toMax,
    netHourly, isOpenAt, avgIntervalMinutes, isPushEndpoint, pushId, csvEscape, parseLink, findLinkIdx
};
