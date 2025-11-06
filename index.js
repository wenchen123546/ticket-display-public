/*
 * ==========================================
 * 伺服器 (index.js)
 * * (使用 Upstash Redis 資料庫)
 * * (已升級為「原子 API」操作，移除「儲存」按鈕)
 * * (不包含 express-rate-limit)
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const Redis = require("ioredis");
// [REMOVED] const rateLimit = require('express-rate-limit'); 

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
const KEY_PASSED_NUMBERS = 'callsys:passed';
const KEY_FEATURED_CONTENTS = 'callsys:featured';
const KEY_LAST_UPDATED = 'callsys:updated'; 
const KEY_SOUND_ENABLED = 'callsys:soundEnabled';

const MAX_PASSED_NUMBERS = 5;

// --- 7. Express 中介軟體 (Middleware) ---
app.use(express.static("public"));
app.use(express.json());

// [REMOVED] API 速率限制

const authMiddleware = (req, res, next) => {
    const { token } = req.body;
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: "密碼錯誤" });
    }
    next();
};

// --- 8. 輔助函式 ---

/** 更新時間戳並廣播 */
async function updateTimestamp() {
    const now = new Date().toISOString();
    await redis.set(KEY_LAST_UPDATED, now);
    io.emit("updateTimestamp", now);
}

// --- 9. API 路由 (Routes) ---

app.post("/check-token", authMiddleware, (req, res) => {
    res.json({ success: true });
});

app.post("/change-number", authMiddleware, async (req, res) => {
    try {
        const { direction } = req.body;
        let num = Number(await redis.get(KEY_CURRENT_NUMBER) || 0);

        if (direction === "next") { num++; } 
        else if (direction === "prev" && num > 0) { num--; }
        
        await redis.set(KEY_CURRENT_NUMBER, num);
        io.emit("update", num); 
        await updateTimestamp(); 
        res.json({ success: true, number: num });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/set-number", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        await redis.set(KEY_CURRENT_NUMBER, Number(number));
        io.emit("update", Number(number)); 
        await updateTimestamp(); 
        res.json({ success: true, number: Number(number) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// --- 原子化列表 API ---

/** 新增一筆「過號」 */
app.post("/add-passed-number", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        if (!number || number <= 0) return res.status(400).json({ error: "號碼無效" });

        const list = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        if (list.includes(String(number))) return res.status(400).json({ error: "號碼已存在" });
        if (list.length >= MAX_PASSED_NUMBERS) return res.status(400).json({ error: `列表已滿 (最多 ${MAX_PASSED_NUMBERS} 筆)`});

        await redis.lpush(KEY_PASSED_NUMBERS, number);
        
        const newList = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        io.emit("updatePassed", newList.map(Number)); 
        await updateTimestamp(); 
        res.json({ success: true, numbers: newList.map(Number) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** 刪除一筆「過號」 */
app.post("/delete-passed-number", authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        await redis.lrem(KEY_PASSED_NUMBERS, 1, number); 

        const newList = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        io.emit("updatePassed", newList.map(Number));
        await updateTimestamp(); 
        res.json({ success: true, numbers: newList.map(Number) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** 新增一筆「精選連結」 */
app.post("/add-featured-item", authMiddleware, async (req, res) => {
    try {
        const { linkText, linkUrl } = req.body;
        if (!linkText || !linkUrl) return res.status(400).json({ error: "文字和網址皆必須填寫" });
        if (!linkUrl.startsWith('http://') && !linkUrl.startsWith('https://')) {
            return res.status(400).json({ error: "網址必須以 http/https 開頭" });
        }
        
        const item = { linkText, linkUrl };
        await redis.lpush(KEY_FEATURED_CONTENTS, JSON.stringify(item));

        const newListRaw = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        const newList = newListRaw.map(JSON.parse);
        io.emit("updateFeaturedContents", newList);
        await updateTimestamp(); 
        res.json({ success: true, contents: newList });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/** 刪除一筆「精選連結」 */
app.post("/delete-featured-item", authMiddleware, async (req, res) => {
    try {
        const { linkText, linkUrl } = req.body;
        const itemString = JSON.stringify({ linkText, linkUrl });
        
        await redis.lrem(KEY_FEATURED_CONTENTS, 1, itemString);

        const newListRaw = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        const newList = newListRaw.map(JSON.parse);
        io.emit("updateFeaturedContents", newList);
        await updateTimestamp(); 
        res.json({ success: true, contents: newList });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 舊 API (為了解決重置，功能改為輔助重置) ---

app.post("/set-passed-numbers", authMiddleware, async (req, res) => {
    try {
        const { numbers } = req.body;
        if (!Array.isArray(numbers)) { return res.status(400).json({ error: "Input must be an array." }); }
        
        const sanitizedNumbers = numbers
            .map(n => Number(n))
            .filter(n => !isNaN(n) && n > 0 && Number.isInteger(n))
            .slice(0, MAX_PASSED_NUMBERS);
        
        await redis.del(KEY_PASSED_NUMBERS);
        if (sanitizedNumbers.length > 0) {
            await redis.rpush(KEY_PASSED_NUMBERS, ...sanitizedNumbers);
        }
        
        io.emit("updatePassed", sanitizedNumbers); 
        await updateTimestamp(); 
        res.json({ success: true, numbers: sanitizedNumbers });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/set-featured-contents", authMiddleware, async (req, res) => {
    try {
        const { contents } = req.body; 
        if (!Array.isArray(contents)) {
            return res.status(400).json({ error: "Input must be an array." });
        }
        const sanitizedContents = contents
            .filter(item => item && typeof item === 'object') 
            .map(item => ({ 
                linkText: item.linkText || '', 
                linkUrl: item.linkUrl || ''
            }))
            .filter(item => { 
                if (item.linkUrl === '') return true;
                return item.linkUrl.startsWith('http://') || item.linkUrl.startsWith('https://');
            });

        const serializedContents = sanitizedContents.map(item => JSON.stringify(item));

        await redis.del(KEY_FEATURED_CONTENTS);
        if (serializedContents.length > 0) {
            await redis.rpush(KEY_FEATURED_CONTENTS, ...serializedContents);
        }
        
        io.emit("updateFeaturedContents", sanitizedContents); 
        await updateTimestamp(); 
        res.json({ success: true, contents: sanitizedContents });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// --- 音效 & 重置 API ---
app.post("/set-sound-enabled", authMiddleware, async (req, res) => {
    try {
        const { enabled } = req.body; 
        const valueToSet = enabled ? "1" : "0";
        await redis.set(KEY_SOUND_ENABLED, valueToSet);
        io.emit("updateSoundSetting", enabled);
        await updateTimestamp(); 
        res.json({ success: true, isEnabled: enabled });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/reset", authMiddleware, async (req, res) => {
    try {
        await redis.set(KEY_CURRENT_NUMBER, 0);
        await redis.del(KEY_PASSED_NUMBERS);
        await redis.del(KEY_FEATURED_CONTENTS);
        await redis.set(KEY_SOUND_ENABLED, "1");
        
        io.emit("update", 0);
        io.emit("updatePassed", []);
        io.emit("updateFeaturedContents", []);
        io.emit("updateSoundSetting", true);
        
        await updateTimestamp(); 
        
        res.json({ success: true, message: "已重置所有內容" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- 10. Socket.io 連線處理 ---
io.on("connection", async (socket) => {
    try {
        const currentNumber = Number(await redis.get(KEY_CURRENT_NUMBER) || 0);
        const passedNumbersRaw = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        const featuredContentsRaw = await redis.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        const lastUpdated = await redis.get(KEY_LAST_UPDATED) || new Date().toISOString(); 
        const soundEnabledRaw = await redis.get(KEY_SOUND_ENABLED);
        
        const passedNumbers = passedNumbersRaw.map(Number);
        const featuredContents = featuredContentsRaw.map(JSON.parse);
        const isSoundEnabled = soundEnabledRaw === null ? true : (soundEnabledRaw === "1");

        socket.emit("update", currentNumber);
        socket.emit("updatePassed", passedNumbers);
        socket.emit("updateFeaturedContents", featuredContents);
        socket.emit("updateTimestamp", lastUpdated); 
        socket.emit("updateSoundSetting", isSoundEnabled);

    } catch (e) {
        console.error("Socket 連線處理失敗:", e);
    }
});

// --- 11. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
