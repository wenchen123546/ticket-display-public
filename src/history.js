/* 叫號明細 (Redis)：每天一個 list，保留 HIST_TTL；報表與 CSV 由明細即時計算 */
const { redis } = require('./redis');
const { KEYS, HIST_TTL } = require('./config');
const { getTWTime, safeJSON } = require('./utils');

const dayKey = date => `${KEYS.HIST}${date}`;
const parseRows = list => (list || []).map(x => safeJSON(x)).filter(Boolean);

// 寫入失敗只記錄錯誤，不影響叫號流程
const addHistory = async (action, number, operator, wait_time_min = null, timestamp = Date.now()) => {
    const date_str = getTWTime(new Date(timestamp)).dateStr, k = dayKey(date_str);
    try { await redis.multi().rpush(k, JSON.stringify({ date_str, timestamp, number, action, operator, wait_time_min })).expire(k, HIST_TTL).exec(); }
    catch (e) { console.error("History Error:", e.message); }
};
const getRecentHistory = async (date, n = 50) => parseRows(await redis.lrange(dayKey(date), -n, -1)).reverse();
const getHistoryForDates = async dates => {
    if (!dates.length) return [];
    const res = await dates.reduce((p, d) => p.lrange(dayKey(d), 0, -1), redis.pipeline()).exec();
    return dates.map((date, i) => ({ date, rows: parseRows(res[i][1]) }));
};
const clearDayHistory = date => redis.del(dayKey(date));

module.exports = { addHistory, getRecentHistory, getHistoryForDates, clearDayHistory };
