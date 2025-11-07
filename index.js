/*
 * ==========================================
 * 伺服器 (index.js)
 * * (使用 Upstash Redis 資料庫)
 * * (已加入「音效開關」功能)
 * * (已加入 API 驗證、Redis 事務、Socket 錯誤處理)
 * *
 * * 【2025-11-07 重構】
 * * 1. 修復 /change-number 競爭條件 (Race Condition)
 * * 2. 變更 featuredContents 為 Redis List 結構
 * * 3. 移除 /set-... 路由，改為即時 API (add/remove)
 * * 4. 移除 io.use() 全域驗證，允許前台 (public) 連線
 * * 5. 移除 MAX_PASSED_NUMBERS (5筆) 的資料讀取與寫入限制
 * *
 * * 【2025-11-07 優化】
 * * 6. 【A. 修改】 將 KEY_PASSED_NUMBERS 從 LIST 改為 ZSET (Sorted Set)
 * * 以實現自動由小到大排序
 * *
 * * 【2025-11-08 改善 - 來自 Gemini】
 * * 1. 【1.B】 使用 Lua 腳本修復 /change-number 'prev' 的競爭條件
 * * 2. 【2.A】 增加 /api/passed/clear 和 /api/featured/clear API
 * * 3. 【3.A】 調整 Socket.io 連線日誌與 disconnect 監聽器位置
 * * 4. 【優化 1】 使用 Redis Pipelining (multi) 優化新連線的資料讀取
 * * 5. 【新功能】 增加 KEY_IS_PUBLIC 鍵，實現「維護模式」
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const Redis = require("ioredis");

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

// --- 【1.B 改善】定義一個原子操作的 Lua 腳本 ---
// 'decrIfPositive' (如果大於 0 才減 1)
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
const KEY_IS_PUBLIC = 'callsys:isPublic'; // 【新功能】 增加維護模式的 Key

// --- 7. Express 中介軟體 (Middleware) ---
app.use(express.static("public"));
app.use(express.json());

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

// --- 8.5 輔助廣播函式 (用於即時更新) ---
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

// --- 9. API 路由 (Routes) ---
app.post("/check-token", authMiddleware, (req, res) => { res.json({ success: true }); });

app.post("/change-number", authMiddleware, async (req, res) => {
    try {
        const { direction } = req.body;
        let num;
        if (direction === "next") {
            num = await redis.incr(KEY_CURRENT_NUMBER);
        }
        else if (direction === "prev") {
            num = await redis.decrIfPositive(KEY_CURRENT_NUMBER);
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

app.post("/set-number", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        const num = Number(number);
        if (isNaN(num) || num < 0 || !Number.isInteger(num)) {
            return res.status(400).json({ error: "請提供一個有效的非負整數。" });
        }
        await redis.set(KEY_CURRENT_NUMBER, num);
        io.emit("update", num);
        await updateTimestamp();
        res.json({ success: true, number: num });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 過號列表 (Passed Numbers) 即時 API ---
app.post("/api/passed/add", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        const num = Number(number);
        if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
            return res.status(400).json({ error: "請提供有效的正整數。" });
        }
        await redis.zadd(KEY_PASSED_NUMBERS, num, num);
        await broadcastPassedNumbers();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/remove", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        await redis.zrem(KEY_PASSED_NUMBERS, number);
        await broadcastPassedNumbers();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- 精選連結 (Featured Contents) 即時 API ---
app.post("/api/featured/add", authMiddleware, async (req, res) => {
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
        await broadcastFeaturedContents();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/remove", authMiddleware, async (req, res) => {
    try {
        const { linkText, linkUrl } = req.body;
        if (!linkText || !linkUrl) {
            return res.status(400).json({ error: "缺少必要參數。" });
        }
        const item = { linkText, linkUrl };
        await redis.lrem(KEY_FEATURED_CONTENTS, 1, JSON.stringify(item));
        await broadcastFeaturedContents();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- 【2.A 功能補強】 單獨清空 API ---
app.post("/api/passed/clear", authMiddleware, async (req, res) => {
    try {
        await redis.del(KEY_PASSED_NUMBERS);
        io.emit("updatePassed", []);
        await updateTimestamp();
        res.json({ success: true, message: "過號列表已清空" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/clear", authMiddleware, async (req, res) => {
    try {
        await redis.del(KEY_FEATURED_CONTENTS);
        io.emit("updateFeaturedContents", []);
        await updateTimestamp();
        res.json({ success: true, message: "精選連結已清空" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---


app.post("/set-sound-enabled", authMiddleware, async (req, res) => {
    try {
        const { enabled } = req.body;
        const valueToSet = enabled ? "1" : "0";
        await redis.set(KEY_SOUND_ENABLED, valueToSet);
        io.emit("updateSoundSetting", enabled);
        await updateTimestamp();
        res.json({ success: true, isEnabled: enabled });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 【新功能】 增加設定維護模式的 API ---
app.post("/set-public-status", authMiddleware, async (req, res) => {
    try {
        const { isPublic } = req.body;
        const valueToSet = isPublic ? "1" : "0";
        await redis.set(KEY_IS_PUBLIC, valueToSet);
        
        // 廣播給所有人 (包含前台)
        io.emit("updatePublicStatus", isPublic); 
        await updateTimestamp();
        res.json({ success: true, isPublic: isPublic });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});


app.post("/reset", authMiddleware, async (req, res) => {
    try {
        const multi = redis.multi();
        multi.set(KEY_CURRENT_NUMBER, 0);
        multi.del(KEY_PASSED_NUMBERS);
        multi.del(KEY_FEATURED_CONTENTS);
        multi.set(KEY_SOUND_ENABLED, "1");
        multi.set(KEY_IS_PUBLIC, "1"); // 【新功能】 重置時預設為公開
        await multi.exec();

        io.emit("update", 0);
        io.emit("updatePassed", []);
        io.emit("updateFeaturedContents", []);
        io.emit("updateSoundSetting", true);
        io.emit("updatePublicStatus", true); // 【新功能】 廣播重置後的狀態

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
    } else {
        console.log("🔌 一個 Public User 連線", socket.id);
    }

    try {
        // --- 【優化 1】 使用 Pipelining (multi) ---
        const pipeline = redis.multi();
        pipeline.get(KEY_CURRENT_NUMBER);
        pipeline.zrange(KEY_PASSED_NUMBERS, 0, -1);
        pipeline.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        pipeline.get(KEY_LAST_UPDATED);
        pipeline.get(KEY_SOUND_ENABLED);
        pipeline.get(KEY_IS_PUBLIC); // 【新功能】 讀取公開狀態
        
        const results = await pipeline.exec();

        if (results.some(res => res[0] !== null)) {
            const firstError = results.find(res => res[0] !== null)[0];
            throw new Error(`Redis multi 執行失敗: ${firstError.message}`);
        }

        const currentNumberRaw = results[0][1];
        const passedNumbersRaw = results[1][1] || [];
        const featuredContentsJSONs = results[2][1] || [];
        const lastUpdatedRaw = results[3][1];
        const soundEnabledRaw = results[4][1];
        const isPublicRaw = results[5][1]; // 【新功能】

        const currentNumber = Number(currentNumberRaw || 0);
        const passedNumbers = passedNumbersRaw.map(Number);
        const featuredContents = featuredContentsJSONs.map(JSON.parse);
        const lastUpdated = lastUpdatedRaw || new Date().toISOString();
        const isSoundEnabled = soundEnabledRaw === null ? "1" : soundEnabledRaw;
        const isPublic = isPublicRaw === null ? "1" : isPublicRaw; // 【新功能】 預設為 "1" (公開)

        socket.emit("update", currentNumber);
        socket.emit("updatePassed", passedNumbers);
        socket.emit("updateFeaturedContents", featuredContents);
        socket.emit("updateTimestamp", lastUpdated);
        socket.emit("updateSoundSetting", isSoundEnabled === "1");
        socket.emit("updatePublicStatus", isPublic === "1"); // 【新功能】 傳送狀態

    }
    catch (e) {
        console.error("Socket 連線處理失敗:", e);
        socket.emit("initialStateError", "無法載入初始資料，請稍後重新整理。");
    }
});

// --- 11. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
