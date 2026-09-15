/* 整合測試：以 ioredis-mock 取代 Redis，透過 HTTP 走完取號、放棄、預約、叫號、過號回報、報表、線上預約、暫停、重置流程
 * 各測試依序執行並共用狀態 (同一個檔案內的 test 會照順序跑)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const origLoad = Module._load;
Module._load = function (request, parent, isMain) { return origLoad.call(this, request === 'ioredis' ? 'ioredis-mock' : request, parent, isMain); };
Object.assign(process.env, { ADMIN_TOKEN: 'test-admin-token', UPSTASH_REDIS_URL: 'redis://mock:6379', NODE_ENV: 'test' });

const setupApp = require('../src/app');
const { server, io } = require('../src/server');
const { redis } = require('../src/redis');
const { KEYS } = require('../src/config');
const { getTWTime } = require('../src/utils');
const { addDays } = require('../src/schedule');
const { getQueueState } = require('../src/queue');

const today = getTWTime().dateStr, tomorrow = addDays(today, 1);
let base, admin;
const tickets = {};

const api = async (method, url, { body, cookie } = {}) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (e) {}
    return { status: res.status, data, setCookie: res.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') };
};
const call = (url, body = {}) => api('POST', url, { body, cookie: admin });
const state = async () => { const [current, max, issued] = (await redis.mget(KEYS.CURRENT, KEYS.MAX, KEYS.ISSUED)).map(v => v === null ? null : Number(v)); return { current, max, issued }; };

before(async () => {
    await redis.flushall();
    setupApp();
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { io.close(); redis.disconnect(); });

test('管理員登入', async () => {
    assert.equal((await api('POST', '/login', { body: { username: 'superadmin', password: 'wrong' } })).status, 500);
    const r = await api('POST', '/login', { body: { username: 'superadmin', password: 'test-admin-token' } });
    assert.equal(r.status, 200); assert.match(r.setCookie, /^token=/);
    admin = r.setCookie;
    assert.equal((await api('POST', '/api/appointment/list')).status, 401); // 未登入
});

test('線上取號：同一裝置不重複發號', async () => {
    const a = await api('POST', '/api/ticket/take'); assert.equal(a.data.ticket, 1); tickets.a = a.setCookie;
    const again = await api('POST', '/api/ticket/take', { cookie: tickets.a });
    assert.deepEqual([again.data.ticket, again.data.existing], [1, true]);
    assert.equal((await api('POST', '/api/ticket/take')).data.ticket, 2);
    const c = await api('POST', '/api/ticket/take'); assert.equal(c.data.ticket, 3); tickets.c = c.setCookie;
    assert.equal((await call('/api/control/issue', { direction: 'next' })).data.number, 4);
});

test('客人放棄號碼：只能放棄自己的號碼，等待人數扣除', async () => {
    assert.equal((await api('POST', '/api/ticket/cancel', { body: { number: 2 }, cookie: tickets.c })).data.cancelled, false);
    assert.equal((await api('POST', '/api/ticket/cancel', { body: { number: 3 }, cookie: tickets.c })).data.cancelled, true);
    const q = await getQueueState();
    assert.deepEqual([q.issued, q.skip, q.waiting], [4, [3], 3]);
});

test('後台新增預約：號碼衝突與手機格式檢查', async () => {
    const ts = Date.now() - 60000;
    assert.match((await call('/api/appointment/add', { number: 3, timestamp: ts })).data.error, /已發出/);
    assert.match((await call('/api/appointment/add', { number: 500, timestamp: ts, phone: 'abc' })).data.error, /手機/);
    assert.equal((await call('/api/appointment/add', { number: 500, timestamp: ts, name: '王先生', phone: '0912-345-678' })).status, 200);
    assert.match((await call('/api/appointment/add', { number: 500, timestamp: ts + 1000 })).data.error, /已有 500 號/);
    const list = (await call('/api/appointment/list')).data.appointments;
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].name, list[0].phone, list[0].source, list[0].date_str], ['王先生', '0912345678', 'admin', today]);
});

test('叫號流程：預約優先、略過取消號與保留號、過號接續下一號', async (t) => {
    const later = Date.now() + 10 * 60000;
    if (getTWTime(new Date(later)).dateStr !== today) return t.skip('接近午夜，略過跨日情境');
    assert.equal((await call('/api/appointment/add', { number: 6, timestamp: later })).status, 200);
    assert.equal((await api('POST', '/api/ticket/take')).data.ticket, 5);
    assert.equal((await api('POST', '/api/ticket/take')).data.ticket, 7); // 6 號保留給稍後的預約

    const next = () => call('/api/control/call', { direction: 'next', counter: '1號櫃台' });
    assert.equal((await next()).data.number, 500);                         // 到期預約優先
    assert.deepEqual(await state(), { current: 500, max: 0, issued: 7 }); // 叫預約號不推進一般進度
    assert.equal((await next()).data.number, 1);
    assert.equal((await next()).data.number, 2);
    assert.equal((await call('/api/control/pass-current', { counter: '1號櫃台' })).data.next, 4); // 3 號已取消
    assert.equal((await next()).data.number, 5);
    assert.equal((await next()).data.number, 7);                           // 6 號是預約保留號
    const none = await next();
    assert.equal(none.status, 500); assert.match(none.data.error, /已無等待/);
    const q = await getQueueState();
    assert.deepEqual([q.recent[0].n, q.recent[0].c], [7, '1號櫃台']);
});

test('過號客人回報「我回來了」，重呼後清除', async () => {
    assert.equal((await api('POST', '/api/ticket/back', { body: { number: 1 } })).data.notified, false); // 1 號沒有過號
    assert.equal((await api('POST', '/api/ticket/back', { body: { number: 2 } })).data.notified, true);
    assert.ok(Number(await redis.hget(KEYS.PASSED_BACK, '2')) > 0);
    await call('/api/control/recall-passed', { number: 2, counter: '2號櫃台' });
    assert.equal(await redis.hget(KEYS.PASSED_BACK, '2'), null);
    assert.deepEqual(await state(), { current: 2, max: 7, issued: 7 });
});

test('營運報表與 CSV 匯出', async () => {
    const r = await call('/api/admin/report', { from: today, to: today, group: 'day' });
    assert.equal(r.status, 200);
    const t = r.data.total;
    assert.deepEqual(
        { issued: t.issued, online: t.online, called: t.called, apptCalled: t.apptCalled, passed: t.passed, cancelled: t.cancelled, waitCount: t.waitCount },
        { issued: 6, online: 5, called: 6, apptCalled: 1, passed: 1, cancelled: 1, waitCount: 5 }
    );
    assert.equal(t.passRate, 0.167); assert.equal(t.cancelRate, 0.167);
    assert.equal(r.data.groups.length, 1);
    assert.match((await call('/api/admin/report', { from: today, to: addDays(today, -1) })).data.error, /日期範圍無效/);
    assert.match((await call('/api/admin/report', { from: addDays(today, -100), to: today })).data.error, /最多 92 天/);
    const csv = await call('/api/admin/export-csv', { from: today, to: today });
    assert.match(csv.data.csvData, /call_appt/); assert.equal(csv.data.fileName, `export_${today}.csv`);
});

test('線上預約：名額、查詢時手機遮罩、取消後名額歸還', async () => {
    const save = await call('/api/admin/booking-config/save', { enabled: true, daysAhead: 2, start: '09:00', end: '18:00', slotMinutes: 60, capacity: 1, numberStart: 500 });
    assert.equal(save.status, 200);
    const cfg = await api('GET', '/api/booking/config');
    assert.deepEqual([cfg.data.enabled, cfg.data.dates], [true, [today, tomorrow]]);
    const slots = (await api('GET', `/api/booking/slots?date=${tomorrow}`)).data.slots;
    assert.equal(slots.length, 9); assert.equal(slots[0].remaining, 1);
    const ts = slots[0].ts;

    assert.match((await api('POST', '/api/booking/create', { body: { ts, name: '林小姐', phone: '12' } })).data.error, /手機/);
    assert.match((await api('POST', '/api/booking/create', { body: { ts: ts + 60000, name: '林小姐', phone: '0987654321' } })).data.error, /無法預約/);
    const first = await api('POST', '/api/booking/create', { body: { ts, name: '林小姐', phone: '0987 654 321' } });
    assert.equal(first.status, 200);
    assert.deepEqual([first.data.booking.number, first.data.booking.phone], [500, '09*****321']);
    const bk = first.setCookie;
    assert.match((await api('POST', '/api/booking/create', { body: { ts: slots[1].ts, name: '林小姐', phone: '0987654321' }, cookie: bk })).data.error, /已有一筆預約/);
    assert.match((await api('POST', '/api/booking/create', { body: { ts, name: '陳先生', phone: '0911111111' } })).data.error, /額滿/);

    const mine = await api('GET', '/api/booking/mine', { cookie: bk });
    assert.deepEqual([mine.data.booking.number, mine.data.booking.status, mine.data.booking.phone], [500, 'pending', '09*****321']);
    assert.equal(JSON.stringify(mine.data).includes('0987654321'), false); // 前台不回傳完整手機
    const adminList = (await call('/api/appointment/list')).data.appointments;
    assert.ok(adminList.some(a => a.phone === '0987654321' && a.source === 'online')); // 後台看得到完整手機

    assert.equal((await api('POST', '/api/booking/cancel', { cookie: bk })).data.cancelled, true);
    assert.equal((await api('GET', `/api/booking/slots?date=${tomorrow}`)).data.slots[0].remaining, 1);
    const second = await api('POST', '/api/booking/create', { body: { ts, name: '陳先生', phone: '0911111111' } });
    assert.equal(second.status, 200); assert.equal(second.data.booking.number, 501);
});

test('暫停服務顯示原因與恢復時間，重新開放後清除', async () => {
    await call('/set-public-status', { isPublic: false });
    assert.equal((await call('/api/admin/pause-info/save', { resumeAt: '13:30', reason: '午休' })).status, 200);
    const take = await api('POST', '/api/ticket/take');
    assert.equal(take.status, 500); assert.match(take.data.error, /午休.*13:30/);
    assert.match((await call('/api/admin/pause-info/save', { resumeAt: '25:00' })).data.error, /時間格式/);
    await call('/set-public-status', { isPublic: true });
    assert.equal(await redis.get(KEYS.PAUSE), null);
});

test('全域重置：已叫預約完成、未來預約保留、舊取號憑證失效', async () => {
    assert.equal((await call('/reset')).status, 200);
    assert.deepEqual(await state(), { current: 0, max: 0, issued: 0 });
    const pending = (await call('/api/appointment/list')).data.appointments.map(a => a.number);
    assert.deepEqual(pending, [6, 501]); // 今天稍後的 6 號、明天的 501 號
    assert.equal(await redis.hlen(KEYS.PASSED_BACK), 0);
    const again = await api('POST', '/api/ticket/take', { cookie: tickets.a });
    assert.deepEqual([again.data.ticket, again.data.existing], [1, undefined]);
    const hist = (await redis.lrange(`${KEYS.HIST}${today}`, -2, -1)).map(x => JSON.parse(x).action);
    assert.deepEqual(hist, ['reset', 'online_take']);
});
