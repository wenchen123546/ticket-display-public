/* 現場控台：叫號 / 發號、過號名單、精選連結、預約 */
const express = require('express');
const { redis } = require('../redis');
const { io } = require('../server');
const { KEYS } = require('../config');
const { validateNum, cleanCounter, cleanName, normalizePhone, getTWTime, parseLink, findLinkIdx } = require('../utils');
const { H } = require('../http');
const { auth, perm } = require('../auth');
const { addLog } = require('../log');
const { addHistory } = require('../history');
const { notifyTrackers } = require('../notify');
const appts = require('../appointments');
const { ctl, nextRegular, recordCall, bumpHourly, calcWaitTime, broadcastQueue, broadcastAppts, emitPassed, emitFeatured, getFeatured } = require('../queue');

const router = express.Router();

['call','set-call'].forEach(c => router.post(`/api/control/${c}`, auth, perm('perm_command'), H(async r => { const res = await ctl(c.replace('-','_'), r); if(res.error) throw new Error(res.error); return res; })));
['issue','set-issue'].forEach(c => router.post(`/api/control/${c}`, auth, perm('perm_issue'), H(async r => { const res = await ctl(c.replace('-','_'), r); if(res.error) throw new Error(res.error); return res; })));

router.post("/api/control/pass-current", auth, perm('perm_passed_edit'), H(async req => {
    const c = parseInt(await redis.get(KEYS.CURRENT))||0; if(!c) throw new Error("無叫號");
    const counter = cleanCounter(req.body?.counter), added = await redis.zadd(KEYS.PASSED, c, c), r = await nextRegular();
    await redis.hdel(KEYS.PASSED_BACK, c); // 再次過號時清除之前的「已回來」標記
    if(added) await bumpHourly('p');
    // 沒有下一號時清空目前叫號，避免同一個號碼同時出現在「目前叫號」與「過號名單」
    if(r === -1) await redis.set(KEYS.CURRENT, 0); else await recordCall(r, counter);
    const wait = await calcWaitTime();
    await addHistory('pass', c, req.user.nickname, wait);
    if(r !== -1) await addHistory('call', r, req.user.nickname, wait); // 過號同時叫出下一號，報表才算得到該號的等待時間
    addLog(req.user.nickname, `⏭️ 過號 ${c}${r === -1 ? '' : ` → ${r}`}${counter ? ` @${counter}` : ''}`); if(r !== -1) notifyTrackers(r); broadcastQueue(); await emitPassed(); return { next: r === -1 ? 0 : r };
}));

// 重呼不改變一般進度 (MAX)，避免目前是預約號時把 MAX 往上推造成跳號
router.post("/api/control/recall-passed", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n === null) throw new Error("非法數值"); const counter = cleanCounter(r.body.counter), [c, m] = await redis.mget(KEYS.CURRENT, KEYS.MAX); await redis.multi().set(KEYS.MAX, m === null ? (parseInt(c)||0) : m).zrem(KEYS.PASSED, n).hdel(KEYS.PASSED_BACK, n).set(KEYS.CURRENT, n).exec(); await recordCall(n, counter); addLog(r.user.nickname, `↩️ 重呼 ${n}${counter ? ` @${counter}` : ''}`); broadcastQueue(); await emitPassed(); }));

router.post("/api/passed/add", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n === null) throw new Error("非法數值"); if(await redis.zadd(KEYS.PASSED, n, n)) await bumpHourly('p'); await emitPassed(); addLog(r.user.nickname, `➕ 手動過號 ${n}`); }));
router.post("/api/passed/remove", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n !== null && await redis.zrem(KEYS.PASSED, n)) { await redis.hdel(KEYS.PASSED_BACK, n); await bumpHourly('p', -1); await emitPassed(); addLog(r.user.nickname, `🗑️ 移除過號 ${n}`); } }));
router.post("/api/passed/clear", auth, perm('perm_passed_edit'), H(async r => { await redis.del(KEYS.PASSED, KEYS.PASSED_BACK); await emitPassed(); addLog(r.user.nickname, "🗑️ 清空過號名單"); }));

router.post("/api/featured/add", auth, perm('perm_links_edit'), H(async r => { await redis.rpush(KEYS.FEATURED, JSON.stringify(parseLink(r.body.linkText, r.body.linkUrl))); await emitFeatured(); }));
router.post("/api/featured/get", auth, perm('perm_links_view'), H(async () => getFeatured()));
router.post("/api/featured/remove", auth, perm('perm_links_edit'), H(async r => { const l = await redis.lrange(KEYS.FEATURED,0,-1), i = findLinkIdx(l, r.body.linkText, r.body.linkUrl); if(i >= 0) await redis.lrem(KEYS.FEATURED, 1, l[i]); await emitFeatured(); }));
router.post("/api/featured/edit", auth, perm('perm_links_edit'), H(async r => { const next = parseLink(r.body.newLinkText, r.body.newLinkUrl), l = await redis.lrange(KEYS.FEATURED,0,-1), i = findLinkIdx(l, r.body.oldLinkText, r.body.oldLinkUrl); if(i >= 0) await redis.lset(KEYS.FEATURED, i, JSON.stringify(next)); await emitFeatured(); }));
router.post("/api/featured/clear", auth, perm('perm_links_edit'), H(async r => { await redis.del(KEYS.FEATURED); io.emit("updateFeaturedContents", []); }));

router.post("/api/appointment/add", auth, perm('perm_booking_edit'), H(async r => {
    const num = validateNum(r.body.number, 1); if(num === null) throw new Error("無效號碼");
    // 優先使用前端傳來的毫秒時間戳；舊版字串若無時區，視為台灣時間 (伺服器多半跑在 UTC)
    let ts = Number(r.body.timestamp);
    if(!Number.isFinite(ts) || ts <= 0) { const s = String(r.body.timeStr || '').trim().replace(' ', 'T'); ts = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}+08:00`).getTime(); }
    if(isNaN(ts)) throw new Error("無效日期");
    const name = cleanName(r.body.name), rawPhone = String(r.body.phone ?? '').trim(), phone = rawPhone ? normalizePhone(rawPhone) : '';
    if(phone === null) throw new Error("手機號碼格式錯誤");
    const dateStr = getTWTime(new Date(ts)).dateStr;
    // 當天的預約號必須是尚未發出的號碼 (發號時會自動略過)，否則會和現場客人撞號
    if(dateStr === getTWTime().dateStr) { const issued = parseInt(await redis.get(KEYS.ISSUED))||0; if(num <= issued) throw new Error(`${num} 號已發出，請使用大於 ${issued} 的號碼`); }
    if(await appts.isNumberTaken(dateStr, num)) throw new Error(`${dateStr} 已有 ${num} 號的預約`);
    await appts.create({ number: num, ts, name, phone, source: 'admin' }); addLog(r.user.nickname, `📅 預約: ${num}${name ? ` (${name})` : ''}`); await broadcastAppts();
}));
router.post("/api/appointment/list", auth, perm('perm_booking_view'), H(async () => ({ appointments: await appts.listPending() })));
router.post("/api/appointment/remove", auth, perm('perm_booking_edit'), H(async r => { const id = validateNum(r.body.id, 1, Number.MAX_SAFE_INTEGER); if(id === null) throw new Error("無效 ID"); await appts.remove(id); addLog(r.user.nickname, `📅 刪除預約 #${id}`); await broadcastAppts(); }));

module.exports = router;
