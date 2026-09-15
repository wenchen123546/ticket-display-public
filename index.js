/* Server v19.0 - 入口：載入設定、組裝應用、排程與啟動 / 關機流程 (功能實作在 src/) */
require('dotenv').config();
const { PORT, REDIS_URL, ADMIN_TOKEN, KEYS, DEFAULT_ROLES } = require('./src/config');
if (!ADMIN_TOKEN || !REDIS_URL) { console.error("❌ Missing ADMIN_TOKEN or REDIS_URL"); process.exit(1); }

const cron = require('node-cron');
const { server, io } = require('./src/server');
const { redis, onRedisReady } = require('./src/redis');
const { initLine, initPush } = require('./src/notify');
const { resetSys } = require('./src/queue');
const setupApp = require('./src/app');

onRedisReady(() => {
    initLine().catch(e => console.error("LINE Init Error:", e.message));
    initPush();
    redis.setnx(KEYS.ROLES, JSON.stringify(DEFAULT_ROLES)).catch(e => console.error("Roles Init Error:", e.message));
});
setupApp();

// 每天 04:00 自動重置叫號；叫號明細由 Redis TTL 自動過期
cron.schedule('0 4 * * *', async () => { try { await resetSys('系統自動'); } catch(e) { console.error("Cron Error:", e.message); } }, { timezone: "Asia/Taipei" });

process.on('unhandledRejection', e => console.error('Unhandled Rejection:', e));
process.on('uncaughtException', e => { console.error('Uncaught Exception:', e); });

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Server v19.0 running on ${PORT}`));

let shuttingDown = false;
['SIGTERM','SIGINT'].forEach(sig => process.on(sig, () => {
    if(shuttingDown) return; shuttingDown = true;
    console.log(`\n🛑 ${sig} - Graceful shutdown...`);
    setTimeout(() => process.exit(1), 5000).unref();
    io.close(); // 同時關閉 socket 連線與 HTTP server，否則 server.close 會被長連線卡住
    redis.quit().catch(() => {}).finally(() => { console.log('👋 Server closed.'); process.exit(0); });
}));
