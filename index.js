/*
 * ==========================================
 * 伺服器 (index.js)
 * * (使用 Upstash Redis 資料庫)
 * * (已加入「音效開關」功能)
 * * (已加入 API 驗證、Redis 事務、Socket 錯誤處理)
 * * * 【2025-11-07 重構】
 * * 1. 修復 /change-number 競爭條件 (Race Condition)
 * * 2. 增加 Socket.io 身份驗證 (io.use)
 * * 3. 變更 featuredContents 為 Redis List 結構
 * * 4. 移除 /set-... 路由，改為即時 API (add/remove)
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

// --- 6. Redis Keys & 全域狀態 ---
const KEY_CURRENT_NUMBER = 'callsys:number';
const KEY_PASSED_NUMBERS = 'callsys:passed';      // 結構: List
const KEY_FEATURED_CONTENTS = 'callsys:featured'; // 【C. 修改】 結構: List (元素為 JSON String)
const KEY_LAST_UPDATED = 'callsys:updated';
const KEY_SOUND_ENABLED = 'callsys:soundEnabled';

const MAX_PASSED_NUMBERS = 5;

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

// --- 8.5 【D. 新增】 輔助廣播函式 (用於即時更新) ---

/**
 * 獲取並廣播最新的「過號列表」給所有客戶端
 */
async function broadcastPassedNumbers() {
    try {
        const numbers = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        io.emit("updatePassed", numbers.map(Number)); // 確保是數字
        await updateTimestamp();
    } catch (e) {
        console.error("broadcastPassedNumbers 失敗:", e);
    }
}

/**
 * 獲取並廣播最新的「精選連結」給所有客戶端
 */
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

// --- 【A. 修改】 修復 Race Condition ---
app.post("/change-number", authMiddleware, async (req, res) => {
    try {
        const { direction } = req.body;
        let num;

        if (direction === "next") {
            // 【A. 修改】 使用 INCR 原子操作
            num = await redis.incr(KEY_CURRENT_NUMBER);
        }
        else if (direction === "prev") {
            // 【A. 修改】 使用 DECR (搭配檢查)
            const current = await redis.get(KEY_CURRENT_NUMBER);
            if (Number(current) > 0) {
                num = await redis.decr(KEY_CURRENT_NUMBER);
            } else {
                num = 0; // 保持在 0
            }
        } else {
            // 備用：僅獲取當前號碼
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

// --- 【D. 新增】 過號列表 (Passed Numbers) 即時 API ---

app.post("/api/passed/add", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        const num = Number(number);
        if (isNaN(num) || num <= 0 || !Number.isInteger(num)) {
            return res.status(400).json({ error: "請提供有效的正整數。" });
        }

        // 檢查是否已存在
        const members = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        if (members.includes(String(num))) {
            return res.status(400).json({ error: "此號碼已在列表中。" });
        }

        // 檢查長度
        if (members.length >= MAX_PASSED_NUMBERS) {
            return res.status(400).json({ error: `列表已滿 (最多 ${MAX_PASSED_NUMBERS} 筆)，請先移除。` });
        }

        await redis.rpush(KEY_PASSED_NUMBERS, num);
        await broadcastPassedNumbers(); // 廣播更新
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/remove", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        // LREM 1 $number (從列表中移除 1 個符合 $number 的元素)
        await redis.lrem(KEY_PASSED_NUMBERS, 1, number);
        await broadcastPassedNumbers(); // 廣播更新
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- 【C. & D. 新增】 精選連結 (Featured Contents) 即時 API ---

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
        // 【C. 修改】 存入 List，值為 JSON 字串
        await redis.rpush(KEY_FEATURED_CONTENTS, JSON.stringify(item));

        await broadcastFeaturedContents(); // 廣播更新
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/remove", authMiddleware, async (req, res) => {
    try {
        const { linkText, linkUrl } = req.body; // 移除是基於內容
        if (!linkText || !linkUrl) {
             return res.status(400).json({ error: "缺少必要參數。" });
        }
        const item = { linkText, linkUrl };

        // 【C. 修改】 從 List 中移除 1 個符合的 JSON 字串
        await redis.lrem(KEY_FEATURED_CONTENTS, 1, JSON.stringify(item));

        await broadcastFeaturedContents(); // 廣播更新
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- 【C. & D. 刪除】 舊的 /set-passed-numbers 和 /set-featured-contents 路由 ---
// (已刪除)


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


app.post("/reset", authMiddleware, async (req, res) => {
    try {
        const multi = redis.multi();
        multi.set(KEY_CURRENT_NUMBER, 0);
        multi.del(KEY_PASSED_NUMBERS);
        multi.del(KEY_FEATURED_CONTENTS); // <-- 這依然有效，會刪除 List key
        multi.set(KEY_SOUND_ENABLED, "1");
        await multi.exec();

        io.emit("update", 0);
        io.emit("updatePassed", []);
        io.emit("updateFeaturedContents", []);
        io.emit("updateSoundSetting", true);

        await updateTimestamp();

        res.json({ success: true, message: "已重置所有內容" });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 10. Socket.io 連線處理 (【B. 已修改】) ---

// 【B. 新增】 Socket.io 驗證中介軟體
io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (token === ADMIN_TOKEN) {
        return next(); // 驗證通過
    }
    console.warn("❌ Socket 驗證失敗 (來自 " + (socket.handshake.address || "未知") + ")");
    return next(new Error("Authentication failed")); // 驗證失敗
});


io.on("connection", async (socket) => {
    // 只有通過 io.use 驗證的 admin 才會觸發 'connection'
    console.log("✅ 一個已驗證的 Admin 連線", socket.id);

    try {
        const currentNumber = Number(await redis.get(KEY_CURRENT_NUMBER) || 0);
        const passedNumbers = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        
        // 【C. 修改】 從 List 讀取
        const featuredContentsJSONs = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        const featuredContents = featuredContentsJSONs.map(JSON.parse);

        const lastUpdated = await redis.get(KEY_LAST_UPDATED) || new Date().toISOString();
        const soundEnabledRaw = await redis.get(KEY_SOUND_ENABLED);
        const isSoundEnabled = soundEnabledRaw === null ? "1" : soundEnabledRaw;

        // [發送] 將資料一次性發送給「剛連線的」客戶端
        socket.emit("update", currentNumber);
        socket.emit("updatePassed", passedNumbers.map(Number)); // 確保為數字
        socket.emit("updateFeaturedContents", featuredContents);
        socket.emit("updateTimestamp", lastUpdated);
        socket.emit("updateSoundSetting", isSoundEnabled === "1");

    }
    catch (e) {
        console.error("Socket 連線處理失敗:", e);
        socket.emit("initialStateError", "無法載入初始資料，請稍後重新整理。");
    }
    
    // 監聽斷線 (可選)
    socket.on("disconnect", (reason) => {
        console.log(`🔌 Admin ${socket.id} 斷線: ${reason}`);
    });
});

// --- 11. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
