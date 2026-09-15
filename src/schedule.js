/* 日期與預約時段 (純函式)：台灣時間固定 +08:00，無日光節約 */
const { getTWTime } = require('./utils');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_MS = 86400000;

// 台灣日期 + HH:MM → 毫秒時間戳
const twToTs = (dateStr, hm = '00:00') => new Date(`${dateStr}T${hm}:00+08:00`).getTime();
// 日曆日期加減天數 (以 UTC 計算純日期，不受伺服器時區影響)
const addDays = (dateStr, n) => new Date(Date.parse(`${dateStr}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isDate = s => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

// from ~ to (含) 的日期清單，超過 maxDays 截斷；格式錯誤或 from > to 回傳空陣列
const dateRange = (from, to, maxDays = 366) => {
    if (!isDate(from) || !isDate(to) || from > to) return [];
    const out = [];
    for (let d = from; d <= to && out.length < maxDays; d = addDays(d, 1)) out.push(d);
    return out;
};
// 週一為一週的開始
const weekStart = dateStr => { const dow = (new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7; return addDays(dateStr, -dow); };
const monthKey = dateStr => dateStr.slice(0, 7);
const hmToMin = hm => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const minToHm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

const DEFAULT_BOOKING = { enabled: false, daysAhead: 7, start: '09:00', end: '18:00', slotMinutes: 30, capacity: 2, numberStart: 500 };
const clampInt = (v, min, max, fb) => { const n = parseInt(v, 10); return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fb; };

// 後台送來的預約設定：欄位驗證與範圍限制，錯誤值回到預設
const normalizeBookingConfig = (input = {}) => {
    const c = {
        enabled: !!input.enabled,
        daysAhead: clampInt(input.daysAhead, 1, 60, DEFAULT_BOOKING.daysAhead),
        start: HM_RE.test(input.start) ? input.start : DEFAULT_BOOKING.start,
        end: HM_RE.test(input.end) ? input.end : DEFAULT_BOOKING.end,
        slotMinutes: clampInt(input.slotMinutes, 5, 240, DEFAULT_BOOKING.slotMinutes),
        capacity: clampInt(input.capacity, 1, 100, DEFAULT_BOOKING.capacity),
        numberStart: clampInt(input.numberStart, 1, 99000, DEFAULT_BOOKING.numberStart)
    };
    if (hmToMin(c.end) <= hmToMin(c.start)) { c.start = DEFAULT_BOOKING.start; c.end = DEFAULT_BOOKING.end; }
    return c;
};

// 某天的所有時段：每段必須在結束時間前完整結束
const buildSlots = (cfg, dateStr) => {
    const out = [], s = hmToMin(cfg.start), e = hmToMin(cfg.end);
    for (let m = s; m + cfg.slotMinutes <= e; m += cfg.slotMinutes) { const time = minToHm(m); out.push({ time, ts: twToTs(dateStr, time) }); }
    return out;
};
// 可預約的日期：今天起 daysAhead 天 (台灣時間)
const bookableDates = (cfg, now = Date.now()) => { const today = getTWTime(new Date(now)).dateStr; return Array.from({ length: cfg.daysAhead }, (_, i) => addDays(today, i)); };
// 時段是否為這份設定下合法、尚未開始、且在可預約日期內
const isBookableSlot = (cfg, ts, now = Date.now()) => {
    if (!Number.isFinite(ts) || ts <= now) return false;
    const dateStr = getTWTime(new Date(ts)).dateStr;
    return bookableDates(cfg, now).includes(dateStr) && buildSlots(cfg, dateStr).some(x => x.ts === ts);
};

module.exports = { DATE_RE, DAY_MS, DEFAULT_BOOKING, twToTs, addDays, isDate, dateRange, weekStart, monthKey, normalizeBookingConfig, buildSlots, bookableDates, isBookableSlot };
