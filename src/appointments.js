/* 預約資料 (Redis)
 * DATA：id → 不會變動的內容 (JSON，含客人稱呼 / 手機)；STATUS：id → pending | called | done | cancelled
 * 狀態分開存，才能用 hcas 原子地「叫到 / 取消」，避免兩個櫃台同時叫到同一筆預約
 * 同一天內預約號碼不可重複；不同天可以重複 (號碼每天重置)
 */
const { redis } = require('./redis');
const { KEYS, APPT_KEEP_MS } = require('./config');
const { safeJSON, getTWTime } = require('./utils');

const { SEQ, DATA, STATUS } = KEYS.APPT, ACTIVE = ['pending', 'called'];

const listAll = async () => {
    const [data, status] = await Promise.all([redis.hgetall(DATA), redis.hgetall(STATUS)]);
    return Object.entries(data).map(([id, json]) => { const a = safeJSON(json); return a && { ...a, id: Number(id), status: status[id] || 'cancelled' }; })
        .filter(Boolean).sort((a, b) => a.scheduled_time - b.scheduled_time || a.id - b.id);
};
const get = async id => { const [json, status] = await Promise.all([redis.hget(DATA, String(id)), redis.hget(STATUS, String(id))]); const a = safeJSON(json); return a ? { ...a, id: Number(id), status: status || 'cancelled' } : null; };
const listPending = async () => (await listAll()).filter(a => a.status === 'pending');
// 某天仍有效 (待叫 / 已叫) 的預約號碼：一般叫號與發號都要略過
const getReservedNumbers = async dateStr => (await listAll()).filter(a => a.date_str === dateStr && ACTIVE.includes(a.status)).map(a => String(a.number));
const isNumberTaken = async (dateStr, number) => (await listAll()).some(a => a.date_str === dateStr && ACTIVE.includes(a.status) && a.number === number);

const create = async ({ number, ts, name = '', phone = '', source }) => {
    const id = await redis.incr(SEQ), rec = { id, number, scheduled_time: ts, date_str: getTWTime(new Date(ts)).dateStr, name, phone, source, created_at: Date.now() };
    await redis.multi().hset(DATA, String(id), JSON.stringify(rec)).hset(STATUS, String(id), 'pending').exec();
    return { ...rec, status: 'pending' };
};

// 線上預約佔用的時段名額；取消時歸還
const releaseSlot = async a => { if (a.source !== 'online') return; const k = `${KEYS.BOOKING.SLOT}${a.scheduled_time}`; if ((await redis.decr(k)) < 0) await redis.set(k, 0); };
const cancel = async id => { const a = await get(id); if (!a || !(await redis.hcas(STATUS, String(id), 'pending', 'cancelled'))) return false; await releaseSlot(a); return true; };
const remove = async id => { const a = await get(id); if (!a) return false; if (a.status === 'pending') await releaseSlot(a); await redis.multi().hdel(DATA, String(id)).hdel(STATUS, String(id)).exec(); return true; };

// 叫號時取最早到期的待叫預約；被別的櫃台搶先就換下一筆
const claimDue = async (now = Date.now()) => {
    for (const a of (await listPending()).filter(x => x.scheduled_time <= now)) if (await redis.hcas(STATUS, String(a.id), 'pending', 'called')) return { ...a, status: 'called' };
    return null;
};

// 線上預約號碼：每天從 numberStart 起遞增；跳過當天已被後台使用的號碼，當天預約時也必須大於已發號數
const nextBookingNumber = async (dateStr, start) => {
    const k = `${KEYS.BOOKING.NUM}${dateStr}`;
    await redis.set(k, start - 1, 'EX', 90 * 86400, 'NX');
    const issued = dateStr === getTWTime().dateStr ? (parseInt(await redis.get(KEYS.ISSUED)) || 0) : 0;
    for (let i = 0; i < 1000; i++) {
        const n = await redis.incr(k);
        if (n <= issued) { await redis.set(k, issued, 'KEEPTTL'); continue; }
        if (!(await isNumberTaken(dateStr, n))) return n;
    }
    throw new Error('無法配置預約號碼');
};

// 全域重置時：過期未到的預約取消、已叫的標記完成、結束超過 30 天的紀錄刪除 (含客人個資)
const onReset = async (now = Date.now()) => {
    const p = redis.multi(); let n = 0;
    for (const a of await listAll()) {
        const id = String(a.id);
        if (a.status === 'pending' && a.scheduled_time < now) { p.hset(STATUS, id, 'cancelled'); n++; }
        else if (a.status === 'called') { p.hset(STATUS, id, 'done'); n++; }
        else if (!ACTIVE.includes(a.status) && a.scheduled_time < now - APPT_KEEP_MS) { p.hdel(DATA, id).hdel(STATUS, id); n++; }
    }
    if (n) await p.exec();
};

module.exports = { listAll, get, listPending, getReservedNumbers, isNumberTaken, create, cancel, remove, claimDue, nextBookingNumber, onReset };
