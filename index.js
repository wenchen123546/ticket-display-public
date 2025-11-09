/*
 * ==========================================
 * 伺服器 (index.js)
 * ... (舊註解) ...
 * * 8. 【CSP 修正 v2】 
 * * - 修正 helmet 的 CSP 策略，允許載入 GridStack 和 QR Code 的 CDN
 * * 9. 【新功能】 
 * * - 實作「伺服器端」的後台日誌 (Redis List + Socket.io)
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const Redis = require("ioredis");
const helmet = require('helmet'); 
const rateLimit = require('express-rate-limit'); 

// --- 2. 伺服器實體化 ---
const app = express();
const server = http.createServer(app);
const io = socketio(server);

// --- 3. 核心設定 & 安全性 ---
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const REDIS_URL = process.env.UPSTASH_REDIS_URL;

// --- 4. 關鍵檢查 ---
if (!ADMIN_TOKEN) {
    console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
    process.exit(1);
}
if (!REDIS_URL) {
    console.error("❌ 錯誤： UPSTASH_REDIS_URL 環境變數未設定！");
    process.exit(1);
}

// --- 5. 連線到 Upstash Redis ---
const redis = new Redis(REDIS_URL, {
    tls: {
        rejectUnauthorized: false
    }
});
redis.on('connect', () => { console.log("✅ 成功連線到 Upstash Redis 資料庫。"); });
redis.on('error', (err) => { console.error("❌ Redis 連線錯誤:", err); process.exit(1); });

redis.defineCommand("decrIfPositive", {
    numberOfKeys: 1,
    lua: `
        local currentValue = tonumber(redis.call("GET", KEYS[1]))
        if currentValue > 0 then
            return redis.call("DECR", KEYS[1])
        else
            return currentValue
        end
    `,
});


// --- 6. Redis Keys & 全域狀態 ---
const KEY_CURRENT_NUMBER = 'callsys:number';
const KEY_PASSED_NUMBERS = 'callsys:passed';
const KEY_FEATURED_CONTENTS = 'callsys:featured';
const KEY_LAST_UPDATED = 'callsys:updated';
const KEY_SOUND_ENABLED = 'callsys:soundEnabled';
const KEY_IS_PUBLIC = 'callsys:isPublic'; 
// KEY_ADMIN_LAYOUT 已移除
const KEY_ADMIN_LOG = 'callsys:admin-log'; // 【新功能】 伺服器端日誌

// --- 7. Express 中介軟體 (Middleware) ---

app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
        "style-src": ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
        "connect-src": ["'self'", "https://cdn.jsdelivr.net"]
      },
    },
}));
app.use(express.static("public"));
app.use(express.json());

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 1000, 
    message: { error: "請求過於頻繁，請稍後再試。" },
    standardHeaders: true, 
    legacyHeaders: false, 
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, 
    max: 10, 
    message: { error: "登入嘗試次數過多，請 15 分鐘後再試。" },
    standardHeaders: true,
    legacyHeaders: false,
});

const authMiddleware = (req, res, next) => {
    const { token } = req.body;
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: "密碼錯誤" });
    }
    next();
};

// --- 8. 輔助函式 ---
async function updateTimestamp() {
    const now = new Date().toISOString();
    await redis.set(KEY_LAST_UPDATED, now);
    io.emit("updateTimestamp", now);
}
async function broadcastPassedNumbers() {
    try {
        const numbersRaw = await redis.zrange(KEY_PASSED_NUMBERS, 0, -1);
        const numbers = numbersRaw.map(Number);
        io.emit("updatePassed", numbers);
        await updateTimestamp();
    } catch (e) {
        console.error("broadcastPassedNumbers 失敗:", e);
    }
}
async function broadcastFeaturedContents() {
    try {
        const contentsJSONs = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        const contents = contentsJSONs.map(JSON.parse);
        io.emit("updateFeaturedContents", contents);
        await updateTimestamp();
    } catch (e) {
        console.error("broadcastFeaturedContents 失敗:", e);
    }
}

// --- 【新功能】 伺服器端日誌函式 ---
async function addAdminLog(message) {
    try {
        const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        const logMessage = `[${timestamp}] ${message}`;
        
        // 1. 將日誌推入 Redis List (LIFO)
        await redis.lpush(KEY_ADMIN_LOG, logMessage);
        // 2. 修剪列表，只保留最新的 50 筆
        await redis.ltrim(KEY_ADMIN_LOG, 0, 50);
        // 3. 透過 Socket.io 廣播給所有在線的管理員
        io.emit("newAdminLog", logMessage);
        
    } catch (e) {
        console.error("addAdminLog 失敗:", e);
    }
}


// --- 9. API 路由 (Routes) ---

app.post("/check-token", loginLimiter, authMiddleware, (req, res) => { res.json({ success: true }); });

const protectedAPIs = [
    "/change-number", "/set-number",
    "/api/passed/add", "/api/passed/remove", "/api/passed/clear",
    "/api/featured/add", "/api/featured/remove", "/api/featured/clear",
    "/set-sound-enabled", "/set-public-status", "/reset",
    // layout API 已移除
    "/api/logs/clear" // 【新】 保護清空日誌 API
];
app.use(protectedAPIs, apiLimiter, authMiddleware);

app.post("/change-number", async (req, res) => {
    try {
        const { direction } = req.body;
        let num;
        if (direction === "next") {
            num = await redis.incr(KEY_CURRENT_NUMBER);
            await addAdminLog(`號碼增加為 ${num}`); // 【日誌】
        }
        else if (direction === "prev") {
            const oldNum = await redis.get(KEY_CURRENT_NUMBER) || 0;
            num = await redis.decrIfPositive(KEY_CURRENT_NUMBER);
            if (Number(oldNum) > 0) {
                await addAdminLog(`號碼減少為 ${num}`); // 【日誌】
            }
        } 
        else {
            num = await redis.get(KEY_CURRENT_NUMBER) || 0;
        }
        io.emit("update", num);
        await updateTimestamp();
        res.json({ success: true, number: num });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/set-number", async (req, res) => {
    try {
        const { number } = req.body;
        const num = Number(number);
        if (isNaN(num) || num < 0 || !Number.isInteger(num)) {
            return res.status(400).json({ error: "請提供一個有效的非負整數。" });
        }
        await redis.set(KEY_CURRENT_NUMBER, num);
        await addAdminLog(`號碼手動設定為 ${num}`); // 【日誌】
        io.emit("update", num);
        await updateTimestamp();
        res.json({ success: true, number: num });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/passed/add", async (req, res) => {
    try {
        const { number } = req.body;
        const num = Number(number);
        if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
            return res.status(400).json({ error: "請提供有效的正整數。" });
        }
        await redis.zadd(KEY_PASSED_NUMBERS, num, num);
        await redis.zremrangebyrank(KEY_PASSED_NUMBERS, 0, -21); // 自動修剪 (保留 20)
        await addAdminLog(`過號列表新增 ${num}`); // 【日誌】
        await broadcastPassedNumbers();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/remove", async (req, res) => {
    try {
        const { number } = req.body;
        await redis.zrem(KEY_PASSED_NUMBERS, number);
        await addAdminLog(`過號列表移除 ${number}`); // 【日誌】
        await broadcastPassedNumbers();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/add", async (req, res) => {
    try {
        const { linkText, linkUrl } = req.body;
        if (!linkText || !linkUrl) {
            return res.status(400).json({ error: "文字和網址皆必填。" });
        }
        if (!linkUrl.startsWith('http://') && !linkUrl.startsWith('https://')) {
            return res.status(400).json({ error: "網址請務必以 http:// 或 https:// 開頭。" });
        }
        const item = { linkText, linkUrl };
        await redis.rpush(KEY_FEATURED_CONTENTS, JSON.stringify(item));
        await addAdminLog(`精選連結新增: ${linkText}`); // 【日誌】
        await broadcastFeaturedContents();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/remove", async (req, res) => {
    try {
        const { linkText, linkUrl } = req.body;
        if (!linkText || !linkUrl) {
            return res.status(400).json({ error: "缺少必要參數。" });
        }
        const item = { linkText, linkUrl };
        await redis.lrem(KEY_FEATURED_CONTENTS, 1, JSON.stringify(item));
        await addAdminLog(`精選連結移除: ${linkText}`); // 【日誌】
        await broadcastFeaturedContents();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/clear", async (req, res) => {
    try {
        await redis.del(KEY_PASSED_NUMBERS);
        await addAdminLog(`過號列表已清空`); // 【日誌】
        io.emit("updatePassed", []);
        await updateTimestamp();
        res.json({ success: true, message: "過號列表已清空" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/clear", async (req, res) => {
    try {
        await redis.del(KEY_FEATURED_CONTENTS);
        await addAdminLog(`精選連結已清空`); // 【日誌】
        io.emit("updateFeaturedContents", []);
        await updateTimestamp();
        res.json({ success: true, message: "精選連結已清空" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/set-sound-enabled", async (req, res) => {
    try {
        const { enabled } = req.body;
        const valueToSet = enabled ? "1" : "0";
        await redis.set(KEY_SOUND_ENABLED, valueToSet);
        await addAdminLog(`前台音效已設為: ${enabled ? '開啟' : '關閉'}`); // 【日誌】
        io.emit("updateSoundSetting", enabled);
        await updateTimestamp();
        res.json({ success: true, isEnabled: enabled });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/set-public-status", async (req, res) => {
    try {
        const { isPublic } = req.body;
        const valueToSet = isPublic ? "1" : "0";
        await redis.set(KEY_IS_PUBLIC, valueToSet);
        await addAdminLog(`前台已設為: ${isPublic ? '對外開放' : '關閉維護'}`); // 【日誌】
        io.emit("updatePublicStatus", isPublic); 
        await updateTimestamp();
        res.json({ success: true, isPublic: isPublic });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/reset", async (req, res) => {
    try {
        const multi = redis.multi();
        multi.set(KEY_CURRENT_NUMBER, 0);
        multi.del(KEY_PASSED_NUMBERS);
        multi.del(KEY_FEATURED_CONTENTS);
        multi.set(KEY_SOUND_ENABLED, "1");
        multi.set(KEY_IS_PUBLIC, "1"); 
        // multi.del(KEY_ADMIN_LAYOUT); (已移除)
        multi.del(KEY_ADMIN_LOG); // 【新】 重置時也清空日誌
        await multi.exec();

        await addAdminLog(`💥 系統已重置所有資料`); // 【日誌】

        io.emit("update", 0);
        io.emit("updatePassed", []);
        io.emit("updateFeaturedContents", []);
        io.emit("updateSoundSetting", true);
        io.emit("updatePublicStatus", true); 
        io.emit("initAdminLogs", []); // 【新】 廣播清空日誌

        await updateTimestamp();

        res.json({ success: true, message: "已重置所有內容" });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 10. Socket.io 連線處理 ---
io.on("connection", async (socket) => {
    const token = socket.handshake.auth.token;
    const isAdmin = (token === ADMIN_TOKEN && token !== undefined);

    if (isAdmin) {
        console.log("✅ 一個已驗證的 Admin 連線", socket.id);
        socket.on("disconnect", (reason) => {
            console.log(`🔌 Admin ${socket.id} 斷線: ${reason}`);
        });

        // 【新】 Admin 連線時，傳送日誌歷史
        try {
            const logs = await redis.lrange(KEY_ADMIN_LOG, 0, 50);
            socket.emit("initAdminLogs", logs); // 只傳送給這個剛連線的 admin
        } catch (e) {
            console.error("讀取日誌歷史失敗:", e);
        }

    } else {
        console.log("🔌 一個 Public User 連線", socket.id);
    }

    try {
        const pipeline = redis.multi();
        pipeline.get(KEY_CURRENT_NUMBER);
        pipeline.zrange(KEY_PASSED_NUMBERS, 0, -1);
        pipeline.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        pipeline.get(KEY_LAST_UPDATED);
        pipeline.get(KEY_SOUND_ENABLED);
        pipeline.get(KEY_IS_PUBLIC); 
        
        const results = await pipeline.exec();
        if (results.some(res => res[0] !== null)) {
            const firstError = results.find(res => res[0] !== null)[0];
            throw new Error(`Redis multi 執行失敗: ${firstError.message}`);
        }
        const [
            [err0, currentNumberRaw],
            [err1, passedNumbersRaw],
            [err2, featuredContentsJSONs],
            [err3, lastUpdatedRaw],
            [err4, soundEnabledRaw],
            [err5, isPublicRaw]
        ] = results;

        const currentNumber = Number(currentNumberRaw || 0);
        const passedNumbers = (passedNumbersRaw || []).map(Number);
        const featuredContents = (featuredContentsJSONs || []).map(JSON.parse);
        const lastUpdated = lastUpdatedRaw || new Date().toISOString();
        const isSoundEnabled = soundEnabledRaw === null ? "1" : soundEnabledRaw;
        const isPublic = isPublicRaw === null ? "1" : isPublicRaw; 

        socket.emit("update", currentNumber);
        socket.emit("updatePassed", passedNumbers);
        socket.emit("updateFeaturedContents", featuredContents);
        socket.emit("updateTimestamp", lastUpdated);
        socket.emit("updateSoundSetting", isSoundEnabled === "1");
        socket.emit("updatePublicStatus", isPublic === "1"); 

    }
    catch (e) {
        console.error("Socket 連線處理失敗:", e);
        socket.emit("initialStateError", "無法載入初始資料，請稍後重新整理。");
    }
});

// --- 11. 儀表板排版 API --- (已移除)

// --- 【新功能】 清空日誌 API ---
app.post("/api/logs/clear", async (req, res) => {
    try {
        await redis.del(KEY_ADMIN_LOG);
        await addAdminLog(`🧼 管理員清空了所有日誌`); // 【日誌】
        io.emit("initAdminLogs", []); // 廣播清空
        res.json({ success: true, message: "日誌已清空。" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- 12. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
