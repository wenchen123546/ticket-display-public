/* 線上預約：客人選時段預約、查詢 / 取消自己的預約；後台預約設定
 * 客人以 HttpOnly Cookie 辨識 (同一裝置同時只能有一筆待叫預約)；前台只回傳遮罩後的手機號碼
 */
const express = require('express'), rateLimit = require('express-rate-limit'), crypto = require('crypto');
const { redis } = require('../redis');
const { io } = require('../server');
const { KEYS, IS_PROD } = require('../config');
const { parseCookie, safeJSON, getTWTime, cleanName, normalizePhone, maskPhone } = require('../utils');
const { DEFAULT_BOOKING, normalizeBookingConfig, buildSlots, bookableDates, isBookableSlot } = require('../schedule');
const { H } = require('../http');
const { auth, perm } = require('../auth');
const { addLog } = require('../log');
const appts = require('../appointments');
const { broadcastAppts } = require('../queue');

const router = express.Router();
const BK_COOKIE = 'callsys_bk', UUID_RE = /^[0-9a-f-]{36}$/;

const getBookingConfig = async () => normalizeBookingConfig({ ...DEFAULT_BOOKING, ...safeJSON(await redis.get(KEYS.BOOKING.CFG), {}) });
const publicView = a => ({ id: a.id, number: a.number, scheduled_time: a.scheduled_time, date_str: a.date_str, name: a.name, phone: maskPhone(a.phone), status: a.status });
const readBooking = async req => {
    const tk = parseCookie(req.headers.cookie||'')[BK_COOKIE]; if(!UUID_RE.test(tk||'')) return { tk: null, appt: null };
    const id = await redis.get(`${KEYS.BOOKING.TOKEN}${tk}`);
    return { tk, appt: id ? await appts.get(id) : null };
};
const slotLabel = ts => new Date(ts).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

router.get('/api/booking/config', H(async () => { const c = await getBookingConfig(); return c.enabled ? { enabled: true, dates: bookableDates(c), slotMinutes: c.slotMinutes } : { enabled: false }; }));

router.get('/api/booking/slots', H(async req => {
    const c = await getBookingConfig(); if(!c.enabled) throw new Error("目前未開放線上預約");
    const date = String(req.query.date || ''); if(!bookableDates(c).includes(date)) throw new Error("無效日期");
    const now = Date.now(), slots = buildSlots(c, date).filter(s => s.ts > now);
    const used = slots.length ? await redis.mget(...slots.map(s => `${KEYS.BOOKING.SLOT}${s.ts}`)) : [];
    return { date, slots: slots.map((s, i) => ({ ...s, remaining: Math.max(0, c.capacity - (parseInt(used[i]) || 0)) })) };
}));

router.post('/api/booking/create', rateLimit({windowMs:36e5,max:10}), H(async (req, res) => {
    const c = await getBookingConfig(); if(!c.enabled) throw new Error("目前未開放線上預約");
    const ts = Number(req.body?.ts), name = cleanName(req.body?.name), phone = normalizePhone(req.body?.phone);
    if(!name) throw new Error("請填寫稱呼");
    if(!phone) throw new Error("手機號碼格式錯誤");
    if(!isBookableSlot(c, ts)) throw new Error("此時段無法預約，請重新選擇");
    const cur = await readBooking(req);
    if(cur.appt?.status === 'pending') throw new Error("您已有一筆預約，請先取消再重新預約");
    // 先佔名額再建立預約；超過名額立即歸還
    const slotKey = `${KEYS.BOOKING.SLOT}${ts}`, [[, used]] = await redis.multi().incr(slotKey).expireat(slotKey, Math.ceil(ts / 1000) + 86400).exec();
    if(used > c.capacity) { await redis.decr(slotKey); throw new Error("此時段已額滿，請選擇其他時段"); }
    const dateStr = getTWTime(new Date(ts)).dateStr, number = await appts.nextBookingNumber(dateStr, c.numberStart);
    const a = await appts.create({ number, ts, name, phone, source: 'online' });
    const tk = cur.tk || crypto.randomUUID(), ttl = Math.max(3600, Math.ceil((ts - Date.now()) / 1000) + 86400);
    await redis.set(`${KEYS.BOOKING.TOKEN}${tk}`, a.id, 'EX', ttl);
    res.setHeader('Set-Cookie', `${BK_COOKIE}=${tk}; HttpOnly; Path=/; Max-Age=${ttl}; SameSite=Lax${IS_PROD?'; Secure':''}`);
    addLog('客人', `📅 線上預約 ${slotLabel(ts)} ${number} 號 (${name})`); broadcastAppts().catch(()=>{});
    return { success: true, booking: publicView(a) };
}));

router.get('/api/booking/mine', H(async req => { const { appt } = await readBooking(req); return { booking: appt ? publicView(appt) : null }; }));

router.post('/api/booking/cancel', rateLimit({windowMs:9e5,max:30}), H(async req => {
    const { tk, appt } = await readBooking(req);
    if(!appt || !(await appts.cancel(appt.id))) return { success: true, cancelled: false };
    await redis.del(`${KEYS.BOOKING.TOKEN}${tk}`);
    addLog('客人', `📅 取消線上預約 ${slotLabel(appt.scheduled_time)} ${appt.number} 號`); broadcastAppts().catch(()=>{});
    return { success: true, cancelled: true };
}));

router.post('/api/admin/booking-config/get', auth, perm('perm_booking_view'), H(async () => getBookingConfig()));
router.post('/api/admin/booking-config/save', auth, perm('perm_booking_edit'), H(async r => {
    const c = normalizeBookingConfig(r.body || {});
    await redis.set(KEYS.BOOKING.CFG, JSON.stringify(c));
    io.emit("updateBookingConfig", { enabled: c.enabled });
    addLog(r.user.nickname, `📅 預約設定：${c.enabled ? `開放 ${c.daysAhead} 天，${c.start}-${c.end} 每 ${c.slotMinutes} 分 ${c.capacity} 組` : '關閉線上預約'}`);
    return c;
}));

module.exports = router;
