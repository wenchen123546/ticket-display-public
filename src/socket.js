/* Socket.io：連線時辨識管理員 Session，並推送目前狀態 */
const { io } = require('./server');
const { redis } = require('./redis');
const { KEYS, S_KEYS } = require('./config');
const { parseCookie, safeJSON } = require('./utils');
const { getQueueState, calcWaitTime, broadcastAppts, getFeatured, getPassedBack, getPauseInfo } = require('./queue');

const emitOnlineAdmins = async () => { const socks = await io.in("admin").fetchSockets(); io.to("admin").emit("updateOnlineAdmins", [...new Map(socks.filter(x => x.data.user).map(x => [x.data.user.username, x.data.user])).values()]); };

const setupSocket = () => {
    io.use(async (s, next) => { try { const t = s.handshake.auth.token || parseCookie(s.request.headers.cookie||'')['token']; if(t) { const u = safeJSON(await redis.get(`${KEYS.SESSION}${t}`)); if(u) s.data.user = u; } } catch(e) {} next(); });

    io.on("connection", async s => {
        try {
            if(s.data.user) {
                s.join("admin"); s.on("disconnect", () => emitOnlineAdmins().catch(() => {}));
                await emitOnlineAdmins(); s.emit("initAdminLogs", await redis.lrange(KEYS.LOGS,0,99)); broadcastAppts(s).catch(() => {});
                s.emit("updatePassedBack", await getPassedBack());
            }
            const [[snd,pub,m,h,allowT,fTexts], p, f, q, pause] = await Promise.all([redis.mget(S_KEYS.SOUND, S_KEYS.PUBLIC, KEYS.MODE, KEYS.HOURS, S_KEYS.ALLOW_T, KEYS.FRONTEND_TEXTS), redis.zrange(KEYS.PASSED,0,-1), getFeatured(), getQueueState(), getPauseInfo()]);
            s.emit("update",q.current);
            s.emit("updateQueue",q);
            s.emit("updatePassed",p.map(Number));
            s.emit("updateFeaturedContents",f);
            s.emit("updateSoundSetting",snd==="1");
            s.emit("updatePauseInfo", pause);
            s.emit("updatePublicStatus",pub!=="0");
            s.emit("updateSystemMode",m||'ticketing');
            s.emit("updateWaitTime",await calcWaitTime());
            s.emit("updateTicketingEnabled", allowT!=="0");
            s.emit("updateBusinessHours", safeJSON(h, {enabled:false}));
            s.emit("updateFrontendTexts", safeJSON(fTexts, {}));
        } catch(e) { console.error("Socket Init Error:", e.message); }
    });
};

module.exports = setupSocket;
