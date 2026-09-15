/* 預約時段與營運報表的純函式測試 */
const test = require('node:test');
const assert = require('node:assert/strict');
const sc = require('../src/schedule');
const st = require('../src/stats');

const TW = (date, hm) => sc.twToTs(date, hm);

test('twToTs 以台灣時間換算', () => {
    assert.equal(sc.twToTs('2026-09-15', '09:00'), Date.parse('2026-09-15T01:00:00Z'));
    assert.equal(sc.twToTs('2026-09-15'), Date.parse('2026-09-14T16:00:00Z'));
});

test('addDays / dateRange 跨月、跨年與上限', () => {
    assert.equal(sc.addDays('2026-01-31', 1), '2026-02-01');
    assert.equal(sc.addDays('2026-01-01', -1), '2025-12-31');
    assert.deepEqual(sc.dateRange('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    assert.deepEqual(sc.dateRange('2026-03-02', '2026-03-01'), []);
    assert.deepEqual(sc.dateRange('2026-02-30', '2026-03-01'), []); // 不存在的日期
    assert.deepEqual(sc.dateRange('bad', '2026-03-01'), []);
    assert.equal(sc.dateRange('2026-01-01', '2026-12-31', 92).length, 92);
});

test('weekStart 以週一為起點 / monthKey', () => {
    assert.equal(sc.weekStart('2026-09-15'), '2026-09-14'); // 週二 → 週一
    assert.equal(sc.weekStart('2026-09-14'), '2026-09-14');
    assert.equal(sc.weekStart('2026-09-20'), '2026-09-14'); // 週日 → 同週週一
    assert.equal(sc.weekStart('2026-03-01'), '2026-02-23');
    assert.equal(sc.monthKey('2026-09-15'), '2026-09');
});

test('normalizeBookingConfig 驗證欄位並限制範圍', () => {
    assert.deepEqual(sc.normalizeBookingConfig({}), sc.DEFAULT_BOOKING);
    const c = sc.normalizeBookingConfig({ enabled: 'yes', daysAhead: 999, start: '10:00', end: '12:00', slotMinutes: '15', capacity: 0, numberStart: 'x' });
    assert.deepEqual(c, { enabled: true, daysAhead: 60, start: '10:00', end: '12:00', slotMinutes: 15, capacity: 1, numberStart: 500 });
    const bad = sc.normalizeBookingConfig({ start: '18:00', end: '09:00' });
    assert.equal(bad.start, '09:00'); assert.equal(bad.end, '18:00');
});

test('buildSlots 只產生能在結束時間前完成的時段', () => {
    const slots = sc.buildSlots({ start: '09:00', end: '10:40', slotMinutes: 30 }, '2026-09-15');
    assert.deepEqual(slots.map(x => x.time), ['09:00', '09:30', '10:00']);
    assert.equal(slots[0].ts, TW('2026-09-15', '09:00'));
});

test('bookableDates / isBookableSlot', () => {
    const cfg = { ...sc.DEFAULT_BOOKING, enabled: true, daysAhead: 3 };
    const now = TW('2026-09-15', '09:40');
    assert.deepEqual(sc.bookableDates(cfg, now), ['2026-09-15', '2026-09-16', '2026-09-17']);
    assert.equal(sc.isBookableSlot(cfg, TW('2026-09-15', '10:00'), now), true);
    assert.equal(sc.isBookableSlot(cfg, TW('2026-09-15', '09:30'), now), false); // 已開始
    assert.equal(sc.isBookableSlot(cfg, TW('2026-09-15', '10:15'), now), false); // 不在時段格線上
    assert.equal(sc.isBookableSlot(cfg, TW('2026-09-18', '10:00'), now), false); // 超過可預約天數
    assert.equal(sc.isBookableSlot(cfg, TW('2026-09-15', '18:00'), now), false); // 營業結束
    assert.equal(sc.isBookableSlot(cfg, NaN, now), false);
});

const row = (action, number, date, hm, sec = 0) => ({ action, number, timestamp: TW(date, hm) + sec * 1000 });

test('summarizeDay 計算發號、叫號、過號、取消與客人等待時間', () => {
    const d = '2026-09-15';
    const s = st.summarizeDay([
        row('online_take', 1, d, '09:00'),
        row('issue', 2, d, '09:02'),
        row('online_take', 3, d, '10:05'),
        row('call', 1, d, '09:10'),       // 1 號等 10 分
        row('call', 2, d, '09:16'),       // 2 號等 14 分；間隔 6 分
        row('pass', 2, d, '09:20'),       // 過號也算推進；間隔 4 分
        row('cancel', 3, d, '10:06'),
        row('call_appt', 500, d, '10:10'),// 預約號沒有發號紀錄，不列入等待；與上次推進間隔 50 分 → 不列入
        row('call_prev', 1, d, '10:11')
    ]);
    assert.equal(s.issued, 3); assert.equal(s.online, 2);
    assert.equal(s.called, 3); assert.equal(s.apptCalled, 1);
    assert.equal(s.passed, 1); assert.equal(s.cancelled, 1);
    assert.equal(s.waitCount, 2); assert.equal(s.waitSumMs, 24 * 60000);
    assert.equal(s.intervalCount, 2); assert.equal(s.intervalSumMs, 10 * 60000);
    assert.equal(s.hourly[9], 2); assert.equal(s.hourly[10], 1);
});

test('summarizeDay：全域重置後同號碼重新配對、收回發號、重複叫號只算第一次', () => {
    const d = '2026-09-15';
    const s = st.summarizeDay([
        row('online_take', 1, d, '09:00'),
        row('reset', 0, d, '09:30'),
        row('online_take', 1, d, '09:40'),
        row('call', 1, d, '09:45'),       // 重置後的 1 號：等 5 分 (不是 45 分)
        row('call', 1, d, '09:50'),       // 重呼不再計算等待
        row('issue', 2, d, '09:51'),
        row('issue_prev', 1, d, '09:52')  // 收回 2 號
    ]);
    assert.equal(s.issued, 2);
    assert.equal(s.waitCount, 1); assert.equal(s.waitSumMs, 5 * 60000);
    assert.equal(s.called, 2);
});

test('finalize 計算平均、比率、尖峰時段；無資料為 null', () => {
    const empty = st.finalize(st.emptySummary());
    assert.equal(empty.avgWaitMin, null); assert.equal(empty.passRate, null); assert.equal(empty.cancelRate, null); assert.equal(empty.peakHour, null);
    const s = st.emptySummary();
    Object.assign(s, { issued: 8, cancelled: 2, called: 6, passed: 1, waitSumMs: 25 * 60000, waitCount: 3, intervalSumMs: 7 * 60000, intervalCount: 2 });
    s.hourly[11] = 5; s.hourly[14] = 3;
    const f = st.finalize(s);
    assert.equal(f.avgWaitMin, 8.3); assert.equal(f.avgIntervalMin, 3.5);
    assert.equal(f.passRate, 0.167); assert.equal(f.cancelRate, 0.25); assert.equal(f.peakHour, 11);
});

test('groupSummaries 依日 / 週 / 月彙總', () => {
    const mk = (issued, waitMin) => { const s = st.emptySummary(); s.issued = issued; s.waitSumMs = waitMin * 60000; s.waitCount = 1; return s; };
    const days = [
        { date: '2026-09-13', summary: mk(10, 4) }, // 週日 (屬於 09-07 那週)
        { date: '2026-09-14', summary: mk(20, 6) }, // 週一
        { date: '2026-09-15', summary: mk(30, 11) }
    ];
    assert.equal(st.groupSummaries(days, 'day').length, 3);
    const weeks = st.groupSummaries(days, 'week');
    assert.deepEqual(weeks.map(w => [w.key, w.from, w.to, w.issued]), [['2026-09-07', '2026-09-13', '2026-09-13', 10], ['2026-09-14', '2026-09-14', '2026-09-15', 50]]);
    assert.equal(weeks[1].avgWaitMin, 8.5); // (6 + 11) / 2
    const months = st.groupSummaries(days, 'month');
    assert.equal(months.length, 1); assert.equal(months[0].issued, 60); assert.equal(months[0].avgWaitMin, 7);
});

test('twHour 以台灣時間取小時', () => {
    assert.equal(st.twHour(TW('2026-09-15', '00:30')), 0);
    assert.equal(st.twHour(TW('2026-09-15', '23:59')), 23);
});
