/* 到號通知：LINE 用戶端、Web Push 金鑰、訊息範本與 notifyTrackers */
const line = require('@line/bot-sdk'), webpush = require('web-push');
const { redis } = require('./redis');
const { KEYS, LAT, LCS, APPROACH_DIFF, LINE_MSG_FIELDS, LINE_MSG_DEFAULTS, LINE_CMD_DEFAULTS } = require('./config');
const { safeJSON, toMax } = require('./utils');

let lineClient = null, pushReady = false, vapidPublic = null;

// 後台設定的 Token / Secret 優先，其次為環境變數
const getLineConfig = async () => { const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); return { channelAccessToken: t||LAT, channelSecret: s||LCS }; };
const initLine = async () => { const cfg = await getLineConfig(); if (cfg.channelAccessToken && cfg.channelSecret) lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: cfg.channelAccessToken }); else { lineClient = null; console.warn("⚠️ LINE Token Missing"); } };
const ensureLineClient = token => lineClient || (lineClient = new line.messagingApi.MessagingApiClient({ channelAccessToken: token }));

// Web Push 金鑰：優先使用環境變數；未設定時自動產生並存在 Redis，重啟後沿用 (換金鑰會讓既有訂閱失效)
const initPush = async () => {
    try {
        let k = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
        if (!k.publicKey || !k.privateKey) {
            k = safeJSON(await redis.get(KEYS.PUSH.VAPID));
            if (!k) { const g = webpush.generateVAPIDKeys(); k = (await redis.set(KEYS.PUSH.VAPID, JSON.stringify(g), 'NX')) ? g : safeJSON(await redis.get(KEYS.PUSH.VAPID)); }
        }
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || process.env.RENDER_EXTERNAL_URL || 'mailto:admin@localhost', k.publicKey, k.privateKey);
        vapidPublic = k.publicKey; pushReady = true;
    } catch (e) { pushReady = false; console.error("Push Init Error:", e.message); }
};
const getPushState = () => ({ ready: pushReady, publicKey: vapidPublic });

const getLineMsgs = async () => { const f = Object.keys(LINE_MSG_FIELDS), v = await redis.mget(...f.map(k => KEYS.LINE.MSG[LINE_MSG_FIELDS[k]])); return Object.fromEntries(f.map((k, i) => [k, v[i] || LINE_MSG_DEFAULTS[k]])); };
const getLineCmds = async () => { const f = Object.keys(LINE_CMD_DEFAULTS), v = await redis.mget(...f.map(k => KEYS.LINE.CMD[k.toUpperCase()])); return Object.fromEntries(f.map((k, i) => [k, v[i] || LINE_CMD_DEFAULTS[k]])); };

// 到號 / 快到號通知 (LINE + Web Push)
// 到號：號碼等於目前叫號，或已被一般進度 (MAX) 越過 → 叫號一次跳好幾號時，中間的人也會收到
// 快到：距離一般進度 APPROACH_DIFF 組以內，每位訂閱者每個號碼只通知一次
async function notifyTrackers(current) {
    try {
        const [[m, counter, fTexts], lineNums, pushNums] = await Promise.all([redis.mget(KEYS.MAX, KEYS.COUNTER, KEYS.FRONTEND_TEXTS), redis.smembers(KEYS.LINE.ACTIVE), redis.smembers(KEYS.PUSH.ACTIVE)]);
        const nums = [...new Set([...lineNums, ...pushNums])].map(Number).filter(n => n > 0);
        if (!nums.length) return;
        const max = toMax(m, current), M = await getLineMsgs(), title = safeJSON(fTexts, {}).brand_title || '即時叫號系統';
        const sendLine = (ids, txt) => { if (!lineClient) return; for (let k = 0; k < ids.length; k += 500) lineClient.multicast({ to: ids.slice(k, k + 500), messages: [{ type: 'text', text: txt }] }).catch(e => console.error("LINE Push Error:", e.message)); };
        const sendPush = (n, subs, body) => { if (!pushReady) return; Object.entries(subs).forEach(([id, json]) => { const s = safeJSON(json); if (s) webpush.sendNotification(s, JSON.stringify({ title, body, tag: `callsys-${n}` }), { TTL: 900 }).catch(e => { if ([404, 410].includes(e.statusCode)) redis.hdel(`${KEYS.PUSH.SUB}${n}`, id).catch(() => {}); else console.error("Web Push Error:", e.statusCode || e.message); }); }); };
        for (const n of nums) {
            const arrived = n === current || n <= max, near = !arrived && n - max <= APPROACH_DIFF;
            if (!arrived && !near) continue;
            const [uids, subs] = await Promise.all([redis.smembers(`${KEYS.LINE.SUB}${n}`), redis.hgetall(`${KEYS.PUSH.SUB}${n}`)]);
            if (arrived) {
                const txt = M.arrival.replace(/{current}/g, n).replace(/{number}/g, n).replace(/{counter}/g, counter || '櫃台');
                sendLine(uids, txt); sendPush(n, subs, txt);
                const p = redis.multi().del(`${KEYS.LINE.SUB}${n}`, `${KEYS.PUSH.SUB}${n}`).srem(KEYS.LINE.ACTIVE, n).srem(KEYS.PUSH.ACTIVE, n);
                if (uids.length) p.del(...uids.map(u => `${KEYS.LINE.USER}${u}`));
                await p.exec();
            } else {
                const members = [...uids.map(u => `${n}:L:${u}`), ...Object.keys(subs).map(id => `${n}:P:${id}`)];
                if (!members.length) continue;
                const r = await members.reduce((p, x) => p.sadd(KEYS.APPROACHED, x), redis.multi()).expire(KEYS.APPROACHED, 43200).exec();
                const fresh = new Set(members.filter((_, k) => r[k][1] === 1)), txt = M.approach.replace(/{current}/g, current).replace(/{target}/g, n).replace(/{diff}/g, n - max);
                sendLine(uids.filter(u => fresh.has(`${n}:L:${u}`)), txt);
                sendPush(n, Object.fromEntries(Object.entries(subs).filter(([id]) => fresh.has(`${n}:P:${id}`))), txt);
            }
        }
    } catch (e) { console.error("notifyTrackers Error:", e.message); }
}

module.exports = { getLineConfig, initLine, ensureLineClient, initPush, getPushState, getLineMsgs, getLineCmds, notifyTrackers };
