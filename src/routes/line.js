/* LINE：Webhook (客人查詢 / 追蹤號碼) 與後台 LINE 設定 */
const express = require('express'), line = require('@line/bot-sdk');
const { redis } = require('../redis');
const { KEYS, S_KEYS, ADMIN_TOKEN, LINE_MSG_FIELDS, LINE_CMD_DEFAULTS } = require('../config');
const { safeEqual, toMax, maskSecret, formatPause } = require('../utils');
const { getPauseInfo } = require('../queue');
const { H } = require('../http');
const { auth, perm } = require('../auth');
const { addLog } = require('../log');
const { getLineConfig, initLine, ensureLineClient, getLineMsgs, getLineCmds, notifyTrackers } = require('../notify');

// Webhook 的簽章驗證需要原始 body，必須掛在 express.json() 之前
const webhook = express.Router();
webhook.post('/callback', async (req, res) => {
    try {
        const cfg = await getLineConfig();
        if (!cfg.channelAccessToken || !cfg.channelSecret) return res.status(500).end();
        line.middleware(cfg)(req, res, async (err) => {
            if (err) return res.status(403).json({ error: "Invalid Signature" });
            const client = ensureLineClient(cfg.channelAccessToken);
            try {
                const events = (req.body.events || []).filter(e => e.type === 'message' && e.message?.type === 'text' && e.source?.userId);
                if (!events.length) return res.json({});
                const [cmd, M, mDef] = await Promise.all([getLineCmds(), getLineMsgs(), redis.get(KEYS.LINE.MSG.DEFAULT)]);
                await Promise.all(events.map(async e => {
                    const txt = e.message.text.trim(), low = txt.toLowerCase(), uid = e.source.userId, rp = x => client.replyMessage({ replyToken: e.replyToken, messages: [{ type: 'text', text: x }] }).catch(console.error);
                    const inList = s => String(s).split(',').map(x => x.trim().toLowerCase()).filter(Boolean).includes(low);

                    if(txt === cmd.login.trim()) return rp((await redis.get(`${KEYS.LINE.ADMIN}${uid}`)) ? `🔗 ${process.env.RENDER_EXTERNAL_URL || ''}/admin.html` : (await redis.set(`${KEYS.LINE.CTX}${uid}`,'WAIT_PWD','EX',120), M.loginPrompt));
                    if((await redis.get(`${KEYS.LINE.CTX}${uid}`))==='WAIT_PWD' && safeEqual(txt, (await redis.get(KEYS.LINE.PWD)) || `unlock${ADMIN_TOKEN}`)) { await redis.multi().set(`${KEYS.LINE.ADMIN}${uid}`,"1","EX",600).del(`${KEYS.LINE.CTX}${uid}`).exec(); return rp(M.loginSuccess); }
                    const ar = await redis.hget(KEYS.LINE.AUTOREPLY, txt); if (ar) return rp(ar);
                    if(inList(cmd.status)) { const [n,i,my,pub]=await redis.mget(KEYS.CURRENT,KEYS.ISSUED,`${KEYS.LINE.USER}${uid}`,S_KEYS.PUBLIC), pause = pub==='0' ? `⛔ 暫停服務中${formatPause(await getPauseInfo())}\n` : ''; return rp(`${pause}目前叫號: ${n||0}\n已發號至: ${i||0}${my?`\n您的追蹤: ${my}號`:''}`); }
                    if(inList(cmd.cancel)) { const n=await redis.get(`${KEYS.LINE.USER}${uid}`); if(n){await redis.multi().del(`${KEYS.LINE.USER}${uid}`).srem(`${KEYS.LINE.SUB}${n}`,uid).exec(); return rp(M.cancel);} return rp(M.noTracking); }
                    if(inList(cmd.passed)) { const l = await redis.zrange(KEYS.PASSED, 0, -1); return rp(l.length ? `${M.passedPrefix}\n${l.join(', ')}` : M.noPassed); }
                    if(inList(cmd.help)) return rp(M.help);
                    if(/^\d{1,5}$/.test(txt)) {
                        // 以一般進度 (MAX) 判斷是否已過號；叫預約號時 CURRENT 可能大於 MAX
                        const n=parseInt(txt), [cRaw, mRaw]=await redis.mget(KEYS.CURRENT, KEYS.MAX), c=parseInt(cRaw)||0, mx=toMax(mRaw, c); if(n<=mx || n===c) return rp(M.passed);
                        const old = await redis.get(`${KEYS.LINE.USER}${uid}`), p = redis.multi();
                        if (old && old !== String(n)) p.srem(`${KEYS.LINE.SUB}${old}`, uid); // 改追蹤新號碼時，移除舊號碼的訂閱
                        await p.set(`${KEYS.LINE.USER}${uid}`,n,'EX',43200).sadd(`${KEYS.LINE.SUB}${n}`,uid).expire(`${KEYS.LINE.SUB}${n}`,43200).sadd(KEYS.LINE.ACTIVE,n).exec();
                        setTimeout(() => notifyTrackers(c), 1500); // 已在 5 組以內時，接在設定成功訊息之後發送快到號通知
                        return rp(M.success.replace(/{number}/g, n));
                    }
                    if (mDef && mDef.trim()) return rp(mDef);
                }));
                res.json({});
            } catch (e) { console.error(e); res.status(500).end(); }
        });
    } catch (e) { res.status(500).end(); }
});

const admin = express.Router();
// LINE 金鑰僅回傳遮罩值，不把完整 Token / Secret 傳到瀏覽器
admin.post("/api/admin/line-settings/get", auth, perm('perm_line_view'), H(async () => { const [t, s] = await redis.mget(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); return { "LINE Access Token": maskSecret(t), "LINE Channel Secret": maskSecret(s) }; }));
admin.post("/api/admin/line-settings/save", auth, perm('perm_line_edit'), H(async r => { const ok = v => typeof v === 'string' && v.trim() && !v.startsWith('••••'); const p = redis.multi(); if(ok(r.body["LINE Access Token"])) p.set(KEYS.LINE.CFG_TOKEN, r.body["LINE Access Token"].trim()); if(ok(r.body["LINE Channel Secret"])) p.set(KEYS.LINE.CFG_SECRET, r.body["LINE Channel Secret"].trim()); await p.exec(); await initLine(); addLog(r.user.nickname, "🔧 更新 LINE 設定"); }));
admin.post("/api/admin/line-settings/reset", auth, perm('perm_line_edit'), H(async r => { await redis.del(KEYS.LINE.CFG_TOKEN, KEYS.LINE.CFG_SECRET); await initLine(); addLog(r.user.nickname, "🔧 重置 LINE 設定"); }));
admin.post("/api/admin/line-settings/get-unlock-pass", auth, perm('perm_line_edit'), H(async () => ({ password: await redis.get(KEYS.LINE.PWD) })));
admin.post("/api/admin/line-settings/save-pass", auth, perm('perm_line_edit'), H(async r => { if(typeof r.body.password !== 'string') throw new Error("無效密碼"); await redis.set(KEYS.LINE.PWD, r.body.password.trim()); addLog(r.user.nickname, "🔧 更新 LINE 解鎖密碼"); }));

admin.post("/api/admin/line-messages/get", auth, perm('perm_line_view'), H(async () => getLineMsgs()));
admin.post("/api/admin/line-messages/save", auth, perm('perm_line_edit'), H(async r => { await redis.mset(...Object.entries(LINE_MSG_FIELDS).flatMap(([f, k]) => [KEYS.LINE.MSG[k], String(r.body[f] ?? '')])); addLog(r.user.nickname, "💬 更新 LINE 訊息"); }));
admin.post("/api/admin/line-autoreply/list", auth, perm('perm_line_view'), H(async () => redis.hgetall(KEYS.LINE.AUTOREPLY)));
admin.post("/api/admin/line-autoreply/save", auth, perm('perm_line_edit'), H(async r => { const k = String(r.body.keyword ?? '').trim(); if(!k||!r.body.reply) throw new Error("無效內容"); await redis.hset(KEYS.LINE.AUTOREPLY, k, String(r.body.reply)); addLog(r.user.nickname, `➕ LINE 關鍵字: ${k}`); }));
admin.post("/api/admin/line-autoreply/edit", auth, perm('perm_line_edit'), H(async r => { const o = String(r.body.oldKeyword ?? ''), n = String(r.body.newKeyword ?? '').trim(), p = r.body.newReply; if(!n||!p) throw new Error("空值"); const pipe=redis.multi(); if(o!==n) pipe.hdel(KEYS.LINE.AUTOREPLY, o); pipe.hset(KEYS.LINE.AUTOREPLY, n, String(p)); await pipe.exec(); addLog(r.user.nickname, `✎ 修改 LINE 規則: ${o}->${n}`); }));
admin.post("/api/admin/line-autoreply/del", auth, perm('perm_line_edit'), H(async r => { await redis.hdel(KEYS.LINE.AUTOREPLY, String(r.body.keyword ?? '')); addLog(r.user.nickname, `🗑️ 移除 LINE 關鍵字: ${r.body.keyword}`); }));
admin.post("/api/admin/line-default-reply/get", auth, perm('perm_line_view'), H(async () => ({ reply: await redis.get(KEYS.LINE.MSG.DEFAULT) })));
admin.post("/api/admin/line-default-reply/save", auth, perm('perm_line_edit'), H(async r => { await redis.set(KEYS.LINE.MSG.DEFAULT, String(r.body.reply ?? '')); addLog(r.user.nickname, "🔧 更新 LINE 預設回覆"); }));
admin.post("/api/admin/line-system-keywords/get", auth, perm('perm_line_view'), H(async () => getLineCmds()));
admin.post("/api/admin/line-system-keywords/save", auth, perm('perm_line_edit'), H(async r => { await redis.mset(...Object.keys(LINE_CMD_DEFAULTS).flatMap(k => [KEYS.LINE.CMD[k.toUpperCase()], String(r.body[k] ?? '').trim() || LINE_CMD_DEFAULTS[k]])); addLog(r.user.nickname, "🔧 更新 LINE 指令"); }));

module.exports = { webhook, admin };
