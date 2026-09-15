/* 後台：統計、營運報表、CSV、操作日誌、系統開關、暫停資訊、營業時間、前台文字 */
const express = require('express');
const { redis } = require('../redis');
const { io } = require('../server');
const { KEYS, S_KEYS, FRONTEND_TEXT_KEYS, MAX_REPORT_DAYS } = require('../config');
const { getTWTime, twTimeString, netHourly, validateNum, safeJSON, HM_RE, csvEscape, cleanText, formatPause } = require('../utils');
const { isDate, dateRange } = require('../schedule');
const { summarizeDay, mergeSummaries, finalize, groupSummaries } = require('../stats');
const { getRecentHistory, getHistoryForDates, clearDayHistory } = require('../history');
const { H } = require('../http');
const { auth, perm } = require('../auth');
const { addLog } = require('../log');
const { bumpHourly, resetSys, getHours, getPauseInfo } = require('../queue');

const router = express.Router();

// 報表 / 匯出的日期範圍：from ~ to (含)，只給 date 時為單日，都沒給時為今天
const parseRange = body => {
    const today = getTWTime().dateStr, from = isDate(body.from) ? body.from : isDate(body.date) ? body.date : today, to = isDate(body.to) ? body.to : from;
    const dates = dateRange(from, to, MAX_REPORT_DAYS + 1);
    if(!dates.length) throw new Error("日期範圍無效");
    if(dates.length > MAX_REPORT_DAYS) throw new Error(`日期範圍最多 ${MAX_REPORT_DAYS} 天`);
    return dates;
};

router.post("/api/admin/stats", auth, perm('perm_stats_view'), H(async () => { const {dateStr, hour} = getTWTime(), counts = netHourly(await redis.hgetall(`${KEYS.HOURLY}${dateStr}`)); return { history: await getRecentHistory(dateStr, 50), hourlyCounts: counts, todayCount: counts.reduce((a, v) => a + v, 0), serverHour: hour }; }));
router.post("/api/admin/stats/clear", auth, perm('perm_stats_edit'), H(async r => { const {dateStr} = getTWTime(); await redis.del(`${KEYS.HOURLY}${dateStr}`); await clearDayHistory(dateStr); addLog(r.user.nickname, "🗑️ 清空今日統計"); }));
router.post("/api/admin/stats/adjust", auth, perm('perm_stats_edit'), H(async r => { const h = validateNum(r.body.hour, 0, 23), d = parseInt(r.body.delta); if(h === null || !Number.isInteger(d) || Math.abs(d) > 1000) throw new Error("非法數值"); const k = `${KEYS.HOURLY}${getTWTime().dateStr}`; await redis.multi().hincrby(k, `${h}_i`, d).expire(k, 172800).exec(); }));
router.post("/api/admin/stats/calibrate", auth, perm('perm_stats_edit'), H(async r => { const {dateStr} = getTWTime(), [issued, passedCount, cancelCount, hData] = await Promise.all([redis.get(KEYS.ISSUED), redis.zcard(KEYS.PASSED), redis.zcard(KEYS.CANCELLED), redis.hgetall(`${KEYS.HOURLY}${dateStr}`)]), targetTotal = Math.max(0, (parseInt(issued)||0) - passedCount - cancelCount), diff = targetTotal - netHourly(hData).reduce((a, v) => a + v, 0); if(diff !== 0) { await bumpHourly('i', diff); addLog(r.user.nickname, `⚖️ 校正統計 (${diff>0?'+':''}${diff})`); } return { success: true, diff }; }));

// 營運報表：依日 / 週 / 月彙總發號、叫號、平均等待、過號率、放棄率、尖峰時段
router.post("/api/admin/report", auth, perm('perm_stats_view'), H(async r => {
    const dates = parseRange(r.body || {}), group = ['day', 'week', 'month'].includes(r.body?.group) ? r.body.group : 'day';
    const days = (await getHistoryForDates(dates)).map(d => ({ date: d.date, summary: summarizeDay(d.rows) }));
    return { from: dates[0], to: dates[dates.length - 1], group, groups: groupSummaries(days, group), total: finalize(mergeSummaries(days.map(d => d.summary))) };
}));
router.post("/api/admin/export-csv", auth, perm('perm_stats_view'), H(async r => {
    const dates = parseRange(r.body || {}), rows = (await getHistoryForDates(dates)).flatMap(d => d.rows);
    return { csvData: "Date,Time,Number,Action,Operator,Wait(min)\n" + rows.map(x => [x.date_str, twTimeString(new Date(x.timestamp)), x.number, x.action, x.operator, x.wait_time_min].map(csvEscape).join(",")).join("\n"), fileName: dates.length === 1 ? `export_${dates[0]}.csv` : `export_${dates[0]}_${dates[dates.length - 1]}.csv` };
}));
router.post("/api/logs/clear", auth, perm('perm_logs_edit'), H(async r => { await redis.del(KEYS.LOGS); io.to("admin").emit("initAdminLogs", []); }));

router.post("/set-sound-enabled", auth, perm('perm_system_edit'), H(async r=>{ const v = !!r.body.enabled; await redis.set(S_KEYS.SOUND, v?"1":"0"); io.emit("updateSoundSetting", v); }));
// 重新開放前台時清除暫停資訊
router.post("/set-public-status", auth, perm('perm_system_edit'), H(async r=>{ const v = !!r.body.isPublic; await redis.set(S_KEYS.PUBLIC, v?"1":"0"); if(v) { await redis.del(KEYS.PAUSE); io.emit("updatePauseInfo", {}); } io.emit("updatePublicStatus", v); }));
router.post("/set-system-mode", auth, perm('perm_system_edit'), H(async r=>{ if(!['ticketing','input'].includes(r.body.mode)) throw new Error("無效模式"); await redis.set(KEYS.MODE, r.body.mode); io.emit("updateSystemMode", r.body.mode); }));
router.post("/set-ticketing-enabled", auth, perm('perm_system_edit'), H(async r=>{ const v = !!r.body.enabled; await redis.set(S_KEYS.ALLOW_T, v?"1":"0"); io.emit("updateTicketingEnabled", v); }));
router.post("/reset", auth, perm('perm_system_edit'), H(async r => resetSys(r.user.nickname)));
router.post("/api/admin/broadcast", auth, perm('perm_system_edit'), H(async r => { if(!r.body.message || typeof r.body.message !== 'string') throw new Error("無效訊息"); const msg = r.body.message.slice(0, 500); io.emit("adminBroadcast", msg); addLog(r.user.nickname, `📢 廣播: ${msg}`); }));

// 暫停服務資訊：預計恢復時間 (HH:MM，可留白) 與原因，顯示在前台暫停畫面、取號錯誤與 LINE 查詢
router.post("/api/admin/pause-info/get", auth, perm('perm_system_view'), H(async () => getPauseInfo()));
router.post("/api/admin/pause-info/save", auth, perm('perm_system_edit'), H(async r => {
    const resumeAt = String(r.body.resumeAt ?? '').trim(), reason = cleanText(r.body.reason, 50);
    if(resumeAt && !HM_RE.test(resumeAt)) throw new Error("時間格式錯誤 (HH:MM)");
    const info = { resumeAt, reason };
    await redis.set(KEYS.PAUSE, JSON.stringify(info)); io.emit("updatePauseInfo", info);
    addLog(r.user.nickname, `⛔ 暫停資訊${formatPause(info) || '：已清除'}`);
    return info;
}));

router.post("/api/admin/settings/hours/get", auth, perm('perm_system_view'), H(async () => getHours()));
router.post("/api/admin/settings/hours/save", auth, perm('perm_system_edit'), H(async r => { const cfg = { start: r.body.start, end: r.body.end, enabled: !!r.body.enabled }; if(!HM_RE.test(cfg.start) || !HM_RE.test(cfg.end)) throw new Error("時間格式錯誤 (HH:MM)"); await redis.set(KEYS.HOURS, JSON.stringify(cfg)); addLog(r.user.nickname, `🔧 更新營業時間 ${cfg.start}-${cfg.end}`); io.emit("updateBusinessHours", cfg); }));

// 儲存與獲取前台自定義文字 API (僅接受白名單欄位)
router.post("/api/admin/frontend-texts/get", auth, perm('perm_system_view'), H(async () => safeJSON(await redis.get(KEYS.FRONTEND_TEXTS), {})));
router.post("/api/admin/frontend-texts/save", auth, perm('perm_system_edit'), H(async r => { const texts = {}; FRONTEND_TEXT_KEYS.forEach(k => { const v = r.body.texts?.[k]; if(typeof v === 'string' && v.trim()) texts[k] = v.trim().slice(0, 100); }); await redis.set(KEYS.FRONTEND_TEXTS, JSON.stringify(texts)); io.emit("updateFrontendTexts", texts); addLog(r.user.nickname, "🔧 更新前台顯示文字"); }));

module.exports = router;
