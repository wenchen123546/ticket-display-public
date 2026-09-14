/* Server v18.15 - 包含讀寫分離、卡片隱藏權限控制、叫號開關、MAX 進度解耦與前台文字自定義 (安全性 / 穩定性修正) */
require('dotenv').config();
const { Server } = require("http"), express = require("express"), socketio = require("socket.io"), Redis = require("ioredis"),
      helmet = require('helmet'), rateLimit = require('express-rate-limit'), crypto = require('crypto'),
      bcrypt = require('bcrypt'), line = require('@line/bot-sdk'), cron = require('node-cron'),
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
const FRONTEND_TEXT_KEYS = ['brand_title', 'cur', 'iss', 'wait_count', 'online', 'help', 'take', 'man_t', 'man_p', 'track', 'recall_badge', 'sys_close', 'sys_close_desc'];

// FRONTEND_TEXTS 用於儲存前台自定義文字
const KEYS = { CURRENT: 'callsys:number', MAX: 'callsys:max', ISSUED: 'callsys:issued', MODE: 'callsys:mode', PASSED: 'callsys:passed', FEATURED: 'callsys:featured', LOGS: 'callsys:admin-log', USERS: 'callsys:users', NICKS: 'callsys:nicknames', USER_ROLES: 'callsys:user_roles', SESSION: 'callsys:session:', HISTORY: 'callsys:stats:history', HOURLY: 'callsys:stats:hourly:', ROLES: 'callsys:config:roles', HOURS: 'callsys:config:hours', FRONTEND_TEXTS: 'callsys:config:frontend_texts', LINE: { SUB: 'callsys:line:notify:', USER: 'callsys:line:user:', PWD: 'callsys:line:unlock_pwd', ADMIN: 'callsys:line:admin_session:', CTX: 'callsys:line:context:', ACTIVE: 'callsys:line:active_subs_set', CFG_TOKEN: 'callsys:line:cfg:token', CFG_SECRET: 'callsys:line:cfg:secret', MSG: { APPROACH: 'callsys:line:msg:approach', ARRIVAL: 'callsys:line:msg:arrival', SUCCESS: 'callsys:line:msg:success', PASSED: 'callsys:line:msg:passed', CANCEL: 'callsys:line:msg:cancel', DEFAULT: 'callsys:line:msg:default', HELP: 'callsys:line:msg:help', LOGIN_PROMPT: 'callsys:line:msg:login_prompt', LOGIN_SUCCESS: 'callsys:line:msg:login_success', NO_TRACKING: 'callsys:line:msg:no_tracking', NO_PASSED: 'callsys:line:msg:no_passed', PASSED_PREFIX: 'callsys:line:msg:passed_prefix' }, CMD: { LOGIN: 'callsys:line:cmd:login', STATUS: 'callsys:line:cmd:status', CANCEL: 'callsys:line:cmd:cancel', PASSED: 'callsys:line:cmd:passed', HELP: 'callsys:line:cmd:help' }, AUTOREPLY: 'callsys:line:autoreply_rules' } };
const S_KEYS = { SOUND: 'callsys:soundEnabled', PUBLIC: 'callsys:isPublic', ALLOW_T: 'callsys:allowTicketing' };

// LINE 訊息 / 指令欄位與預設值 (callback、get、save 共用，避免三處預設值不一致)
const LINE_MSG_FIELDS = { approach: 'APPROACH', arrival: 'ARRIVAL', success: 'SUCCESS', passed: 'PASSED', cancel: 'CANCEL', help: 'HELP', loginPrompt: 'LOGIN_PROMPT', loginSuccess: 'LOGIN_SUCCESS', noTracking: 'NO_TRACKING', noPassed: 'NO_PASSED', passedPrefix: 'PASSED_PREFIX' };
const LINE_MSG_DEFAULTS = { approach: '🔔 {target}號快到了 (前方剩{diff}組)', arrival: '🎉 {current}號 到您了！請前往櫃台', success: '設定成功: {number}號', passed: '已過號', cancel: '已取消', help: '💡 請輸入數字', loginPrompt: '請輸入密碼', loginSuccess: '🔓 驗證成功', noTracking: '無追蹤', noPassed: '無過號', passedPrefix: '⚠️ 過號：' };
const LINE_CMD_DEFAULTS = { login: '後台登入', status: 'status,?,查詢,查詢進度', cancel: 'cancel,取消,取消提醒', passed: 'passed,過號,過號名單', help: 'help,提醒,設定提醒' };

app.disable('x-powered-by'); app.set('trust proxy', 1); app.use(helmet({ contentSecurityPolicy: false })); app.use(express.static(path.join(__dirname, "public")));
const server = Server(app), io = socketio(server, { cors: { origin: ALLOWED_ORIGINS ? ALLOWED_ORIGINS.split(',') : ["http://localhost:3000"], methods: ["GET", "POST"], credentials: true }, pingTimeout: 60000 });
const redis = new Redis(REDIS_URL, { tls: { rejectUnauthorized: false }, retryStrategy: t => Math.min(t * 50, 2000) });
redis.on('error', e => console.error('Redis Error:', e.message));
const db = new sqlite3.Database(path.join(__dirname, 'callsys.db')), dbQueue = [];

let lineClient = null;
const initLine = async () => { const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); if ((t||LAT) && (s||LCS)) lineClient = new line.Client({ channelAccessToken: t||LAT, channelSecret: s||LCS }); else { lineClient = null; console.warn("⚠️ LINE Token Missing"); } };
initLine().catch(e => console.error("LINE Init Error:", e.message));

const initDB = () => new Promise((res, rej) => db.serialize(() => { db.run("PRAGMA journal_mode=WAL;"); db.run(`CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, date_str TEXT, timestamp INTEGER, number INTEGER, action TEXT, operator TEXT, wait_time_min REAL)`); db.run(`CREATE TABLE IF NOT EXISTS appointments (id INTEGER PRIMARY KEY, number INTEGER, scheduled_time INTEGER, status TEXT DEFAULT 'pending')`); db.run("CREATE INDEX IF NOT EXISTS idx_history_date ON history(date_str)"); db.run("CREATE INDEX IF NOT EXISTS idx_history_action_ts ON history(action, timestamp)"); db.run("CREATE INDEX IF NOT EXISTS idx_history_ts ON history(timestamp)", e => e ? rej(e) : (console.log("✅ DB Ready"), res())); }));
// 批次寫入歷史紀錄 (定時器與關機流程共用)
const flushDB = () => new Promise(res => {
    if (!dbQueue.length) return res();
    const batch = dbQueue.splice(0);
    db.serialize(() => { db.run("BEGIN TRANSACTION"); const s = db.prepare("INSERT INTO history (date_str, timestamp, number, action, operator, wait_time_min) VALUES (?, ?, ?, ?, ?, ?)"); batch.forEach(r => s.run([r.dateStr, r.timestamp, r.number, r.action, r.operator, r.wait_time_min])); s.finalize(); db.run("COMMIT", e => { if (e) { console.error("Batch Error:", e); db.run("ROLLBACK", () => {}); } res(); }); });
});
setInterval(flushDB, DB_FLUSH_INTERVAL);
const dbQ = (m, s, p=[]) => new Promise((res, rej) => db[m](s, p, function(e, r){ e ? rej(e) : res(m==='run'?this:r) })), [run, all, get] = ['run', 'all', 'get'].map(m => (s, p) => dbQ(m, s, p));

redis.defineCommand("safeNextNumber", { numberOfKeys: 3, lua: `local m=tonumber(redis.call("GET",KEYS[1])) local c=tonumber(redis.call("GET",KEYS[2])) or 0 if not m then m=c end local i=tonumber(redis.call("GET",KEYS[3])) or 0 if m < i then m=m+1 redis.call("SET",KEYS[1],m) redis.call("SET",KEYS[2],m) return m else return -1 end` });
redis.defineCommand("decrIfPositive", { numberOfKeys: 2, lua: `local c=tonumber(redis.call("GET",KEYS[1])) or 0 local m=tonumber(redis.call("GET",KEYS[2])) or 0 if c > 0 then local nc=c-1 redis.call("SET",KEYS[1],nc) if m==c then redis.call("SET",KEYS[2],nc) end return nc end return c` });

redis.setnx(KEYS.ROLES, JSON.stringify(DEFAULT_ROLES)).catch(e => console.error("Roles Init Error:", e.message));

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
const netHourly = h => Array.from({ length: 24 }, (_, i) => h ? Math.max(0, parseInt(h[`${i}_i`]||h[i]||0) - parseInt(h[`${i}_p`]||0)) : 0);
const getFeatured = async () => (await redis.lrange(KEYS.FEATURED, 0, -1)).map(x => safeJSON(x)).filter(Boolean);
const emitFeatured = async () => io.emit("updateFeaturedContents", await getFeatured());
const emitPassed = async () => io.emit("updatePassed", (await redis.zrange(KEYS.PASSED, 0, -1)).map(Number));
const getLineMsgs = async () => { const f = Object.keys(LINE_MSG_FIELDS), v = await redis.mget(...f.map(k => KEYS.LINE.MSG[LINE_MSG_FIELDS[k]])); return Object.fromEntries(f.map((k, i) => [k, v[i] || LINE_MSG_DEFAULTS[k]])); };
const getLineCmds = async () => { const f = Object.keys(LINE_CMD_DEFAULTS), v = await redis.mget(...f.map(k => KEYS.LINE.CMD[k.toUpperCase()])); return Object.fromEntries(f.map((k, i) => [k, v[i] || LINE_CMD_DEFAULTS[k]])); };
let bCastT = null, cacheWait = 0, lastWaitCalc = 0;

const broadcastQueue = () => { clearTimeout(bCastT); bCastT = setTimeout(async () => { try { let [c, i, m] = (await redis.mget(KEYS.CURRENT, KEYS.ISSUED, KEYS.MAX)).map(v => parseInt(v)||0); const fix = []; if(i<c) fix.push(KEYS.ISSUED, i=c); if(m<c) fix.push(KEYS.MAX, m=c); if(fix.length) await redis.mset(...fix); io.emit("update", c); io.emit("updateQueue", { current: c, issued: i, max: m }); io.emit("updateWaitTime", await calcWaitTime()); io.emit("updateTimestamp", new Date().toISOString()); } catch(e) { console.error("Broadcast Error:", e.message); } }, 100); };
const broadcastAppts = async (target = io.to("admin")) => target.emit("updateAppointments", await all("SELECT * FROM appointments WHERE status='pending' ORDER BY scheduled_time ASC"));

const calcWaitTime = async (force) => {
    if (!force && Date.now() - lastWaitCalc < 60000) return cacheWait;
    const rows = await all(`SELECT timestamp FROM history WHERE action='call' ORDER BY timestamp DESC LIMIT 30`);
    lastWaitCalc = Date.now();
    if (!rows || rows.length < 2) return (cacheWait = 0);
    const MIN_MS = 10 * 1000, MAX_MS = 10 * 60 * 1000, valid = [];
    for (let i = 0; i < rows.length - 1; i++) { const diff = rows[i].timestamp - rows[i + 1].timestamp; if (diff >= MIN_MS && diff <= MAX_MS) valid.push(diff); }
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

async function checkLine(c) {
    if (!lineClient) return;
    try {
        const t = c + 5, [M, s5, s0] = await Promise.all([getLineMsgs(), redis.smembers(`${KEYS.LINE.SUB}${t}`), redis.smembers(`${KEYS.LINE.SUB}${c}`)]);
        const send = (ids, txt) => { while (ids.length) lineClient.multicast(ids.splice(0, 500), [{ type: 'text', text: txt }]).catch(e => console.error("LINE Push Error:", e.message)); };
        if (s5.length) send([...s5], M.approach.replace(/{current}/g, c).replace(/{target}/g, t).replace(/{diff}/g, 5));
        if (s0.length) { send([...s0], M.arrival.replace(/{current}/g, c)); await redis.multi().del(`${KEYS.LINE.SUB}${c}`, ...s0.map(u => `${KEYS.LINE.USER}${u}`)).srem(KEYS.LINE.ACTIVE, c).exec(); }
    } catch (e) { console.error("checkLine Error:", e.message); }
}

app.post('/callback', async (req, res) => {
    try {
        const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET), cfg = { channelAccessToken: t||LAT, channelSecret: s||LCS };
        if (!cfg.channelAccessToken || !cfg.channelSecret) return res.status(500).end();
        line.middleware(cfg)(req, res, async (err) => {
            if (err) return res.status(403).json({ error: "Invalid Signature" });
            if (!lineClient) lineClient = new line.Client(cfg);
            try {
                const events = (req.body.events || []).filter(e => e.type === 'message' && e.message?.type === 'text' && e.source?.userId);
                if (!events.length) return res.json({});
                const [cmd, M, mDef] = await Promise.all([getLineCmds(), getLineMsgs(), redis.get(KEYS.LINE.MSG.DEFAULT)]);
                await Promise.all(events.map(async e => {
                    const txt = e.message.text.trim(), low = txt.toLowerCase(), uid = e.source.userId, rp = x => lineClient.replyMessage(e.replyToken, { type: 'text', text: x }).catch(console.error);
                    const inList = s => String(s).split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(low);

                    if(txt === cmd.login.trim()) return rp((await redis.get(`${KEYS.LINE.ADMIN}${uid}`)) ? `🔗 ${process.env.RENDER_EXTERNAL_URL || ''}/admin.html` : (await redis.set(`${KEYS.LINE.CTX}${uid}`,'WAIT_PWD','EX',120), M.loginPrompt));
                    if((await redis.get(`${KEYS.LINE.CTX}${uid}`))==='WAIT_PWD' && safeEqual(txt, (await redis.get(KEYS.LINE.PWD)) || `unlock${ADMIN_TOKEN}`)) { await redis.multi().set(`${KEYS.LINE.ADMIN}${uid}`,"1","EX",600).del(`${KEYS.LINE.CTX}${uid}`).exec(); return rp(M.loginSuccess); }
                    const ar = await redis.hget(KEYS.LINE.AUTOREPLY, txt); if (ar) return rp(ar);
                    if(inList(cmd.status)) { const [n,i,my]=await redis.mget(KEYS.CURRENT,KEYS.ISSUED,`${KEYS.LINE.USER}${uid}`); return rp(`目前叫號: ${n||0}\n已發號至: ${i||0}${my?`\n您的追蹤: ${my}號`:''}`); }
                    if(inList(cmd.cancel)) { const n=await redis.get(`${KEYS.LINE.USER}${uid}`); if(n){await redis.multi().del(`${KEYS.LINE.USER}${uid}`).srem(`${KEYS.LINE.SUB}${n}`,uid).exec(); return rp(M.cancel);} return rp(M.noTracking); }
                    if(inList(cmd.passed)) { const l = await redis.zrange(KEYS.PASSED, 0, -1); return rp(l.length ? `${M.passedPrefix}\n${l.join(', ')}` : M.noPassed); }
                    if(inList(cmd.help)) return rp(M.help);
                    if(/^\d{1,5}$/.test(txt)) {
                        const n=parseInt(txt), c=parseInt(await redis.get(KEYS.CURRENT))||0; if(n<=c) return rp(M.passed);
                        const old = await redis.get(`${KEYS.LINE.USER}${uid}`), p = redis.multi();
                        if (old && old !== String(n)) p.srem(`${KEYS.LINE.SUB}${old}`, uid); // 改追蹤新號碼時，移除舊號碼的訂閱
                        await p.set(`${KEYS.LINE.USER}${uid}`,n,'EX',43200).sadd(`${KEYS.LINE.SUB}${n}`,uid).expire(`${KEYS.LINE.SUB}${n}`,43200).sadd(KEYS.LINE.ACTIVE,n).exec();
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
app.get('/health', async (req, res) => { try { await redis.ping(); const dbOk = await new Promise(r => db.get("SELECT 1", e => r(!e))); res.json({ status: 'ok', uptime: Math.floor(process.uptime()), redis: true, db: dbOk }); } catch(e) { res.status(503).json({ status: 'error', message: e.message }); } });
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
    const isSet = type === 'set_call' || type === 'set_issue', setNum = isSet ? validateNum(body.number) : null;
    if(isSet && setNum === null) return { error: "非法數值" };
    if(['call','issue'].includes(type) && !(await isBusinessOpen())) return { error: "非營業時間" };
    const dir = body.direction, { dateStr } = getTWTime(), [curr, issued] = (await redis.mget(KEYS.CURRENT, KEYS.ISSUED)).map(v => parseInt(v)||0);
    let newNum=0, msg='';
    if(type === 'call') {
        if(dir==='next') {
            const appt = await get("SELECT id, number FROM appointments WHERE status='pending' AND scheduled_time <= ? ORDER BY scheduled_time ASC LIMIT 1", [Date.now()]);
            if(appt) { newNum = appt.number; const curMax=parseInt(await redis.get(KEYS.MAX))||0; await redis.mset(KEYS.CURRENT, newNum, ...(newNum>curMax?[KEYS.MAX, newNum]:[])); await run("UPDATE appointments SET status='called' WHERE id=?", [appt.id]); msg=`🔔 呼叫預約 ${newNum}`; broadcastAppts().catch(()=>{}); }
            else { if((newNum = await redis.safeNextNumber(KEYS.MAX, KEYS.CURRENT, KEYS.ISSUED)) === -1) return { error: "已無等待" }; msg=`號碼增加為 ${newNum}`; }
        }
        else { newNum = await redis.decrIfPositive(KEYS.CURRENT, KEYS.MAX); msg=`號碼回退為 ${newNum}`; }
        checkLine(newNum);
    } else if(type === 'issue') {
        if(dir==='next') { newNum = await redis.incr(KEYS.ISSUED); msg=`手動發號 ${newNum}`; await bumpHourly('i'); }
        else if(issued > curr) { newNum = await redis.decr(KEYS.ISSUED); msg=`手動回退 ${newNum}`; await bumpHourly('i', -1); }
        else return { error: "發號數不可小於目前叫號" };
    } else if(type === 'set_issue') {
        newNum = setNum; if(newNum===0) return resetSys(user.nickname);
        const diff = newNum - issued; if(diff) await bumpHourly('i', diff); await redis.set(KEYS.ISSUED, newNum); msg=`修正發號 ${newNum}`;
    } else { /* set_call */ newNum = setNum; await redis.mset(KEYS.CURRENT, newNum, KEYS.MAX, newNum, ...(newNum>issued?[KEYS.ISSUED, newNum]:[])); msg=`設定叫號 ${newNum}`; checkLine(newNum); }
    if(msg) { addLog(user.nickname, msg); dbQueue.push({dateStr, timestamp: Date.now(), number: newNum||curr, action: type, operator: user.nickname, wait_time_min: await calcWaitTime()}); } broadcastQueue(); return { number: newNum };
}
async function resetSys(by) {
    // 一併清除 LINE 追蹤，避免隔天相同號碼誤發通知
    const active = await redis.smembers(KEYS.LINE.ACTIVE), subKeys = active.map(n => `${KEYS.LINE.SUB}${n}`);
    const uids = subKeys.length ? (await Promise.all(subKeys.map(k => redis.smembers(k)))).flat() : [];
    const p = redis.multi().mset(KEYS.CURRENT,0,KEYS.ISSUED,0,KEYS.MAX,0).del(KEYS.PASSED, KEYS.LINE.ACTIVE);
    if (subKeys.length) p.del(...subKeys); if (uids.length) p.del(...[...new Set(uids)].map(u => `${KEYS.LINE.USER}${u}`));
    await p.exec();
    await run("UPDATE appointments SET status='cancelled' WHERE status='pending'");
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

app.post("/api/ticket/take", rateLimit({windowMs:36e5,max:20}), H(async req => {
    const [mode, allowT] = await redis.mget(KEYS.MODE, S_KEYS.ALLOW_T);
    if(mode==='input') throw new Error("手動模式");
    if(allowT === "0") throw new Error("目前暫停取號");
    if(!(await isBusinessOpen())) throw new Error("非營業時間");
    const t = await redis.incr(KEYS.ISSUED); await bumpHourly('i');
    dbQueue.push({dateStr: getTWTime().dateStr, timestamp: Date.now(), number: t, action: 'online_take', operator: 'User', wait_time_min: await calcWaitTime()}); broadcastQueue(); return { ticket: t };
}));

['call','set-call'].forEach(c => app.post(`/api/control/${c}`, auth, perm('perm_command'), H(async r => { const res = await ctl(c.replace('-','_'), r); if(res.error) throw new Error(res.error); return res; })));
['issue','set-issue'].forEach(c => app.post(`/api/control/${c}`, auth, perm('perm_issue'), H(async r => { const res = await ctl(c.replace('-','_'), r); if(res.error) throw new Error(res.error); return res; })));

app.post("/api/control/pass-current", auth, perm('perm_passed_edit'), H(async req => {
    const c = parseInt(await redis.get(KEYS.CURRENT))||0; if(!c) throw new Error("無叫號");
    const added = await redis.zadd(KEYS.PASSED, c, c), r = await redis.safeNextNumber(KEYS.MAX, KEYS.CURRENT, KEYS.ISSUED), next = r === -1 ? c : r;
    if(added) await bumpHourly('p');
    dbQueue.push({dateStr: getTWTime().dateStr, timestamp: Date.now(), number: c, action: 'pass', operator: req.user.nickname, wait_time_min: await calcWaitTime()});
    addLog(req.user.nickname, `⏭️ 過號 ${c}`); if(r !== -1) checkLine(next); broadcastQueue(); await emitPassed(); return { next };
}));

app.post("/api/control/recall-passed", auth, perm('perm_passed_edit'), H(async r => { const n = validateNum(r.body.number, 1); if(n === null) throw new Error("非法數值"); const [c, m] = (await redis.mget(KEYS.CURRENT, KEYS.MAX)).map(v => parseInt(v)||0); await redis.multi().set(KEYS.MAX, Math.max(c, m)).zrem(KEYS.PASSED, n).set(KEYS.CURRENT, n).exec(); addLog(r.user.nickname, `↩️ 重呼 ${n}`); broadcastQueue(); await emitPassed(); }));

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
app.post("/api/admin/stats/calibrate", auth, perm('perm_stats_edit'), H(async r => { const {dateStr} = getTWTime(), [issued, passedCount, hData] = await Promise.all([redis.get(KEYS.ISSUED), redis.zcard(KEYS.PASSED), redis.hgetall(`${KEYS.HOURLY}${dateStr}`)]), targetTotal = Math.max(0, (parseInt(issued)||0) - passedCount), diff = targetTotal - netHourly(hData).reduce((a, v) => a + v, 0); if(diff !== 0) { await bumpHourly('i', diff); addLog(r.user.nickname, `⚖️ 校正統計 (${diff>0?'+':''}${diff})`); } return { success: true, diff }; }));
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
    if(await get("SELECT id FROM appointments WHERE status='pending' AND (scheduled_time = ? OR number = ?)", [ts, num])) throw new Error("預約衝突");
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
        const [[c,i,snd,pub,m,h,allowT,max,fTexts], p, f] = await Promise.all([redis.mget(KEYS.CURRENT, KEYS.ISSUED, S_KEYS.SOUND, S_KEYS.PUBLIC, KEYS.MODE, KEYS.HOURS, S_KEYS.ALLOW_T, KEYS.MAX, KEYS.FRONTEND_TEXTS), redis.zrange(KEYS.PASSED,0,-1), getFeatured()]);
        s.emit("update",Number(c));
        s.emit("updateQueue",{current:Number(c),issued:Number(i), max:Number(max)||Number(c)});
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

initDB().then(() => server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server v18.15 running on ${PORT}`))).catch(e => { console.error(e); process.exit(1); });

let shuttingDown = false;
['SIGTERM','SIGINT'].forEach(sig => process.on(sig, async () => {
    if(shuttingDown) return; shuttingDown = true;
    console.log(`\n🛑 ${sig} - Graceful shutdown...`);
    setTimeout(() => process.exit(1), 5000).unref();
    io.close(); // 同時關閉 socket 連線與 HTTP server，否則 server.close 會被長連線卡住
    await flushDB();
    db.close(() => { redis.disconnect(); console.log('👋 Server closed.'); process.exit(0); });
}));
