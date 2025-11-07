/*
 * ==========================================
 * 伺服器 (index.js)
 * * (使用 Upstash Redis 資料庫)
 * * (已加入「音效開關」功能)
 * * (已加入 API 驗證、Redis 事務、Socket 錯誤處理)
 * * * 【2025-11-07 重構】
 * * 1. 修復 /change-number 競爭條件 (Race Condition)
 * * 2. 變更 featuredContents 為 Redis List 結構
 * * 3. 移除 /set-... 路由，改為即時 API (add/remove)
 * * 4. 移除 io.use() 全域驗證，允許前台 (public) 連線
 * * * 【2025-11-07 修正】
 * * 5. 修正 lrange 讀取過號列表時未遵守 MAX_PASSED_NUMBERS 限制
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
const KEY_FEATURED_CONTENTS = 'callsys:featured'; // 結構: List (元素為 JSON String)
const KEY_LAST_UPDATED = 'callsys:updated';
const KEY_SOUND_ENABLED = 'callsys:soundEnabled';

const MAX_PASSED_NUMBERS = 5; // <-- 這裡是限制

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

/**
 * 獲取並廣播最新的「過號列表」給所有客戶端
 */
async function broadcastPassedNumbers() {
    try {
        // 【A. 修正】 從 0, -1 改為 0, MAX_PASSED_NUMBERS - 1
        const numbersRaw = await redis.lrange(KEY_PASSED_NUMBERS, 0, MAX_PASSED_NUMBERS - 1);
        const numbers = numbersRaw.map(Number); // 確保是數字
        io.emit("updatePassed", numbers);
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
        const contentsJSONs = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1); // 精選連結我們假設沒有5筆限制
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
            const current = await redis.get(KEY_CURRENT_NUMBER);
            if (Number(current) > 0) {
                num = await redis.decr(KEY_CURRENT_NUMBER);
            } else {
                num = 0;
            }
        } else {
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

        const members = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1); // 這裡檢查長度時需要讀取全部
        if (members.includes(String(num))) {
            return res.status(400).json({ error: "此號碼已在列表中。" });
        }

        if (members.length >= MAX_PASSED_NUMBERS) {
            return res.status(400).json({ error: `列表已滿 (最多 ${MAX_PASSED_NUMBERS} 筆)，請先移除。` });
        }

        await redis.rpush(KEY_PASSED_NUMBERS, num);
        await broadcastPassedNumbers(); // 廣播更新 (此函式已被修正為只廣播 5 筆)
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/remove", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        await redis.lrem(KEY_PASSED_NUMBERS, 1, number);
        await broadcastPassedNumbers(); // 廣播更新
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
        await broadcastFeaturedContents(); // 廣播更新
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
        await broadcastFeaturedContents(); // 廣播更新
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


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
        multi.del(KEY_FEATURED_CONTENTS); 
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

// --- 10. Socket.io 連線處理 ---

io.on("connection", async (socket) => {
    
    const token = socket.handshake.auth.token;
    const isAdmin = (token === ADMIN_TOKEN && token !== undefined);

    if (isAdmin) {
        console.log("✅ 一個已驗證的 Admin 連線", socket.id);
    } else {
        console.log("🔌 一個 Public User 連線", socket.id);
    }

    try {
        const currentNumber = Number(await redis.get(KEY_CURRENT_NUMBER) || 0);
        
        // 【A. 修正】 從 0, -1 改為 0, MAX_PASSED_NUMBERS - 1
        const passedNumbersRaw = await redis.lrange(KEY_PASSED_NUMBERS, 0, MAX_PASSED_NUMBERS - 1);
        const passedNumbers = passedNumbersRaw.map(Number);
        
        const featuredContentsJSONs = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        const featuredContents = featuredContentsJSONs.map(JSON.parse);

        const lastUpdated = await redis.get(KEY_LAST_UPDATED) || new Date().toISOString();
        const soundEnabledRaw = await redis.get(KEY_SOUND_ENABLED);
        const isSoundEnabled = soundEnabledRaw === null ? "1" : soundEnabledRaw;

        socket.emit("update", currentNumber);
        socket.emit("updatePassed", passedNumbers);
        socket.emit("updateFeaturedContents", featuredContents);
        socket.emit("updateTimestamp", lastUpdated);
        socket.emit("updateSoundSetting", isSoundEnabled === "1");

    }
    catch (e) {
        console.error("Socket 連線處理失敗:", e);
        socket.emit("initialStateError", "無法載入初始資料，請稍後重新整理。");
    }
    
    if (isAdmin) {
        socket.on("disconnect", (reason) => {
            console.log(`🔌 Admin ${socket.id} 斷線: ${reason}`);
        });
    }
});

// --- 11. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
