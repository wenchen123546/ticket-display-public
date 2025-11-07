/*
 *
==========================================
 * 伺服器 (index.js)
 * *
(已加入 Helmet, Rate Limiter)
 *
==========================================
 */

// --- 1. 模組載入 ---
const express =
require("express");
const http = require("http");
const socketio =
require("socket.io");
const Redis = require("ioredis");
const helmet = require("helmet"); // <-- 【建議 2】載入 Helmet
const rateLimit = require('express-rate-limit'); // <-- 【建議 1】載入 Rate Limit

// --- 2. 伺服器實體化 ---
const app = express();
const server = http.createServer(app);
const io = socketio(server);

// --- 3. 核心設定 & 安全性 ---
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN =
process.env.ADMIN_TOKEN;
const REDIS_URL =
process.env.UPSTASH_REDIS_URL;

// --- 4. 關鍵檢查 ---
if (!ADMIN_TOKEN) {
    console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
    process.exit(1);
}
if (!REDIS_URL) {
    console.error("❌ 錯誤： UPSTASH_REDIS_URL環境變數未設定！");
    process.exit(1);
}

// --- 5. 連線到 Upstash Redis ---
const redis = new Redis(REDIS_URL, {
    tls: {
        rejectUnauthorized: false 
     }
});
redis.on('connect', () => {
console.log("✅ 成功連線到 Upstash Redis 資料庫。"); });
redis.on('error', (err) => {
console.error("❌ Redis 連線錯誤:", err);
process.exit(1); });

// --- 6. Redis Keys & 全域狀態 ---
const KEY_CURRENT_NUMBER =
'callsys:number';
const KEY_PASSED_NUMBERS =
'callsys:passed';
const KEY_FEATURED_CONTENTS =
'callsys:featured';
const KEY_LAST_UPDATED = 'callsys:updated';
const KEY_SOUND_ENABLED =
'callsys:soundEnabled'; 

const MAX_PASSED_NUMBERS = 5;

// --- 7. Express 中介軟體 (Middleware) ---
app.use(helmet()); // <-- 【建議 2】使用 Helmet 增加安全標頭
app.use(express.static("public"));
app.use(express.json());

// 【建議 1】 建立 API 限制器
const adminApiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 分鐘
    max: 50, // 每個 IP 在 15 分鐘內最多 50 次請求
    message: { error: '偵測到過多請求，請 15 分鐘後再試' },
    standardHeaders: true, // 回傳 'Retry-After' 標頭
    legacyHeaders: false, // 關閉 'X-RateLimit-*' 標頭
});

const authMiddleware = (req, res, next)
=> {
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

// --- 9. API 路由 (Routes) ---
// 【建議 1】將 'adminApiLimiter' 應用到所有管理路由

app.post("/check-token",
adminApiLimiter, authMiddleware, (req, res) => { res.json({ success: true }); });

app.post("/change-number",
adminApiLimiter, authMiddleware, async (req, res) => {
    try {
        const { direction } = req.body;
        let num = Number(await redis.get(KEY_CURRENT_NUMBER) || 0);

        if (direction === "next") { 
            num++; 
        } 
        else if (direction === "prev" && num > 0) { 
            num--; 
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

app.post("/set-number",
adminApiLimiter, authMiddleware, async (req, res) => {
    try {
        const { number } = req.body;
        const num = Number(number);

        if (isNaN(num) || num < 0 || !Number.isInteger(num)) {
            return res.status(400).json({ error: "請提供一個有效的非負整數。"
});
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

app.post("/set-passed-numbers",
adminApiLimiter, authMiddleware, async (req, res) => {
    try {
        const { numbers } = req.body;
        if (!Array.isArray(numbers)) { return res.status(400).json({ error:
"Input must be an array." }); }
        
        const sanitizedNumbers = numbers
            .map(n => Number(n))
            .filter(n => !isNaN(n) && n > 0 &&
Number.isInteger(n))
            .slice(0, MAX_PASSED_NUMBERS);
            
        await redis.del(KEY_PASSED_NUMBERS);
        if (sanitizedNumbers.length > 0) {
            await redis.rpush(KEY_PASSED_NUMBERS, ...sanitizedNumbers);
        }
        
        io.emit("updatePassed", sanitizedNumbers); 
        await updateTimestamp(); 
        res.json({ success: true, numbers: sanitizedNumbers });
     }
catch (e) {
        res.status(500).json({ error: e.message });
     }
});

app.post("/set-featured-contents",
adminApiLimiter, authMiddleware, async (req, res) => {
    try {
        const { contents } = req.body; 
        if (!Array.isArray(contents)) {
            return res.status(400).json({ error: "Input must be an array."
});
        }
        const sanitizedContents = contents
            .filter(item => item && typeof item === 'object') 
            .map(item => ({ 
                linkText: item.linkText || '', 
                linkUrl: item.linkUrl || ''
            }))
            .filter(item => { 
                if (item.linkUrl === '') return
true;
                return
item.linkUrl.startsWith('http://') || item.linkUrl.startsWith('https://');
            });

        await redis.set(KEY_FEATURED_CONTENTS,
JSON.stringify(sanitizedContents));
        
        io.emit("updateFeaturedContents", sanitizedContents); 
        await updateTimestamp(); 
        res.json({ success: true, contents: sanitizedContents });
     }
catch (e) {
        res.status(500).json({ error: e.message });
     }
});

app.post("/set-sound-enabled",
adminApiLimiter, authMiddleware, async (req, res) => {
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


app.post("/reset",
adminApiLimiter, authMiddleware, async (req, res) => {
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
io.on("connection", async
(socket) => {
    try {
        const currentNumber = Number(await redis.get(KEY_CURRENT_NUMBER) || 0);
        const passedNumbers = await redis.lrange(KEY_PASSED_NUMBERS, 0, -1);
        const featuredContentsJSON = await redis.get(KEY_FEATURED_CONTENTS);
        const featuredContents = featuredContentsJSON ?
JSON.parse(featuredContentsJSON) : [];
        const lastUpdated = await redis.get(KEY_LAST_UPDATED) || new
Date().toISOString(); 
        
        const soundEnabledRaw = await redis.get(KEY_SOUND_ENABLED);
        const isSoundEnabled = soundEnabledRaw === null ? "1" :
soundEnabledRaw;

        socket.emit("update", currentNumber);
        socket.emit("updatePassed", passedNumbers);
        socket.emit("updateFeaturedContents", featuredContents);
        socket.emit("updateTimestamp", lastUpdated); 
        socket.emit("updateSoundSetting", isSoundEnabled ===
"1"); 

     }
catch (e) {
        console.error("Socket 連線處理失敗:", e);
        socket.emit("initialStateError", "無法載入初始資料，請稍後重新整理。");
     }
});

// --- 11. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running
on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User
page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin
page (local): http://localhost:${PORT}/admin.html`);
});
