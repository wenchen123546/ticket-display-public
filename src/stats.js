/* 營運報表 (純函式)：由叫號明細計算每日摘要，再依日 / 週 / 月彙總 */
const { weekStart, monthKey } = require('./schedule');

const ISSUE_ACTIONS = ['online_take', 'issue'], CALL_ACTIONS = ['call', 'call_appt'], ADVANCE_ACTIONS = ['call', 'call_appt', 'pass'];
const TW_OFFSET_MS = 8 * 3600000, MIN_INTERVAL_MS = 10 * 1000, MAX_INTERVAL_MS = 10 * 60 * 1000;
const twHour = ts => Math.floor(((ts + TW_OFFSET_MS) % 86400000) / 3600000);

const emptySummary = () => ({ issued: 0, online: 0, called: 0, apptCalled: 0, passed: 0, cancelled: 0, waitSumMs: 0, waitCount: 0, intervalSumMs: 0, intervalCount: 0, hourly: Array(24).fill(0) });

// 單日摘要
// - 客人等待時間：同一號碼「發號 → 第一次叫到」的時間差 (全域重置後重新配對，避免號碼重複使用時配錯)
// - 服務間隔：相鄰兩次往前推進 (叫號 / 叫預約 / 過號) 的時間差，10 秒內或超過 10 分鐘 (例如午休) 不列入
const summarizeDay = rows => {
    const s = emptySummary(), issuedAt = new Map();
    let lastAdvance = null;
    [...rows].sort((a, b) => a.timestamp - b.timestamp).forEach(r => {
        const { action, number: n, timestamp: ts } = r;
        if (action === 'reset') { issuedAt.clear(); lastAdvance = null; return; }
        if (ISSUE_ACTIONS.includes(action)) { s.issued++; if (action === 'online_take') s.online++; s.hourly[twHour(ts)]++; if (!issuedAt.has(n)) issuedAt.set(n, ts); }
        else if (action === 'issue_prev') { s.issued = Math.max(0, s.issued - 1); issuedAt.delete(n + 1); }
        else if (action === 'cancel') { s.cancelled++; issuedAt.delete(n); }
        if (CALL_ACTIONS.includes(action)) {
            s.called++; if (action === 'call_appt') s.apptCalled++;
            if (issuedAt.has(n)) { s.waitSumMs += ts - issuedAt.get(n); s.waitCount++; issuedAt.delete(n); }
        }
        if (action === 'pass') s.passed++;
        if (ADVANCE_ACTIONS.includes(action)) {
            if (lastAdvance !== null) { const d = ts - lastAdvance; if (d >= MIN_INTERVAL_MS && d <= MAX_INTERVAL_MS) { s.intervalSumMs += d; s.intervalCount++; } }
            lastAdvance = ts;
        }
    });
    return s;
};

const mergeSummaries = list => list.reduce((acc, s) => {
    Object.keys(acc).forEach(k => { if (k === 'hourly') s.hourly.forEach((v, i) => acc.hourly[i] += v); else acc[k] += s[k]; });
    return acc;
}, emptySummary());

const round = (v, d) => { const p = 10 ** d; return Math.round(v * p) / p; };
// 加上平均值、比率與尖峰時段 (無資料時為 null)
const finalize = s => {
    const peak = Math.max(...s.hourly);
    return {
        ...s,
        avgWaitMin: s.waitCount ? round(s.waitSumMs / s.waitCount / 60000, 1) : null,
        avgIntervalMin: s.intervalCount ? round(s.intervalSumMs / s.intervalCount / 60000, 1) : null,
        passRate: s.called ? round(s.passed / s.called, 3) : null,
        cancelRate: s.issued ? round(s.cancelled / s.issued, 3) : null,
        peakHour: peak > 0 ? s.hourly.indexOf(peak) : null
    };
};

// days: [{ date, summary }] (日期由舊到新)；by: day | week | month
const groupSummaries = (days, by = 'day') => {
    const keyOf = d => by === 'week' ? weekStart(d) : by === 'month' ? monthKey(d) : d;
    const groups = new Map();
    days.forEach(({ date, summary }) => {
        const k = keyOf(date);
        if (!groups.has(k)) groups.set(k, { key: k, from: date, to: date, list: [] });
        const g = groups.get(k); g.to = date; g.list.push(summary);
    });
    return [...groups.values()].map(g => ({ key: g.key, from: g.from, to: g.to, ...finalize(mergeSummaries(g.list)) }));
};

module.exports = { emptySummary, summarizeDay, mergeSummaries, finalize, groupSummaries, twHour };
