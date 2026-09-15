/* 叫號核心：佇列狀態、叫號 / 發號、等待時間、營業時間、暫停資訊、全域重置 */
const { redis } = require('./redis');
const { io } = require('./server');
const { addLog } = require('./log');
const { notifyTrackers } = require('./notify');
const { hasPerm } = require('./auth');
const { addHistory, getRecentHistory } = require('./history');
const appts = require('./appointments');
const { KEYS, DEFAULT_HOURS, ADVANCE_ACTIONS } = require('./config');
const { getTWTime, validateNum, safeJSON, cleanCounter, toMax, isOpenAt, avgIntervalMinutes } = require('./utils');

let bCastT = null, cacheWait = 0, lastWaitCalc = 0;

const bumpHourly = (suffix, delta = 1) => { const { dateStr, hour } = getTWTime(), k = `${KEYS.HOURLY}${dateStr}`; return redis.multi().hincrby(k, `${hour}_${suffix}`, delta).expire(k, 172800).exec(); };

// 今天的預約保留號 (待叫 + 已叫)：一般叫號與發號都會略過
const getReserved = () => appts.getReservedNumbers(getTWTime().dateStr);
const nextRegular = async () => { const [res, can] = await Promise.all([getReserved(), redis.zrange(KEYS.CANCELLED, 0, -1)]); return redis.safeNextNumber(KEYS.MAX, KEYS.CURRENT, KEYS.ISSUED, ...new Set([...res, ...can])); };
const issueNext = async () => redis.safeIssue(KEYS.ISSUED, ...(await getReserved()));
// 記錄叫號櫃台與最近叫號清單 (多櫃台顯示用)
const recordCall = (n, counter) => redis.multi().set(KEYS.COUNTER, counter).lpush(KEYS.RECENT, JSON.stringify({ n, c: counter, t: Date.now() })).ltrim(KEYS.RECENT, 0, 5).exec();

const getFeatured = async () => (await redis.lrange(KEYS.FEATURED, 0, -1)).map(x => safeJSON(x)).filter(Boolean);
const emitFeatured = async () => io.emit("updateFeaturedContents", await getFeatured());
// 過號客人按「我回來了」的時間 (號碼 → 毫秒)，只推給後台
const getPassedBack = async () => Object.fromEntries(Object.entries(await redis.hgetall(KEYS.PASSED_BACK)).map(([k, v]) => [k, Number(v)]));
const emitPassed = async () => { const [list, back] = await Promise.all([redis.zrange(KEYS.PASSED, 0, -1), getPassedBack()]); io.emit("updatePassed", list.map(Number)); io.to("admin").emit("updatePassedBack", back); };
const getPauseInfo = async () => safeJSON(await redis.get(KEYS.PAUSE), {});

// 只推給有指定權限的後台連線 (例如預約清單含客人手機)
const emitToPermitted = async (permission, event, data, sockets) => {
    for (const s of sockets || await io.in("admin").fetchSockets()) { try { if (s.data.user && await hasPerm(s.data.user, permission)) s.emit(event, data); } catch (e) {} }
};

// 佇列狀態 (廣播與新連線共用)
// 叫預約號時 CURRENT 可能大於 MAX，此時不可把 MAX / ISSUED 往上修正，否則中間的號碼會被跳過
// waiting 扣除 MAX 之後已取消的號碼；skip 讓前台計算個人前方組數
const getQueueState = async (fix) => {
    const [[c, i, m, counter], cancelled, recent] = await Promise.all([redis.mget(KEYS.CURRENT, KEYS.ISSUED, KEYS.MAX, KEYS.COUNTER), redis.zrange(KEYS.CANCELLED, 0, -1), redis.lrange(KEYS.RECENT, 0, 5)]);
    const current = parseInt(c)||0, max = toMax(m, current); let issued = parseInt(i)||0;
    if (fix) { const f = []; if (m === null) f.push(KEYS.MAX, max); if (issued < max) f.push(KEYS.ISSUED, issued = max); if (f.length) await redis.mset(...f); }
    const skip = cancelled.map(Number).filter(n => n > max && n <= issued);
    return { current, issued, max, waiting: Math.max(0, issued - max - skip.length), skip, counter: counter || '', recent: recent.map(x => safeJSON(x)).filter(Boolean) };
};
const broadcastQueue = () => { clearTimeout(bCastT); bCastT = setTimeout(async () => { try { const q = await getQueueState(true); io.emit("update", q.current); io.emit("updateQueue", q); io.emit("updateWaitTime", await calcWaitTime()); io.emit("updateTimestamp", new Date().toISOString()); } catch(e) { console.error("Broadcast Error:", e.message); } }, 100); };
const broadcastAppts = async (target) => emitToPermitted('perm_booking_view', "updateAppointments", await appts.listPending(), target ? [target] : null);

// 平均每組等待分鐘數 (快取 30 秒)，取今天最近 30 次往前推進的動作
const calcWaitTime = async (force) => {
    if (!force && Date.now() - lastWaitCalc < 30000) return cacheWait;
    const rows = (await getRecentHistory(getTWTime().dateStr, 300)).filter(r => ADVANCE_ACTIONS.includes(r.action)).map(r => r.timestamp).sort((a, b) => b - a).slice(0, 30);
    lastWaitCalc = Date.now();
    if (rows.length < 2) return (cacheWait = 0);
    const avg = avgIntervalMinutes(rows);
    return avg === null ? cacheWait : (cacheWait = avg);
};
const getCachedWait = () => cacheWait;

const getHours = async () => safeJSON(await redis.get(KEYS.HOURS), DEFAULT_HOURS);
const isBusinessOpen = async () => { const c = await getHours(), { hour, minute } = getTWTime(); return isOpenAt(c, hour, minute); };

async function ctl(type, {body, user}) {
    const isSet = type === 'set_call' || type === 'set_issue', setNum = isSet ? validateNum(body.number) : null, counter = cleanCounter(body.counter), at = counter ? ` @${counter}` : '';
    if(isSet && setNum === null) return { error: "非法數值" };
    if(['call','issue'].includes(type) && !(await isBusinessOpen())) return { error: "非營業時間" };
    const dir = body.direction, [curr, issued, mx] = (await redis.mget(KEYS.CURRENT, KEYS.ISSUED, KEYS.MAX)).map(v => parseInt(v)||0);
    let newNum=0, msg='', action=type;
    if(type === 'call') {
        if(dir==='next') {
            const appt = await appts.claimDue(Date.now());
            // 叫預約號不推進 MAX，下一個一般號碼仍從原本進度接續；MAX 尚未建立時先以目前號碼建立，避免之後被修正成預約號
            if(appt) { newNum = appt.number; await redis.set(KEYS.MAX, curr, 'NX'); await redis.set(KEYS.CURRENT, newNum); msg=`🔔 呼叫預約 ${newNum}${appt.name ? ` (${appt.name})` : ''}${at}`; action='call_appt'; broadcastAppts().catch(()=>{}); }
            else { if((newNum = await nextRegular()) === -1) return { error: "已無等待" }; msg=`號碼增加為 ${newNum}${at}`; }
            await recordCall(newNum, counter);
        }
        else { newNum = await redis.decrIfPositive(KEYS.CURRENT, KEYS.MAX); msg=`號碼回退為 ${newNum}`; action='call_prev'; }
        notifyTrackers(newNum);
    } else if(type === 'issue') {
        if(dir==='next') { newNum = await issueNext(); msg=`手動發號 ${newNum}`; await bumpHourly('i'); }
        else if(issued > Math.max(curr, mx)) { newNum = await redis.decr(KEYS.ISSUED); msg=`手動回退 ${newNum}`; action='issue_prev'; await bumpHourly('i', -1); }
        else return { error: "發號數不可小於目前叫號" };
    } else if(type === 'set_issue') {
        newNum = setNum; if(newNum===0) return resetSys(user.nickname);
        const diff = newNum - issued; if(diff) await bumpHourly('i', diff); await redis.set(KEYS.ISSUED, newNum); msg=`修正發號 ${newNum}`;
    } else { /* set_call */ newNum = setNum; await redis.mset(KEYS.CURRENT, newNum, KEYS.MAX, newNum, ...(newNum>issued?[KEYS.ISSUED, newNum]:[])); msg=`設定叫號 ${newNum}${at}`; if(newNum) await recordCall(newNum, counter); notifyTrackers(newNum); }
    if(msg) { addLog(user.nickname, msg); await addHistory(action, newNum||curr, user.nickname, await calcWaitTime()); } broadcastQueue(); return { number: newNum };
}

async function resetSys(by) {
    // 一併清除 LINE / Web Push 追蹤、取消名單、回報名單與櫃台紀錄，避免隔天相同號碼誤發通知；EPOCH +1 讓舊的線上取號憑證失效
    const [active, pushActive] = await Promise.all([redis.smembers(KEYS.LINE.ACTIVE), redis.smembers(KEYS.PUSH.ACTIVE)]), subKeys = active.map(n => `${KEYS.LINE.SUB}${n}`);
    const uids = subKeys.length ? (await Promise.all(subKeys.map(k => redis.smembers(k)))).flat() : [];
    const p = redis.multi().mset(KEYS.CURRENT,0,KEYS.ISSUED,0,KEYS.MAX,0).del(KEYS.PASSED, KEYS.PASSED_BACK, KEYS.LINE.ACTIVE, KEYS.CANCELLED, KEYS.COUNTER, KEYS.RECENT, KEYS.APPROACHED, KEYS.PUSH.ACTIVE).incr(KEYS.EPOCH);
    if (subKeys.length) p.del(...subKeys); if (uids.length) p.del(...[...new Set(uids)].map(u => `${KEYS.LINE.USER}${u}`));
    if (pushActive.length) p.del(...pushActive.map(n => `${KEYS.PUSH.SUB}${n}`));
    await p.exec();
    await appts.onReset(Date.now());
    await addHistory('reset', 0, by); // 報表計算客人等待時間時，重置後重新配對號碼
    addLog(by, "💥 全域重置"); cacheWait=0; broadcastQueue(); broadcastAppts().catch(()=>{}); emitPassed().catch(()=>{}); return {};
}

module.exports = {
    bumpHourly, nextRegular, issueNext, recordCall, getFeatured, emitFeatured, emitPassed, getPassedBack, getPauseInfo,
    getQueueState, broadcastQueue, broadcastAppts, calcWaitTime, getCachedWait, getHours, isBusinessOpen, ctl, resetSys
};
