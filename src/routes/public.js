/* 不需登入的路由：健康檢查、線上取號 / 放棄號碼 / 過號回報、Web Push 訂閱 */
const express = require('express'), rateLimit = require('express-rate-limit'), crypto = require('crypto');
const { redis } = require('../redis');
const { KEYS, S_KEYS, TICKET_TTL, IS_PROD } = require('../config');
const { parseCookie, validateNum, toMax, isPushEndpoint, pushId, formatPause } = require('../utils');
const { H } = require('../http');
const { addLog } = require('../log');
const { addHistory } = require('../history');
const { getPushState, notifyTrackers } = require('../notify');
const { issueNext, bumpHourly, calcWaitTime, getCachedWait, broadcastQueue, isBusinessOpen, emitPassed, getPauseInfo } = require('../queue');

const router = express.Router();

router.get('/health', async (req, res) => { if (redis.status !== 'ready') return res.status(503).json({ status: 'error', redis: false, message: `Redis ${redis.status}` }); try { await redis.ping(); res.json({ status: 'ok', uptime: Math.floor(process.uptime()), redis: true }); } catch(e) { res.status(503).json({ status: 'error', message: e.message }); } });

// 線上取號憑證：HttpOnly Cookie 對應號碼 (值為 `EPOCH:號碼`，全域重置後自動失效)
// 同一裝置尚未叫到的號碼直接回傳，不重複發號；IP 上限放寬，避免店內共用 Wi-Fi 的客人被擋
const TICKET_COOKIE = 'callsys_tk', UUID_RE = /^[0-9a-f-]{36}$/;
const readTicket = async req => {
    const tk = parseCookie(req.headers.cookie||'')[TICKET_COOKIE]; if(!UUID_RE.test(tk||'')) return { tk: null, num: 0 };
    const [saved, epoch, c, m] = await redis.mget(`${KEYS.TICKET}${tk}`, KEYS.EPOCH, KEYS.CURRENT, KEYS.MAX), [e, n] = String(saved||'').split(':');
    const current = parseInt(c)||0;
    return { tk, epoch: epoch||'0', num: e === String(epoch||'0') ? (parseInt(n)||0) : 0, current, max: toMax(m, current) };
};
router.post("/api/ticket/take", rateLimit({windowMs:36e5,max:200}), H(async (req, res) => {
    const t0 = await readTicket(req);
    if(t0.num && (t0.num > t0.max || t0.num === t0.current) && !(await redis.zscore(KEYS.CANCELLED, t0.num))) return { success: true, ticket: t0.num, existing: true };
    const [mode, allowT, pub, epoch] = await redis.mget(KEYS.MODE, S_KEYS.ALLOW_T, S_KEYS.PUBLIC, KEYS.EPOCH);
    if(pub === "0") throw new Error(`系統暫停服務${formatPause(await getPauseInfo())}`);
    if(mode==='input') throw new Error("手動模式");
    if(allowT === "0") throw new Error("目前暫停取號");
    if(!(await isBusinessOpen())) throw new Error("非營業時間");
    const t = await issueNext(), tk = t0.tk || crypto.randomUUID(); await bumpHourly('i');
    await redis.set(`${KEYS.TICKET}${tk}`, `${epoch||'0'}:${t}`, 'EX', TICKET_TTL);
    res.setHeader('Set-Cookie', `${TICKET_COOKIE}=${tk}; HttpOnly; Path=/; Max-Age=${TICKET_TTL}; SameSite=Lax${IS_PROD?'; Secure':''}`);
    await addHistory('online_take', t, 'User', await calcWaitTime()); broadcastQueue(); return { success: true, ticket: t };
}));
// 客人放棄號碼：只接受本裝置線上取得、尚未叫到的號碼；一般叫號會自動略過已取消的號碼
router.post("/api/ticket/cancel", rateLimit({windowMs:9e5,max:30}), H(async req => {
    const t = await readTicket(req), n = validateNum(req.body?.number, 1);
    if(!t.num || t.num !== n) return { success: true, cancelled: false };
    await redis.del(`${KEYS.TICKET}${t.tk}`);
    if(n <= t.max || n === t.current) return { success: true, cancelled: false };
    if(await redis.zadd(KEYS.CANCELLED, 'NX', n, n)) {
        await bumpHourly('c');
        await addHistory('cancel', n, 'User', getCachedWait());
        addLog('客人', `🚫 放棄號碼 ${n}`); broadcastQueue();
    }
    return { success: true, cancelled: true };
}));
// 過號客人回到現場：只接受目前在過號名單內的號碼，後台過號名單會標示並排到最前面
router.post("/api/ticket/back", rateLimit({windowMs:9e5,max:20}), H(async req => {
    const n = validateNum(req.body?.number, 1); if(n === null) throw new Error("無效號碼");
    if(await redis.zscore(KEYS.PASSED, n) === null) return { success: true, notified: false };
    if(await redis.hsetnx(KEYS.PASSED_BACK, n, Date.now())) { addLog('客人', `🙋 ${n} 號已回到現場`); await emitPassed(); }
    return { success: true, notified: true };
}));

// Web Push：前台訂閱號碼的背景推播 (手機鎖屏 / 分頁關閉也能收到)
const pushLimiter = rateLimit({windowMs:9e5,max:60});
router.get("/api/push/key", (req, res) => { const p = getPushState(); p.ready ? res.json({ key: p.publicKey }) : res.status(503).json({ error: "推播未啟用" }); });
router.post("/api/push/subscribe", pushLimiter, H(async req => {
    if(!getPushState().ready) throw new Error("推播未啟用");
    const n = validateNum(req.body?.number, 1), s = req.body?.subscription;
    if(n === null) throw new Error("無效號碼");
    if(!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !isPushEndpoint(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string' || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) throw new Error("無效訂閱");
    const [cRaw, mRaw] = await redis.mget(KEYS.CURRENT, KEYS.MAX), c = parseInt(cRaw)||0, mx = toMax(mRaw, c);
    if(n <= mx || n === c) return { success: true, subscribed: false };
    const id = pushId(s.endpoint), old = await redis.get(`${KEYS.PUSH.EP}${id}`), p = redis.multi();
    if(old && old !== String(n)) p.hdel(`${KEYS.PUSH.SUB}${old}`, id);
    await p.hset(`${KEYS.PUSH.SUB}${n}`, id, JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } })).expire(`${KEYS.PUSH.SUB}${n}`, 43200).set(`${KEYS.PUSH.EP}${id}`, n, 'EX', 43200).sadd(KEYS.PUSH.ACTIVE, n).exec();
    notifyTrackers(c);
    return { success: true, subscribed: true };
}));
router.post("/api/push/unsubscribe", pushLimiter, H(async req => {
    const ep = req.body?.endpoint; if(typeof ep !== 'string' || ep.length > 1000) throw new Error("無效訂閱");
    const id = pushId(ep), n = await redis.get(`${KEYS.PUSH.EP}${id}`);
    if(n) await redis.multi().hdel(`${KEYS.PUSH.SUB}${n}`, id).del(`${KEYS.PUSH.EP}${id}`).exec();
}));

module.exports = router;
