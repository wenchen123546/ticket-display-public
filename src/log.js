/* 後台操作日誌：保留最近 100 筆並即時推送給在線管理員 */
const { redis } = require('./redis'), { io } = require('./server');
const { KEYS } = require('./config'), { twTimeString } = require('./utils');

const addLog = async (n, m) => { const l = `[${twTimeString()}] [${n}] ${m}`; await redis.multi().lpush(KEYS.LOGS, l).ltrim(KEYS.LOGS, 0, 99).exec(); io.to("admin").emit("newAdminLog", l); };

module.exports = { addLog };
