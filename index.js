/* Server v18.15 - 包含讀寫分離、卡片隱藏權限控制、叫號開關、MAX 進度解耦與前台文字自定義 (安全性 / 穩定性修正) */
require('dotenv').config();
const { Server } = require("http"), express = require("express"), socketio = require("socket.io"), Redis = require("ioredis"),
      helmet = require('helmet'), rateLimit = require('express-rate-limit'), crypto = require('crypto'),
      bcrypt = require('bcrypt'), line = require('@line/bot-sdk'), cron = require('node-cron'), webpush = require('web-push'),
      path = require("path"), sqlite3 = require('sqlite3').verbose(), app = express();

const { PORT = 3000, UPSTASH_REDIS_URL: REDIS_URL, ADMIN_TOKEN, LINE_ACCESS_TOKEN: LAT, LINE_CHANNEL_SECRET: LCS, ALLOWED_ORIGINS } = process.env;
if (!ADMIN_TOKEN || !REDIS_URL) { console.error("❌ Missing ADMIN_TOKEN or REDIS_URL"); process.exit(1); }

const DB_FLUSH_INTERVAL = 5000, SESSION_TTL = 28800;

const DEFAULT_ROLES = {
    OPERATOR: { level: 1, can: ['perm_command', 'perm_issue', 'perm_passed_view', 'perm_passed_edit', 'perm_booking_view'] },
    MANAGER: { level: 2, can: ['perm_command', 'perm_issue', 'perm_passed_view', 'perm_passed_edit', 'perm_booking_view', 'perm_booking_edit', 'perm_stats_view', 'perm_logs_view', 'perm_system_view', 'perm_links_view', 'perm_links_edit', 'perm_online_view', 'perm_users_view'] },
    ADMIN: { level: 9, can: ['*'] }
};
const VALID_ROLES = ['OPERATOR', 'MANAGER', 'ADMIN'], DEFAULT_HOURS = { enabled: false, start: "08:00", end: "22:00" };
const FRONTEND_TEXT_KEYS = ['brand_title', 'cur', 'iss', 'wait_count', 'online', 'help', 'take', 'man_t', 'man_p', 'track', 'recall_badge', 'sys_close', 'sys_close_desc', 'counter_to'];

// FRONTEND_TEXTS 用於儲存前台自定義文字
const KEYS = { CURRENT: 'callsys:number', MAX: 'callsys:max', ISSUED: 'callsys:issued', MODE: 'callsys:mode', PASSED: 'callsys:passed', FEATURED: 'callsys:featured', LOGS: 'callsys:admin-log', USERS: 'callsys:users', NICKS: 'callsys:nicknames', USER_ROLES: 'callsys:user_roles', SESSION: 'callsys:session:', HISTORY: 'callsys:stats:history', HOURLY: 'callsys:stats:hourly:', ROLES: 'callsys:config:roles', HOURS: 'callsys:config:hours', FRONTEND_TEXTS: 'callsys:config:frontend_texts', CANCELLED: 'callsys:cancelled', COUNTER: 'callsys:counter', RECENT: 'callsys:recent', TICKET: 'callsys:ticket:', EPOCH: 'callsys:epoch', APPROACHED: 'callsys:notify:approached', PUSH: { VAPID: 'callsys:push:vapid', SUB: 'callsys:push:sub:', EP: 'callsys:push:ep:', ACTIVE: 'callsys:push:active' }, LINE: { SUB: 'callsys:line:notify:', USER: 'callsys:line:user:', PWD: 'callsys:line:unlock_pwd', ADMIN: 'callsys:line:admin_session:', CTX: 'callsys:line:context:', ACTIVE: 'callsys:line:active_subs_set', CFG_TOKEN: 'callsys:line:cfg:token', CFG_SECRET: 'callsys:line:cfg:secret', MSG: { APPROACH: 'callsys:line:msg:approach', ARRIVAL: 'callsys:line:msg:arrival', SUCCESS: 'callsys:line:msg:success', PASSED: 'callsys:line:msg:passed', CANCEL: 'callsys:line:msg:cancel', DEFAULT: 'callsys:line:msg:default', HELP: 'callsys:line:msg:help', LOGIN_PROMPT: 'callsys:line:msg:login_prompt', LOGIN_SUCCESS: 'callsys:line:msg:login_success', NO_TRACKING: 'callsys:line:msg:no_tracking', NO_PASSED: 'callsys:line:msg:no_passed', PASSED_PREFIX: 'callsys:line:msg:passed_prefix' }, CMD: { LOGIN: 'callsys:line:cmd:login', STATUS: 'callsys:line:cmd:status', CANCEL: 'callsys:line:cmd:cancel', PASSED: 'callsys:line:cmd:passed', HELP: 'callsys:line:cmd:help' }, AUTOREPLY: 'callsys:line:autoreply_rules' } };
const S_KEYS = { SOUND: 'callsys:soundEnabled', PUBLIC: 'callsys:isPublic', ALLOW_T: 'callsys:allowTicketing' };

// LINE 訊息 / 指令欄位與預設值 (callback、get、save 共用，避免三處預設值不一致)
const LINE_MSG_FIELDS = { approach: 'APPROACH', arrival: 'ARRIVAL', success: 'SUCCESS', passed: 'PASSED', cancel: 'CANCEL', help: 'HELP', loginPrompt: 'LOGIN_PROMPT', loginSuccess: 'LOGIN_SUCCESS', noTracking: 'NO_TRACKING', noPassed: 'NO_PASSED', passedPrefix: 'PASSED_PREFIX' };
const LINE_MSG_DEFAULTS = { approach: '🔔 {target}號快到了 (前方剩{diff}組)', arrival: '🎉 {current}號 到您了！請前往{counter}', success: '設定成功: {number}號', passed: '已過號', cancel: '已取消', help: '💡 請輸入數字', loginPrompt: '請輸入密碼', loginSuccess: '🔓 驗證成功', noTracking: '無追蹤', noPassed: '無過號', passedPrefix: '⚠️ 過號：' };
const LINE_CMD_DEFAULTS = { login: '後台登入', status: 'status,?,查詢,查詢進度', cancel: 'cancel,取消,取消提醒', passed: 'passed,過號,過號名單', help: 'help,提醒,設定提醒' };

app.disable('x-powered-by'); app.set('trust proxy', 1); app.use(helmet({ contentSecurityPolicy: false })); app.use(express.static(path.join(__dirname, "public")));
const server = Server(app), io = socketio(server, { cors: { origin: ALLOWED_ORIGINS ? ALLOWED_ORIGINS.split(',') : ["http://localhost:3000"], methods: ["GET", "POST"], credentials: true }, pingTimeout: 60000 });
// Upstash 必須使用 TLS；其他 redis:// (例如 Render Key Value 內網) 不強制 TLS
const useTLS = REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash.io');
const redis = new Redis(REDIS_URL, { ...(useTLS ? { tls: { rejectUnauthorized: false } } : {}), maxRetriesPerRequest: 3, retryStrategy: t => Math.min(t * 50, 2000) });
// 連線失敗時 ioredis 會持續重試，同一錯誤每分鐘只記錄一次，避免洗版
let lastRedisErr = '', lastRedisErrAt = 0;
redis.on('error', e => {
    if (e.message === lastRedisErr && Date.now() - lastRedisErrAt < 60000) return;
    lastRedisErr = e.message; lastRedisErrAt = Date.now();
    console.error('Redis Error:', e.message, e.code === 'ENOTFOUND' ? '→ 找不到 Redis 主機：請確認 UPSTASH_REDIS_URL 是否正確，或 Upstash 資料庫是否已被刪除' : '');
});
// 每次連上 (含斷線重連) 都重新初始化，避免啟動時 Redis 不可用導致 LINE 推播永遠未啟用
redis.on('ready', () => {
    lastRedisErr = ''; console.log('✅ Redis Ready');
    initLine().catch(e => console.error("LINE Init Error:", e.message));
    initPush();
    redis.setnx(KEYS.ROLES, JSON.stringify(DEFAULT_ROLES)).catch(e => console.error("Roles Init Error:", e.message));
});
const db = new sqlite3.Database(path.join(__dirname, 'callsys.db')), dbQueue = [];

let lineClient = null;
const initLine = async () => { const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); if ((t||LAT) && (s||LCS)) lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: t||LAT }); else { lineClient = null; console.warn("⚠️ LINE Token Missing"); } };

// Web Push 金鑰：優先使用環境變數；未設定時自動產生並存在 Redis，重啟後沿用 (換金鑰會讓既有訂閱失效)
let pushReady = false, vapidPublic = null;
const initPush = async () => {
    try {
        let k = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
        if (!k.publicKey || !k.privateKey) {
            k = safeJSON(await redis.get(KEYS.PUSH.VAPID));
            if (!k) { const g = webpush.generateVAPIDKeys(); k = (await redis.set(KEYS.PUSH.VAPID, JSON.stringify(g), 'NX')) ? g : safeJSON(await redis.get(KEYS.PUSH.VAPID)); }
        }
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:admin@localhost', k.publicKey, k.privateKey);
        vapidPublic = k.publicKey; pushReady = true;
    } catch (e) { pushReady = false; console.error("Push Init Error:", e.message); }
};

const initDB = () => new Promise((res, rej) => db.serialize(() => { db.run("PRAGMA journal_mode=WAL;"); db.run(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, date_str TEXT, timestamp INTEGER, number INTEGER, action TEXT, operator TEXT, wait_time_min REAL)`); db.run(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY, number INTEGER, scheduled_time INTEGER, status TEXT DEFAULT 'pending')`); db.run("CREATE INDEX IF NOT EXISTS idx_history_date ON history(date_str)"); db.run("CREATE INDEX IF NOT EXISTS idx_history_action_ts ON history(action, timestamp)"); db.run("CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp)", e => e ? rej(e) : (console.log("✅ DB Ready"), res())); }));
// 批次寫入歷史紀錄 (定時器與關機流程共用)
const flushDB = () => new Promise(res => {
    if (!dbQueue.length) return res();
    const batch = dbQueue.splice(0);
    db.serialize(() => { db.run("BEGIN TRANSACTION"); const s = db.prepare("INSERT INTO history (date_str, timestamp, number, action, operator, wait_time_min) VALUES (?, ?, ?, ?, ?, ?)"); batch.forEach(r => s.run([r.dateStr, r.timestamp, r.number, r.action, r.operator, r.wait_time_min])); s.finalize(); db.run("COMMIT", e => { if (e) { console.error("Batch Error:", e); db.run("ROLLBACK", () => {}); } res(); }); });
});
setInterval(flushDB, DB_FLUSH_INTERVAL);
const dbQ = (m, s, p=[]) => new Promise((res, rej) => db[m](s, p, function(e, r){ e ? rej(e) : res(m==='run'?this:r) })), [run, all, get] = ['run', 'all', 'get'].map(m => (s, p) => dbQ(m, s, p));

// 一般叫號：從 MAX 往後找第一個不在略過清單 (ARGV：預約保留號 / 客人已取消) 的號碼
redis.defineCommand("safeNextNumber", { numberOfKeys: 3, lua: `local m=tonumber(redis.call("GET",KEYS[1])) local c=tonumber(redis.call("GET",KEYS[2])) or 0 if not m then m=c end local i=tonumber(redis.call("GET",KEYS[3])) or 0 local s={} for _,v in ipairs(ARGV) do s[tonumber(v)]=true end local n=m+1 while n<=i and s[n] do n=n+1 end if n<=i then redis.call("SET",KEYS[1],n) redis.call("SET",KEYS[2],n) return n else return -1 end` });
// 發號：略過預約保留號，避免現場客人拿到與預約相同的號碼
redis.defineCommand("safeIssue", { numberOfKeys: 1, lua: `local i=(tonumber(redis.call("GET",KEYS[1])) or 0)+1 local s={} for _,v in ipairs(ARGV) do s[tonumber(v)]=true end while s[i] do i=i+1 end redis.call("SET",KEYS[1],i) return i` });
// 上一號：目前是預約號 (大於 MAX) 時回到一般進度，否則遞減
redis.defineCommand("decrIfPositive", { numberOfKeys: 2, lua: `local c=tonumber(redis.call("GET",KEYS[1])) or 0 local m=tonumber(redis.call("GET",KEYS[2])) or c if c > m then redis.call("SET",KEYS[1],m) return m end if c > 0 then local nc=c-1 redis.call("SET",KEYS[1],nc) if m==c then redis.call("SET",KEYS[2],nc) end return nc end return c` });

const TW_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const getTWTime = () => { const p = Object.fromEntries(TW_FMT.formatToParts(new Date()).map(x => [x.type, x.value])); return { dateStr: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour) % 24, minute: parseInt(p.minute) }; };
const addLog = async (n, m) => { const t = new Date().toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}), l = `[${t}] [${n}] ${m}`; await redis.multi().lpush(KEYS.LOGS, l).ltrim(KEYS.LOGS, 0, 99).exec(); io.to("admin").emit("newAdminLog", l); };
const parseCookie = s => { try { return s.split(';').reduce((a, v) => { const [k, ...rest] = v.split('='); if(k) a[k.trim()] = decodeURIComponent(rest.join('=').trim()); return a; }, {}); } catch(e) { return {}; } };
const validateNum = (n, min=0, max=99999) => { const v = parseInt(n, 10); return (!isNaN(v) && v >= min && v <= max) ? v : null; };
const safeJSON = (s, fb = null) => { try { return JSON.parse(s) ?? fb; } catch (e) { return fb; } };
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const isAdminUser = u => u?.role === 'super' || u?.userRole === 'ADMIN';
const isSafeUrl = u => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch (e) { return false; } };
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const bumpHourly = (suffix, delta = 1) => { const { dateStr, hour } = getTWTime(), k = `${KEYS.HOURLY}${dateStr}`; return redis.multi().hincrby(k, `${hour}_${suffix}`, delta).expire(k, 172800).exec(); };
const netHourly = h => Array.from({ length: 24 }, (_, i) => h ? Math.max(0, parseInt(h[`${i}_i`]||h[i]||0) - parseInt(h[`${i}_p`]||0) - parseInt(h[`${i}_c`]||0)) : 0);
const cleanCounter = v => String(v ?? '').replace(/[\r\n<>]/g, '').trim().slice(0, 12);
// 預約保留號 (待叫 + 今日已叫)：一般叫號與發號都會略過
const getReserved = async () => (await all("SELECT number FROM appointments WHERE status IN ('pending','called')")).map(r => String(r.number));
const nextRegular = async () => { const [res, can] = await Promise.all([getReserved(), redis.zrange(KEYS.CANCELLED, 0, -1)]); return redis.safeNextNumber(KEYS.MAX, KEYS.CURRENT, KEYS.ISSUED, ...new Set([...res, ...can])); };
const issueNext = async () => redis.safeIssue(KEYS.ISSUED, ...(await getReserved()));
// 記錄叫號櫃台與最近叫號清單 (多櫃台顯示用)
const recordCall = (n, counter) => redis.multi().set(KEYS.COUNTER, counter).lpush(KEYS.RECENT, JSON.stringify({ n, c: counter, t: Date.now() })).ltrim(KEYS.RECENT, 0, 5).exec();
const getFeatured = async () => (await redis.lrange(KEYS.FEATURED, 0, -1)).map(x => safeJSON(x)).filter(Boolean);
const emitFeatured = async () => io.emit("updateFeaturedContents", await getFeatured());
const emitPassed = async () => io.emit("updatePassed", (await redis.zrange(KEYS.PASSED, 0, -1)).map(Number));
const getLineMsgs = async () => { const f = Object.keys(LINE_MSG_FIELDS), v = await redis.mget(...f.map(k => KEYS.LINE.MSG[LINE_MSG_FIELDS[k]])); return Object.fromEntries(f.map((k, i) => [k, v[i] || LINE_MSG_DEFAULTS[k]])); };
const getLineCmds = async () => { const f = Object.keys(LINE_CMD_DEFAULTS), v = await redis.mget(...f.map(k => KEYS.LINE.CMD[k.toUpperCase()])); return Object.fromEntries(f.map((k, i) => [k, v[i] || LINE_CMD_DEFAULTS[k]])); };
let bCastT = null, cacheWait = 0, lastWaitCalc = 0;

// 佇列狀態 (廣播與新連線共用)
// 叫預約號時 CURRENT 可能大於 MAX，此時不可把 MAX / ISSUED 往上修正，否則中間的號碼會被跳過
// waiting 扣除 MAX 之後已取消的號碼；skip 讓前台計算個人前方組數
const getQueueState = async (fix) => {
    const [[c, i, m, counter], cancelled, recent] = await Promise.all([redis.mget(KEYS.CURRENT, KEYS.ISSUED, KEYS.MAX, KEYS.COUNTER), redis.zrange(KEYS.CANCELLED, 0, -1), redis.lrange(KEYS.RECENT, 0, 5)]);
    const current = parseInt(c)||0, max = m === null ? current : (parseInt(m)||0); let issued = parseInt(i)||0;
    if (fix) { const f = []; if (m === null) f.push(KEYS.MAX, max); if (issued < max) f.push(KEYS.ISSUED, issued = max); if (f.length) await redis.mset(...f); }
    const skip = cancelled.map(Number).filter(n => n > max && n <= issued);
    return { current, issued, max, waiting: Math.max(0, issued - max - skip.length), skip, counter: counter || '', recent: recent.map(x => safeJSON(x)).filter(Boolean) };
};
const broadcastQueue = () => { clearTimeout(bCastT); bCastT = setTimeout(async () => { try { const q = await getQueueState(true); io.emit("update", q.current); io.emit("updateQueue", q); io.emit("updateWaitTime", await calcWaitTime()); io.emit("updateTimestamp", new Date().toISOString()); } catch(e) { console.error("Broadcast Error:", e.message); } }, 100); };
const broadcastAppts = async (target = io.to("admin")) => target.emit("updateAppointments", await all("SELECT * FROM appointments WHERE status='pending' ORDER BY scheduled_time ASC"));

// 只計算「往前推進」的動作 (一般叫號、叫預約、過號)，排除上一號 / 手動設定；並納入尚未寫入 DB 的紀錄
const ADVANCE_ACTIONS = ['call', 'call_appt', 'pass'];
const calcWaitTime = async (force) => {
    if (!force && Date.now() - lastWaitCalc < 30000) return cacheWait;
    const dbRows = await all(`SELECT timestamp FROM history WHERE action IN (${ADVANCE_ACTIONS.map(() => '?').join(',')}) ORDER BY timestamp DESC LIMIT 30`, ADVANCE_ACTIONS);
    const rows = [...dbRows, ...dbQueue.filter(r => ADVANCE_ACTIONS.includes(r.action))].map(r => r.timestamp).sort((a, b) => b - a).slice(0, 30);
    lastWaitCalc = Date.now();
    if (rows.length < 2) return (cacheWait = 0);
    const MIN_MS = 10 * 1000, MAX_MS = 10 * 60 * 1000, valid = [];
    for (let i = 0; i < rows.length - 1; i++) { const diff = rows[i] - rows[i + 1]; if (diff >= MIN_MS && diff <= MAX_MS) valid.push(diff); }
    if (!valid.length) return cacheWait;
    return (cacheWait = Math.ceil((valid.reduce((a, v) => a + v, 0) / valid.length / 60000) * 10) / 10);
};

const getHours = async () => safeJSON(await redis.get(KEYS.HOURS), DEFAULT_HOURS);
const isBusinessOpen = async () => {
    const c = await getHours(); if (!c.enabled) return true;
    const { hour, minute } = getTWTime(), cur = hour * 60 + minute;
    const toMins = t => { if (typeof t === 'number') return t * 60; const [h, m] = String(t || "00:00").split(':').map(Number); return (h||0) * 60 + (m||0); };
    const s = toMins(c.start), e = toMins(c.end);
    if (s === e) return true;
    return s < e ? (cur >= s && cur < e) : (cur >= s || cur < e); // s > e 代表跨夜營業 (例如 18:00-02:00)
};

// 到號 / 快到號通知 (LINE + Web Push)
// 到號：號碼等於目前叫號，或已被一般進度 (MAX) 越過 → 叫號一次跳好幾號時，中間的人也會收到
// 快到：距離一般進度 APPROACH_DIFF 組以內，每位訂閱者每個號碼只通知一次
const APPROACH_DIFF = 5;
async function notifyTrackers(current) {
    try {
        const [[m, counter, fTexts], lineNums, pushNums] = await Promise.all([redis.mget(KEYS.MAX, KEYS.COUNTER, KEYS.FRONTEND_TEXTS), redis.smembers(KEYS.LINE.ACTIVE), redis.smembers(KEYS.PUSH.ACTIVE)]);
        const nums = [...new Set([...lineNums, ...pushNums])].map(Number).filter(n => n > 0);
        if (!nums.length) return;
        const max = m === null ? current : (parseInt(m)||0), M = await getLineMsgs(), title = safeJSON(fTexts, {}).brand_title || '即時叫號系統';
        const sendLine = (ids, txt) => { if (!lineClient) return; for (let k = 0; k < ids.length; k += 500) lineClient.multicast({ to: ids.slice(k, k + 500), messages: [{ type: 'text', text: txt }] }).catch(e => console.error("LINE Push Error:", e.message)); };
        const sendPush = (n, subs, body) => { if (!pushReady) return; Object.entries(subs).forEach(([id, json]) => { const s = safeJSON(json); if (s) webpush.sendNotification(s, JSON.stringify({ title, body, tag: `callsys-${n}` }), { TTL: 900 }).catch(e => { if ([404, 410].includes(e.statusCode)) redis.hdel(`${KEYS.PUSH.SUB}${n}`, id).catch(() => {}); else console.error("Web Push Error:", e.statusCode || e.message); }); }); };
        for (const n of nums) {
            const arrived = n === current || n <= max, near = !arrived && n - max <= APPROACH_DIFF;
            if (!arrived && !near) continue;
            const [uids, subs] = await Promise.all([redis.smembers(`${KEYS.LINE.SUB}${n}`), redis.hgetall(`${KEYS.PUSH.SUB}${n}`)]);
            if (arrived) {
                const txt = M.arrival.replace(/{current}/g, n).replace(/{number}/g, n).replace(/{counter}/g, counter || '櫃台');
                sendLine(uids, txt); sendPush(n, subs, txt);
                const p = redis.multi().del(`${KEYS.LINE.SUB}${n}`, `${KEYS.PUSH.SUB}${n}`).srem(KEYS.LINE.ACTIVE, n).srem(KEYS.PUSH.ACTIVE, n);
                if (uids.length) p.del(...uids.map(u => `${KEYS.LINE.USER}${u}`));
                await p.exec();
            } else {
                const members = [...uids.map(u => `${n}:L:${u}`), ...Object.keys(subs).map(id => `${n}:P:${id}`)];
                if (!members.length) continue;
                const r = await members.reduce((p, x) => p.sadd(KEYS.APPROACHED, x), redis.multi()).expire(KEYS.APPROACHED, 43200).exec();
                const fresh = new Set(members.filter((_, k) => r[k][1] === 1)), txt = M.approach.replace(/{current}/g, current).replace(/{target}/g, n).replace(/{diff}/g, n - max);
                sendLine(uids.filter(u => fresh.has(`${n}:L:${u}`)), txt);
                sendPush(n, Object.fromEntries(Object.entries(subs).filter(([id]) => fresh.has(`${n}:P:${id}`))), txt);
            }
        }
    } catch (e) { console.error("notifyTrackers Error:", e.message); }
}

app.post('/callback', async (req, res) => {
    try {
        const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET), cfg = { channelAccessToken: t||LAT, channelSecret: s||LCS };
        if (!cfg.channelAccessToken || !cfg.channelSecret) return res.status(500).end();
        line.middleware(cfg)(req, res, async (err) => {
            if (err) return res.status(403).json({ error: "Invalid Signature" });
            if (!lineClient) lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: cfg.channelAccessToken });
            try {
                const events = (req.body.events || []).filter(e => e.type === 'message' && e.message?.type === 'text' && e.source?.userId);
                if (!events.length) return res.json({});
                const [cmd, M, mDef] = await Promise.all([getLineCmds(), getLineMsgs(), redis.get(KEYS.LINE.MSG.DEFAULT)]);
                await Promise.all(events.map(async e => {
                    const txt = e.message.text.trim(), low = txt.toLowerCase(), uid = e.source.userId, rp = x => lineClient.replyMessage({ replyToken: e.replyToken, messages: [{ type: 'text', text: x }] }).catch(console.error);
                    const inList = s => String(s).split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(low);

                    if(txt === cmd.login.trim()) return rp((await redis.get(`${KEYS.LINE.ADMIN}${uid}`)) ? `🔗 ${process.env.RENDER_EXTERNAL_URL || ''}/admin.html` : (await redis.set(`${KEYS.LINE.CTX}${uid}`,'WAIT_PWD','EX',120), M.loginPrompt));
                    if((await redis.get(`${KEYS.LINE.CTX}${uid}`))==='WAIT_PWD' && safeEqual(txt, (await redis.get(KEYS.LINE.PWD)) || `unlock${ADMIN_TOKEN}`)) { await redis.multi().set(`${KEYS.LINE.ADMIN}${uid}`,"1","EX",600).del(`${KEYS.LINE.CTX}${uid}`).exec(); return rp(M.loginSuccess); }
                    const ar = await redis.hget(KEYS.LINE.AUTOREPLY, txt); if (ar) return rp(ar);
                    if(inList(cmd.status)) { const [n,i,my]=await redis.mget(KEYS.CURRENT,KEYS.ISSUED,`${KEYS.LINE.USER}${uid}`); return rp(`目前叫號: ${n||0}\n已發號至: ${i||0}${my?`\n您的追蹤: ${my}號`:''}`); }
                    if(inList(cmd.cancel)) { const n=await redis.get(`${KEYS.LINE.USER}${uid}`); if(n){await redis.multi().del(`${KEYS.LINE.USER}${uid}`).srem(`${KEYS.LINE.SUB}${n}`,uid).exec(); return rp(M.cancel);} return rp(M.noTracking); }
                    if(inList(cmd.passed)) { const l = await redis.zrange(KEYS.PASSED, 0, -1); return rp(l.length ? `${M.passedPrefix}\n${l.join(', ')}` : M.noPassed); }
                    if(inList(cmd.help)) return rp(M.help);
                    if(/^\d{1,5}$/.test(txt)) {
                        // 以一般進度 (MAX) 判斷是否已過號；叫預約號時 CURRENT 可能大於 MAX
                        const n=parseInt(txt), [cRaw, mRaw]=await redis.mget(KEYS.CURRENT, KEYS.MAX), c=parseInt(cRaw)||0, mx=mRaw===null?c:(parseInt(mRaw)||0); if(n<=mx || n===c) return rp(M.passed);
                        const old = await redis.get(`${KEYS.LINE.USER}${uid}`), p = redis.multi();
                        if (old && old !== String(n)) p.srem(`${KEYS.LINE.SUB}${old}`, uid); // 改追蹤新號碼時，移除舊號碼的訂閱
                        await p.set(`${KEYS.LINE.USER}${uid}`,n,'EX',43200).sadd(`${KEYS.LINE.SUB}${n}`,uid).expire(`${KEYS.LINE.SUB}${n}`,43200).sadd(KEYS.LINE.ACTIVE,n).exec();
                        setTimeout(() => notifyTrackers(c), 1500); // 已在 5 組以內時，接在設定成功訊息之後發送快到號通知
                        return rp(M.success.replace(/{number}/g, n));
                    }
                    if (mDef && mDef.trim()) return rp(mDef);
                }));
                res.json({});
            } catch (e) { console.error(e); res.status(500).end(); }
        });
    } catch (e) { res.status(500).end(); }
});

app.use(express.json());
app.get('/health', async (req, res) => { if (redis.status !== 'ready') return res.status(503).json({ status: 'error', redis: false, message: `Redis ${redis.status}` }); try { await redis.ping(); const dbOk = await new Promise(r => db.get("SELECT 1", e => r(!e))); res.json({ status: 'ok', uptime: Math.floor(process.uptime()), redis: true, db: dbOk }); } catch(e) { res.status(503).json({ status: 'error', message: e.message }); } });
const H = fn => async(req, res, next) => { try { const r = await fn(req, res); if(r!==false) res.json(r||{success:true}); } catch(e){ res.status(500).json({error:e.message}); } };

// Session 驗證：失效回傳 401 (前端據此登出)；一般帳號每次驗證時同步角色 / 暱稱，刪除帳號後 Session 立即失效
const auth = async (req, res, next) => {
    let u = null;
    const t = parseCookie(req.headers.cookie||'')['token'];
    try {
        u = t ? safeJSON(await redis.get(`${KEYS.SESSION}${t}`)) : null;
        if (u) {
            const [exists, role, nick] = await Promise.all([u.role === 'super' ? 1 : redis.hexists(KEYS.USERS, u.username), redis.hget(KEYS.USER_ROLES, u.username), redis.hget(KEYS.NICKS, u.username)]);
            if (!exists) { await redis.del(`${KEYS.SESSION}${t}`); u = null; }
            else { if (u.role !== 'super') u.userRole = role || 'OPERATOR'; u.nickname = nick || u.username; redis.expire(`${KEYS.SESSION}${t}`, SESSION_TTL).catch(() => {}); }
        }
    } catch (e) { return res.status(500).json({ error: e.message }); }
    if (!u) return res.status(401).json({ error: "Session 失效，請重新登入" });
    req.user = u; next();
};
let rolesCache = null, rolesCacheAt = 0;
const getRoles = async () => { if (!rolesCache || Date.now() - rolesCacheAt > 10000) { rolesCache = safeJSON(await redis.get(KEYS.ROLES), DEFAULT_ROLES); rolesCacheAt = Date.now(); } return rolesCache; };
const hasPerm = async (u, a) => { if (isAdminUser(u)) return true; const r = (await getRoles())[u.userRole || 'OPERATOR'] || DEFAULT_ROLES.OPERATOR; return r.level >= 9 || !!r.can?.includes(a) || !!r.can?.includes('*'); };
const perm = (a) => async (req, res, next) => { let ok = false; try { ok = await hasPerm(req.user, a); } catch (e) { return res.status(500).json({ error: e.message }); } ok ? next() : res.status(403).json({ error: "權限不足" }); };

async function ctl(type, {body, user}) {
    const isSet = type === 'set_call' || type === 'set_issue', setNum = isSet ? validateNum(body.number) : null, counter = cleanCounter(body.counter), at = counter ? ` @${counter}` : '';
    if(isSet && setNum === null) return { error: "非法數值" };
    if(['call','issue'].includes(type) && !(await isBusinessOpen())) return { error: "非營業時間" };
    const dir = body.direction, { dateStr } = getTWTime(), [curr, issued, mx] = (await redis.mget(KEYS.CURRENT, KEYS.ISSUED, KEYS.MAX)).map(v => parseInt(v)||0);
    let newNum=0, msg='', action=type;
    if(type === 'call') {
        if(dir==='next') {
            const appt = await get("SELECT id, number FROM appointments WHERE status='pending' AND scheduled_time <= ? ORDER BY scheduled_time ASC LIMIT 1", [Date.now()]);
            // 叫預約號不推進 MAX，下一個一般號碼仍從原本進度接續，避免中間號碼被跳過
            if(appt) { newNum = appt.number; await redis.set(KEYS.CURRENT, newNum); await run("UPDATE appointments SET status='called' WHERE id=?", [appt.id]); msg=`🔔 呼叫預約 ${newNum}${at}`; action='call_appt'; broadcastAppts().catch(()=>{}); }
            else { if((newNum = await nextRegular()) === -1) return { error: "已無等待" }; msg=`號碼增加為 ${newNum}${at}`; }
            await recordCall(newNum, counter);
        }
        else { newNum = await redis.decrIfPositive(KEYS.CURRENT, KEYS.MAX); msg=`號碼回退為 ${newNum}`; action='call_prev'; }
        notifyTrackers(newNum);
    } else if(type === 'issue') {
        if(dir==='next') { newNum = await issueNext(); msg=`手動發號 ${newNum}`; await bumpHourly('i'); }
        else if(issued > Math.max(curr, mx)) { newNum = await redis.decr(KEYS.ISSUED); msg=`手動回退 ${newNum}`; await bumpHourly('i', -1); }
        else return { error: "發號數不可小於目前叫號" };
    } else if(type === 'set_issue') {
        newNum = setNum; if(newNum===0) return resetSys(user.nickname);
        const diff = newNum - issued; if(diff) await bumpHourly('i', diff); await redis.set(KEYS.ISSUED, newNum); msg=`修正發號 ${newNum}`;
    } else { /* set_call */ newNum = setNum; await redis.mset(KEYS.CURRENT, newNum, KEYS.MAX, newNum, ...(newNum>issued?[KEYS.ISSUED, newNum]:[])); msg=`設定叫號 ${newNum}${at}`; if(newNum) await recordCall(newNum, counter); notifyTrackers(newNum); }
    if(msg) { addLog(user.nickname, msg); dbQueue.push({dateStr, timestamp: Date.now(), number: newNum||curr, action, operator: user.nickname, wait_time_min: await calcWaitTime()}); } broadcastQueue(); return { number: newNum };
}
async function resetSys(by) {
    // 一併清除 LINE / Web Push 追蹤、取消名單與櫃台紀錄，避免隔天相同號碼誤發通知；EPOCH +1 讓舊的線上取號憑證失效
    const [active, pushActive] = await Promise.all([redis.smembers(KEYS.LINE.ACTIVE), redis.smembers(KEYS.PUSH.ACTIVE)]), subKeys = active.map(n => `${KEYS.LINE.SUB}${n}`);
    const uids = subKeys.length ? (await Promise.all(subKeys.map(k => redis.smembers(k)))).flat() : [];
    const p = redis.multi().mset(KEYS.CURRENT,0,KEYS.ISSUED,0,KEYS.MAX,0).del(KEYS.PASSED, KEYS.LINE.ACTIVE, KEYS.CANCELLED, KEYS.COUNTER, KEYS.RECENT, KEYS.APPROACHED, KEYS.PUSH.ACTIVE).incr(KEYS.EPOCH);
    if (subKeys.length) p.del(...subKeys); if (uids.length) p.del(...[...new Set(uids)].map(u => `${KEYS.LINE.USER}${u}`));
    if (pushActive.length) p.del(...pushActive.map(n => `${KEYS.PUSH.SUB}${n}`));
    await p.exec();
    await run("UPDATE appointments SET status='cancelled' WHERE status='pending'");
    await run("UPDATE appointments SET status='done' WHERE status='called'");
    addLog(by, "💥 全域重置"); cacheWait=0; broadcastQueue(); broadcastAppts().catch(()=>{}); io.emit("updatePassed",[]); return {};
}

app.post("/login", rateLimit({windowMs:9e5,max:100}), H(async (req, res) => {
    const { username: u, password: p } = req.body || {};
    if(typeof u !== 'string' || typeof p !== 'string' || !u || !p) throw new Error("帳號或密碼錯誤");
    let valid = u === 'superadmin' && safeEqual(p.trim(), ADMIN_TOKEN.trim());
    if(!valid && u !== 'superadmin') { const hash = await redis.hget(KEYS.USERS, u); if(hash) valid = await bcrypt.compare(p, hash); }
    if(!valid) throw new Error("帳號或密碼錯誤");
    const token = crypto.randomUUID(), nick = await redis.hget(KEYS.NICKS, u) || u, userRole = (u==='superadmin' ? 'ADMIN' : (await redis.hget(KEYS.USER_ROLES, u) || 'OPERATOR'));
    await redis.set(`${KEYS.SESSION}${token}`, JSON.stringify({username:u, role:u==='superadmin'?'super':'normal', userRole, nickname:nick}), "EX", SESSION_TTL);
    res.setHeader('Set-Cookie', [`token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL}; SameSite=Strict${process.env.NODE_ENV==='production'?'; Secure':''}`]);
    return { success: true, role: u==='superadmin'?'super':'normal', userRole, username: u, nickname: nick };
}));
app.post("/logout", async (req, res) => { const t = parseCookie(req.headers.cookie||'')['token']; if(t) await redis.del(`${KEYS.SESSION}${t}`).catch(()=>{}); res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict'); res.json({ success: true }); });
app.post("/api/admin/me", auth, H(async r => ({ username: r.user.username, role: r.user.role, userRole: r.user.userRole, nickname: r.user.nickname })));

// 線上取號憑證：HttpOnly Cookie 對應號碼 (值為 `EPOCH:號碼`，全域重置後自動失效)
// 同一裝置尚未叫到的號碼直接回傳，不重複發號；IP 上限放寬，避免店內共用 Wi-Fi 的客人被擋
const TICKET_TTL = 43200, TICKET_COOKIE = 'callsys_tk', UUID_RE = /^[0-9a-f-]{36}$/;
const readTicket = async req => {
    const tk = parseCookie(req.headers.cookie||'')[TICKET_COOKIE]; if(!UUID_RE.test(tk||'')) return { tk: null, num: 0 };
    const [saved, epoch, c, m] = await redis.mget(`${KEYS.TICKET}${tk}`, KEYS.EPOCH, KEYS.CURRENT, KEYS.MAX), [e, n] = String(saved||'').split(':');
    const current = parseInt(c)||0;
    return { tk, epoch: epoch||'0', num: e === String(epoch||'0') ? (parseInt(n)||0) : 0, current, max: m === null ? current : (parseInt(m)||0) };
};
app.post("/api/ticket/take", rateLimit({windowMs:36e5,max:200}), H(async (req, res) => {
    const t0 = await readTicket(req);
    if(t0.num && (t0.num > t0.max || t0.num === t0.current) && !(await redis.zscore(KEYS.CANCELLED, t0.num))) return { success: true, ticket: t0.num, existing: true };
    const [mode, allowT, pub, epoch] = await redis.mget(KEYS.MODE, S_KEYS.ALLOW_T, S_KEYS.PUBLIC, KEYS.EPOCH);
    if(pub === "0") throw new Error("系統暫停服務");
    if(mode==='input') throw new Error("手動模式");
    if(allowT === "0") throw new Error("目前暫停取號");
    if(!(await isBusinessOpen())) throw new Error("非營業時間");
    const t = await issueNext(), tk = t0.tk || crypto.randomUUID(); await bumpHourly('i');
    await redis.set(`${KEYS.TICKET}${tk}`, `${epoch||'0'}:${t}`, 'EX', TICKET_TTL);
    res.setHeader('Set-Cookie', `${TICKET_COOKIE}=${tk}; HttpOnly; Path=/; Max-Age=${TICKET_TTL}; SameSite=Lax${process.env.NODE_ENV==='production'?'; Secure':''}`);
    dbQueue.push({dateStr: getTWTime().dateStr, timestamp: Date.now(), number: t, action: 'online_take', operator: 'User', wait_time_min: await calcWaitTime()}); broadcastQueue(); return { success: true, ticket: t };
}));
// 客人放棄號碼：只接受本裝置線上取得、尚未叫到的號碼；一般叫號會自動略過已取消的號碼
app.post("/api/ticket/cancel", rateLimit({windowMs:9e5,max:30}), H(async req => {
    const t = await readTicket(req), n = validateNum(req.body?.number, 1);
    if(!t.num || t.num !== n) return { success: true, cancelled: false };
    await redis.del(`${KEYS.TICKET}${t.tk}`);
    if(n <= t.max || n === t.current) return { success: true, cancelled: false };
    if(await redis.zadd(KEYS.CANCELLED, 'NX', n, n)) {
        await bumpHourly('c');
        dbQueue.push({dateStr: getTWTime().dateStr, timestamp: Date.now(), number: n, action: 'cancel', operator: 'User', wait_time_min: cacheWait});
        addLog('客人', `🚫 放棄號碼 ${n}`); broadcastQueue();
    }
    return { success: true, cancelled: true };
}));

// Web Push：前台訂閱號碼的背景推播 (手機鎖屏 / 分頁關閉也能收到)
// endpoint 只允許各瀏覽器的推播服務網域，避免伺服器被利用去請求任意網址
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
const isPushEndpoint = u => { try { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.some(h => x.hostname === h || x.hostname.endsWith(`.${h}`)); } catch (e) { return false; } };
const pushId = ep => crypto.createHash('sha256').update(ep).digest('hex').slice(0, 24), pushLimiter = rateLimit({windowMs:9e5,max:60});
app.get("/api/push/key", (req, res) => pushReady ? res.json({ key: vapidPublic }) : res.status(503).json({ error: "推播未啟用" }));
app.post("/api/push/subscribe", pushLimiter, H(async req => {
    if(!pushReady) throw new Error("推播未啟用");
    const n = validateNum(req.body?.number, 1), s = req.body?.subscription;
    if(n === null) throw new Error("無效號碼");
    if(!s || typeof s.endpoint !== 'string' || s.endpoint.length > 1000 || !isPushEndpoint(s.endpoint) || typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string' || s.keys.p256dh.length > 200 || s.keys.auth.length > 100) throw new Error("無效訂閱");
    const [cRaw, mRaw] = await redis.mget(KEYS.CURRENT, KEYS.MAX), c = parseInt(cRaw)||0, mx = mRaw === null ? c : (parseInt(mRaw)||0);
    if(n <= mx || n === c) return { success: true, subscribed: false };
    const id = pushId(s.endpoint), old = await redis.get(`${KEYS.PUSH.EP}${id}`), p = redis.multi();
    if(old && old !== String(n)) p.hdel(`${KEYS.PUSH.SUB}${old}`, id);
    await p.hset(`${KEYS.PUSH.SUB}${n}`, id, JSON.stringify({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } })).expire(`${KEYS.PUSH.SUB}${n}`, 43200).set(`${KEYS.PUSH.EP}${id}`, n, 'EX', 43200).sadd(KEYS.PUSH.ACTIVE, n).exec();
    notifyTrackers(c);
    return { success: true, subscribed: true };
}));
app.post("/api/push/unsubscribe", pushLimiter, H(async req => {
    const ep = req.body?.endpoint; if(typeof ep !== 'string' || ep.length > 1000) throw new Error("無效訂閱");
    const id = pushId(ep), n = await redis.get(`${KEYS.PUSH.EP}${id}`);
    if(n) await redis.multi().hdel(`${KEYS.PUSH.SUB}${n}`, id).del(`${KEYS.PUSH.EP}${id}`).exec();
}));

['call','set-call'].forEach(c => app.post(`/api/control/${c}`, auth, perm('perm_command'), H(async r => { const res = await ctl(c.replace('-','_'), r); if(res.error) throw new Error(res.error); return res; })));
['issue','set-issue'].forEach(c => app.post(`/api/control/${c}`, auth, perm('perm_issue'), H(async r => { const res = await ctl(c.replace('-','_'), r); if(res.error) throw new Error(res.error); return res; })));

app.post("/api/control/pass-current", auth, perm('perm_passed_edit'), H(async req => {
    const c = parseInt(await redis.get(KEYS.CURRENT))||0; if(!c) throw new Error("無叫號");
    const counter = cleanCounter(req.body?.counter), added = await redis.zadd(KEYS.PASSED, c, c), r = await nextRegular();
    if(added) await bumpHourly('p');
    // 沒有下一號時清空目前叫號，避免同一個號碼同時出現在「目前叫號」與「過號名單」
    if(r === -1) await redis.set(KEYS.CURRENT, 0); else await recordCall(r, counter);
    dbQueue.push({dateStr: getTWTime().dateStr, timestamp: Date.now(), number: c, action: 'pass', operator: req.user.nickname, wait_time_min: await calcWaitTime()});
    addLog(req.user.nickname, `⏭️ 過號 ${c}${r === -1 ? '' : ` → ${r}`}${counter ? ` @${counter}` : ''}`); if(r !== -1) notifyTrackers(r); broadcastQueue(); await emitPassed(); return { next: r === -1 ? 0 : r };
}));

// 重呼不改變一般進度 (MAX)，避免目前是預約號時把 MAX 往上推造成跳號
app.post("/api/control/recall-passed", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n === null) throw new Error("非法數值"); const counter = cleanCounter(r.body.counter), [c, m] = await redis.mget(KEYS.CURRENT, KEYS.MAX); await redis.multi().set(KEYS.MAX, m === null ? (parseInt(c)||0) : m).zrem(KEYS.PASSED, n).set(KEYS.CURRENT, n).exec(); await recordCall(n, counter); addLog(r.user.nickname, `↩️ 重呼 ${n}${counter ? ` @${counter}` : ''}`); broadcastQueue(); await emitPassed(); }));

app.post("/api/passed/add", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n === null) throw new Error("非法數值"); if(await redis.zadd(KEYS.PASSED, n, n)) await bumpHourly('p'); await emitPassed(); addLog(r.user.nickname, `➕ 手動過號 ${n}`); }));
app.post("/api/passed/remove", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n !== null && await redis.zrem(KEYS.PASSED, n)) { await bumpHourly('p', -1); await emitPassed(); addLog(r.user.nickname, `🗑️ 移除過號 ${n}`); } }));
app.post("/api/passed/clear", auth, perm('perm_passed_edit'), H(async r => { await redis.del(KEYS.PASSED); io.emit("updatePassed", []); addLog(r.user.nickname, "🗑️ 清空過號名單"); }));

app.post("/api/admin/users", auth, perm('perm_users_view'), H(async () => { const [names, nicks, roles] = await Promise.all([redis.hkeys(KEYS.USERS), redis.hgetall(KEYS.NICKS), redis.hgetall(KEYS.USER_ROLES)]); return { users: [{username:'superadmin', nickname:nicks.superadmin||'Super', role:'ADMIN'}, ...names.filter(n => n!=='superadmin').map(n => ({username:n, nickname:nicks[n]||n, role:roles[n]||'OPERATOR'}))] }; }));
app.post("/api/admin/add-user", auth, perm('perm_users_edit'), H(async r => {
    const { newUsername: u, newPassword: p, newNickname: n, newRole = 'OPERATOR' } = r.body;
    if(typeof u !== 'string' || !/^[^\s<>"'&]{1,32}$/.test(u)) throw new Error("帳號格式錯誤 (1-32 字，不可含空白或 <>\"'&)");
    if(u === 'superadmin') throw new Error("保留帳號，不可建立");
    if(typeof p !== 'string' || p.length < 6) throw new Error("密碼至少 6 碼");
    if(!VALID_ROLES.includes(newRole)) throw new Error("無效角色");
    if(newRole === 'ADMIN' && !isAdminUser(r.user)) throw new Error("僅管理員可建立管理員帳號");
    if(await redis.hexists(KEYS.USERS, u)) throw new Error("已存在");
    await redis.multi().hset(KEYS.USERS, u, await bcrypt.hash(p, 10)).hset(KEYS.NICKS, u, String(n||u).trim().slice(0, 32) || u).hset(KEYS.USER_ROLES, u, newRole).exec();
    addLog(r.user.nickname, `👤 新增帳號 ${u} (${newRole})`);
}));
app.post("/api/admin/del-user", auth, perm('perm_users_edit'), H(async r => {
    const u = r.body.delUsername;
    if(u==='superadmin' || u===r.user.username) throw new Error("不可刪除");
    if((await redis.hget(KEYS.USER_ROLES, u))==='ADMIN' && !isAdminUser(r.user)) throw new Error("權限不足");
    await redis.multi().hdel(KEYS.USERS, u).hdel(KEYS.NICKS, u).hdel(KEYS.USER_ROLES, u).exec(); addLog(r.user.nickname, `👤 刪除帳號 ${u}`);
}));
app.post("/api/admin/set-nickname", auth, H(async r => {
    const { targetUsername: u } = r.body, nick = String(r.body.nickname ?? '').trim().slice(0, 32);
    if(!nick) throw new Error("暱稱不可空白");
    if(r.user.username!==u && !(await hasPerm(r.user, 'perm_users_edit'))) throw new Error("權限不足");
    if(u!=='superadmin' && !(await redis.hexists(KEYS.USERS, u))) throw new Error("帳號不存在");
    await redis.hset(KEYS.NICKS, u, nick);
}));
app.post("/api/admin/set-role", auth, perm('perm_users_edit'), H(async r => { const { targetUsername: u, newRole } = r.body; if(!isAdminUser(r.user)) throw new Error("僅限管理員"); if(!VALID_ROLES.includes(newRole) || u==='superadmin' || !(await redis.hexists(KEYS.USERS, u))) throw new Error("無效操作"); await redis.hset(KEYS.USER_ROLES, u, newRole); addLog(r.user.nickname, `🔧 ${u} 角色改為 ${newRole}`); }));
app.post("/api/admin/roles/get", auth, H(async () => getRoles()));
app.post("/api/admin/roles/update", auth, perm('perm_roles'), H(async r => {
    if(!isAdminUser(r.user)) throw new Error("僅限管理員");
    const cfg = r.body.rolesConfig; if(!cfg || typeof cfg !== 'object') throw new Error("無效設定");
    const clean = { OPERATOR: { level: 1 }, MANAGER: { level: 2 }, ADMIN: { level: 9, can: ['*'] } };
    ['OPERATOR','MANAGER'].forEach(k => clean[k].can = [...new Set((Array.isArray(cfg[k]?.can) ? cfg[k].can : []).filter(p => typeof p === 'string' && /^perm_\w+$/.test(p)))]);
    await redis.set(KEYS.ROLES, JSON.stringify(clean)); rolesCache = clean; rolesCacheAt = Date.now(); addLog(r.user.nickname, "🔧 修改權限");
}));

app.post("/api/admin/stats", auth, perm('perm_stats_view'), H(async () => { const {dateStr, hour} = getTWTime(), counts = netHourly(await redis.hgetall(`${KEYS.HOURLY}${dateStr}`)); return { history: await all("SELECT * FROM history ORDER BY id DESC LIMIT 50"), hourlyCounts: counts, todayCount: counts.reduce((a, v) => a + v, 0), serverHour: hour }; }));
app.post("/api/admin/stats/clear", auth, perm('perm_stats_edit'), H(async r => { const {dateStr} = getTWTime(); await flushDB(); await redis.del(`${KEYS.HOURLY}${dateStr}`); await run("DELETE FROM history WHERE date_str=?", [dateStr]); addLog(r.user.nickname, "🗑️ 清空今日統計"); }));
app.post("/api/admin/stats/adjust", auth, perm('perm_stats_edit'), H(async r => { const h = validateNum(r.body.hour, 0, 23), d = parseInt(r.body.delta); if(h === null || !Number.isInteger(d) || Math.abs(d) > 1000) throw new Error("非法數值"); const k = `${KEYS.HOURLY}${getTWTime().dateStr}`; await redis.multi().hincrby(k, `${h}_i`, d).expire(k, 172800).exec(); }));
app.post("/api/admin/stats/calibrate", auth, perm('perm_stats_edit'), H(async r => { const {dateStr} = getTWTime(), [issued, passedCount, cancelCount, hData] = await Promise.all([redis.get(KEYS.ISSUED), redis.zcard(KEYS.PASSED), redis.zcard(KEYS.CANCELLED), redis.hgetall(`${KEYS.HOURLY}${dateStr}`)]), targetTotal = Math.max(0, (parseInt(issued)||0) - passedCount - cancelCount), diff = targetTotal - netHourly(hData).reduce((a, v) => a + v, 0); if(diff !== 0) { await bumpHourly('i', diff); addLog(r.user.nickname, `⚖️ 校正統計 (${diff>0?'+':''}${diff})`); } return { success: true, diff }; }));
app.post("/api/admin/export-csv", auth, perm('perm_stats_view'), H(async r => {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(r.body.date) ? r.body.date : getTWTime().dateStr; await flushDB();
    const rows = await all("SELECT * FROM history WHERE date_str = ? ORDER BY id ASC", [d]);
    const esc = v => { let s = String(v ?? ''); if(/^[=+\-@]/.test(s)) s = `'${s}`; return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }; // 防 CSV 公式注入
    return { csvData: "Date,Time,Number,Action,Operator,Wait(min)\n" + rows.map(x => [x.date_str, new Date(x.timestamp).toLocaleTimeString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}), x.number, x.action, x.operator, x.wait_time_min].map(esc).join(",")).join("\n"), fileName: `export_${d}.csv` };
}));
app.post("/api/logs/clear", auth, perm('perm_logs_edit'), H(async r => { await redis.del(KEYS.LOGS); io.to("admin").emit("initAdminLogs", []); }));

// 連結僅允許 http/https，避免 javascript: 連結在前台造成 XSS
const parseLink = (text, url) => { const linkText = String(text ?? '').trim().slice(0, 50), linkUrl = String(url ?? '').trim(); if(!linkText || !isSafeUrl(linkUrl)) throw new Error("連結名稱或網址無效 (需 http:// 或 https://)"); return { linkText, linkUrl }; };
const findLinkIdx = (list, text, url) => list.findIndex(x => { const o = safeJSON(x); return o && o.linkUrl === url && (text === undefined || o.linkText === text); });
app.post("/api/featured/add", auth, perm('perm_links_edit'), H(async r => { await redis.rpush(KEYS.FEATURED, JSON.stringify(parseLink(r.body.linkText, r.body.linkUrl))); await emitFeatured(); }));
app.post("/api/featured/get", auth, perm('perm_links_view'), H(async () => getFeatured()));
app.post("/api/featured/remove", auth, perm('perm_links_edit'), H(async r => { const l = await redis.lrange(KEYS.FEATURED,0,-1), i = findLinkIdx(l, r.body.linkText, r.body.linkUrl); if(i >= 0) await redis.lrem(KEYS.FEATURED, 1, l[i]); await emitFeatured(); }));
app.post("/api/featured/edit", auth, perm('perm_links_edit'), H(async r => { const next = parseLink(r.body.newLinkText, r.body.newLinkUrl), l = await redis.lrange(KEYS.FEATURED,0,-1), i = findLinkIdx(l, r.body.oldLinkText, r.body.oldLinkUrl); if(i >= 0) await redis.lset(KEYS.FEATURED, i, JSON.stringify(next)); await emitFeatured(); }));
app.post("/api/featured/clear", auth, perm('perm_links_edit'), H(async r => { await redis.del(KEYS.FEATURED); io.emit("updateFeaturedContents", []); }));

app.post("/api/appointment/add", auth, perm('perm_booking_edit'), H(async r => {
    const num = validateNum(r.body.number, 1); if(num === null) throw new Error("無效號碼");
    // 優先使用前端傳來的毫秒時間戳；舊版字串若無時區，視為台灣時間 (伺服器多半跑在 UTC)
    let ts = Number(r.body.timestamp);
    if(!Number.isFinite(ts) || ts <= 0) { const s = String(r.body.timeStr || '').trim().replace(' ', 'T'); ts = new Date(/(Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}+08:00`).getTime(); }
    if(isNaN(ts)) throw new Error("無效日期");
    // 預約號必須是尚未發出的號碼 (發號時會自動略過)，否則會和現場客人撞號
    const issued = parseInt(await redis.get(KEYS.ISSUED))||0; if(num <= issued) throw new Error(`${num} 號已發出，請使用大於 ${issued} 的號碼`);
    if(await get("SELECT id FROM appointments WHERE (status='pending' AND scheduled_time = ?) OR (status IN ('pending','called') AND number = ?)", [ts, num])) throw new Error("預約衝突");
    await run("INSERT INTO appointments (number, scheduled_time) VALUES (?, ?)", [num, ts]); addLog(r.user.nickname, `📅 預約: ${num}`); await broadcastAppts();
}));
app.post("/api/appointment/list", auth, perm('perm_booking_view'), H(async r => ({ appointments: await all("SELECT * FROM appointments WHERE status='pending' ORDER BY scheduled_time ASC") })));
app.post("/api/appointment/remove", auth, perm('perm_booking_edit'), H(async r => { const id = validateNum(r.body.id, 1, Number.MAX_SAFE_INTEGER); if(id === null) throw new Error("無效 ID"); await run("DELETE FROM appointments WHERE id=?", [id]); addLog(r.user.nickname, `📅 刪除預約 #${id}`); await broadcastAppts(); }));

app.post("/set-sound-enabled", auth, perm('perm_system_edit'), H(async r=>{ const v = !!r.body.enabled; await redis.set(S_KEYS.SOUND, v?"1":"0"); io.emit("updateSoundSetting", v); }));
app.post("/set-public-status", auth, perm('perm_system_edit'), H(async r=>{ const v = !!r.body.isPublic; await redis.set(S_KEYS.PUBLIC, v?"1":"0"); io.emit("updatePublicStatus", v); }));
app.post("/set-system-mode", auth, perm('perm_system_edit'), H(async r=>{ if(!['ticketing','input'].includes(r.body.mode)) throw new Error("無效模式"); await redis.set(KEYS.MODE, r.body.mode); io.emit("updateSystemMode", r.body.mode); }));
app.post("/set-ticketing-enabled", auth, perm('perm_system_edit'), H(async r=>{ const v = !!r.body.enabled; await redis.set(S_KEYS.ALLOW_T, v?"1":"0"); io.emit("updateTicketingEnabled", v); }));
app.post("/reset", auth, perm('perm_system_edit'), H(async r => resetSys(r.user.nickname)));
app.post("/api/admin/broadcast", auth, perm('perm_system_edit'), H(async r => { if(!r.body.message || typeof r.body.message !== 'string') throw new Error("無效訊息"); const msg = r.body.message.slice(0, 500); io.emit("adminBroadcast", msg); addLog(r.user.nickname, `📢 廣播: ${msg}`); }));

app.post("/api/admin/settings/hours/get", auth, perm('perm_system_view'), H(async () => getHours()));
app.post("/api/admin/settings/hours/save", auth, perm('perm_system_edit'), H(async r => { const cfg = { start: r.body.start, end: r.body.end, enabled: !!r.body.enabled }; if(!HM_RE.test(cfg.start) || !HM_RE.test(cfg.end)) throw new Error("時間格式錯誤 (HH:MM)"); await redis.set(KEYS.HOURS, JSON.stringify(cfg)); addLog(r.user.nickname, `🔧 更新營業時間 ${cfg.start}-${cfg.end}`); io.emit("updateBusinessHours", cfg); }));

// 儲存與獲取前台自定義文字 API (僅接受白名單欄位)
app.post("/api/admin/frontend-texts/get", auth, perm('perm_system_view'), H(async () => safeJSON(await redis.get(KEYS.FRONTEND_TEXTS), {})));
app.post("/api/admin/frontend-texts/save", auth, perm('perm_system_edit'), H(async r => { const texts = {}; FRONTEND_TEXT_KEYS.forEach(k => { const v = r.body.texts?.[k]; if(typeof v === 'string' && v.trim()) texts[k] = v.trim().slice(0, 100); }); await redis.set(KEYS.FRONTEND_TEXTS, JSON.stringify(texts)); io.emit("updateFrontendTexts", texts); addLog(r.user.nickname, "🔧 更新前台顯示文字"); }));

// LINE 金鑰僅回傳遮罩值，不把完整 Token / Secret 傳到瀏覽器
const maskSecret = v => v ? `••••${v.slice(-4)}` : null;
app.post("/api/admin/line-settings/get", auth, perm('perm_line_view'), H(async () => { const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); return { "LINE Access Token": maskSecret(t), "LINE Channel Secret": maskSecret(s) }; }));
app.post("/api/admin/line-settings/save", auth, perm('perm_line_edit'), H(async r => { const ok = v => typeof v === 'string' && v.trim() && !v.startsWith('••••'); const p = redis.multi(); if(ok(r.body["LINE Access Token"])) p.set(KEYS.LINE.CFG_TOKEN, r.body["LINE Access Token"].trim()); if(ok(r.body["LINE Channel Secret"])) p.set(KEYS.LINE.CFG_SECRET, r.body["LINE Channel Secret"].trim()); await p.exec(); await initLine(); addLog(r.user.nickname, "🔧 更新 LINE 設定"); }));
app.post("/api/admin/line-settings/reset", auth, perm('perm_line_edit'), H(async r => { await redis.del(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); await initLine(); addLog(r.user.nickname, "🔧 重置 LINE 設定"); }));
app.post("/api/admin/line-settings/get-unlock-pass", auth, perm('perm_line_edit'), H(async () => ({ password: await redis.get(KEYS.LINE.PWD) })));
app.post("/api/admin/line-settings/save-pass", auth, perm('perm_line_edit'), H(async r => { if(typeof r.body.password !== 'string') throw new Error("無效密碼"); await redis.set(KEYS.LINE.PWD, r.body.password.trim()); addLog(r.user.nickname, "🔧 更新 LINE 解鎖密碼"); }));

app.post("/api/admin/line-messages/get", auth, perm('perm_line_view'), H(async () => getLineMsgs()));
app.post("/api/admin/line-messages/save", auth, perm('perm_line_edit'), H(async r => { await redis.mset(...Object.entries(LINE_MSG_FIELDS).flatMap(([f, k]) => [KEYS.LINE.MSG[k], String(r.body[f] ?? '')])); addLog(r.user.nickname, "💬 更新 LINE 訊息"); }));
app.post("/api/admin/line-autoreply/list", auth, perm('perm_line_view'), H(async () => redis.hgetall(KEYS.LINE.AUTOREPLY)));
app.post("/api/admin/line-autoreply/save", auth, perm('perm_line_edit'), H(async r => { const k = String(r.body.keyword ?? '').trim(); if(!k||!r.body.reply) throw new Error("無效內容"); await redis.hset(KEYS.LINE.AUTOREPLY, k, String(r.body.reply)); addLog(r.user.nickname, `➕ LINE 關鍵字: ${k}`); }));
app.post("/api/admin/line-autoreply/edit", auth, perm('perm_line_edit'), H(async r => { const o = String(r.body.oldKeyword ?? ''), n = String(r.body.newKeyword ?? '').trim(), p = r.body.newReply; if(!n||!p) throw new Error("空值"); const pipe=redis.multi(); if(o!==n) pipe.hdel(KEYS.LINE.AUTOREPLY, o); pipe.hset(KEYS.LINE.AUTOREPLY, n, String(p)); await pipe.exec(); addLog(r.user.nickname, `✎ 修改 LINE 規則: ${o}->${n}`); }));
app.post("/api/admin/line-autoreply/del", auth, perm('perm_line_edit'), H(async r => { await redis.hdel(KEYS.LINE.AUTOREPLY, String(r.body.keyword ?? '')); addLog(r.user.nickname, `🗑️ 移除 LINE 關鍵字: ${r.body.keyword}`); }));
app.post("/api/admin/line-default-reply/get", auth, perm('perm_line_view'), H(async () => ({ reply: await redis.get(KEYS.LINE.MSG.DEFAULT) })));
app.post("/api/admin/line-default-reply/save", auth, perm('perm_line_edit'), H(async r => { await redis.set(KEYS.LINE.MSG.DEFAULT, String(r.body.reply ?? '')); addLog(r.user.nickname, "🔧 更新 LINE 預設回覆"); }));
app.post("/api/admin/line-system-keywords/get", auth, perm('perm_line_view'), H(async () => getLineCmds()));
app.post("/api/admin/line-system-keywords/save", auth, perm('perm_line_edit'), H(async r => { await redis.mset(...Object.keys(LINE_CMD_DEFAULTS).flatMap(k => [KEYS.LINE.CMD[k.toUpperCase()], String(r.body[k] ?? '').trim() || LINE_CMD_DEFAULTS[k]])); addLog(r.user.nickname, "🔧 更新 LINE 指令"); }));

cron.schedule('0 4 * * *', async () => { try { await resetSys('系統自動'); await run("DELETE FROM history WHERE timestamp < ?", [Date.now()-(30*86400000)]); } catch(e) { console.error("Cron Error:", e.message); } }, { timezone: "Asia/Taipei" });
io.use(async (s, next) => { try { const t = s.handshake.auth.token || parseCookie(s.request.headers.cookie||'')['token']; if(t) { const u = safeJSON(await redis.get(`${KEYS.SESSION}${t}`)); if(u) s.data.user = u; } } catch(e) {} next(); });

const emitOnlineAdmins = async () => { const socks = await io.in("admin").fetchSockets(); io.to("admin").emit("updateOnlineAdmins", [...new Map(socks.filter(x => x.data.user).map(x => [x.data.user.username, x.data.user])).values()]); };

io.on("connection", async s => {
    try {
        if(s.data.user) {
            s.join("admin"); s.on("disconnect", () => emitOnlineAdmins().catch(() => {}));
            await emitOnlineAdmins(); s.emit("initAdminLogs", await redis.lrange(KEYS.LOGS,0,99)); broadcastAppts(s).catch(() => {});
        }
        const [[snd,pub,m,h,allowT,fTexts], p, f, q] = await Promise.all([redis.mget(S_KEYS.SOUND, S_KEYS.PUBLIC, KEYS.MODE, KEYS.HOURS, S_KEYS.ALLOW_T, KEYS.FRONTEND_TEXTS), redis.zrange(KEYS.PASSED,0,-1), getFeatured(), getQueueState()]);
        s.emit("update",q.current);
        s.emit("updateQueue",q);
        s.emit("updatePassed",p.map(Number));
        s.emit("updateFeaturedContents",f);
        s.emit("updateSoundSetting",snd==="1");
        s.emit("updatePublicStatus",pub!=="0");
        s.emit("updateSystemMode",m||'ticketing');
        s.emit("updateWaitTime",await calcWaitTime());
        s.emit("updateTicketingEnabled", allowT!=="0");
        s.emit("updateBusinessHours", safeJSON(h, {enabled:false}));
        s.emit("updateFrontendTexts", safeJSON(fTexts, {}));
    } catch(e) { console.error("Socket Init Error:", e.message); }
});

app.use((err, req, res, _next) => { console.error('Global Error:', err.stack || err.message); res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' }); });
process.on('unhandledRejection', e => console.error('Unhandled Rejection:', e));
process.on('uncaughtException', e => { console.error('Uncaught Exception:', e); });

// 舊版留下的「已叫預約」會被當成保留號，啟動時把超過一天的標記為完成
initDB().then(() => run("UPDATE appointments SET status='done' WHERE status='called' AND scheduled_time < ?", [Date.now() - 86400000])).then(() => server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server v18.15 running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });

let shuttingDown = false;
['SIGTERM','SIGINT'].forEach(sig => process.on(sig, async () => {
    if(shuttingDown) return; shuttingDown = true;
    console.log(`\n🛑 ${sig} - Graceful shutdown...`);
    setTimeout(() => process.exit(1), 5000).unref();
    io.close(); // 同時關閉 socket 連線與 HTTP server，否則 server.close 會被長連線卡住
    await flushDB();
    db.close(() => { redis.disconnect(); console.log('👋 Server closed.'); process.exit(0); });
}));
