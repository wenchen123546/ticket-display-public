/*
 * ==========================================
 * 伺服器 (index.js)
 * ... (舊註解) ...
 * * 11. 【v2 統一】
 * * - 移除 v1 的 authMiddleware
 * * - 將所有 API 路由 (包含 v1 路由) 全部改為使用 jwtAuthMiddleware
 * * - 移除舊的 ADMIN_TOKEN 檢查
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const Redis = require("ioredis");
const helmet = require('helmet'); 
const rateLimit = require('express-rate-limit'); 
const bcrypt = require('bcrypt'); 
const jwt = require('jsonwebtoken'); 

// --- 2. 伺服器實體化 ---
const app = express();
const server = http.createServer(app);
const io = socketio(server);

// --- 3. 核心設定 & 安全性 ---
const PORT = process.env.PORT || 3000;
// const ADMIN_TOKEN = process.env.ADMIN_TOKEN; // 【v2 移除】 不再使用
const REDIS_URL = process.env.UPSTASH_REDIS_URL;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME;
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD;

// --- 4. 關鍵檢查 ---
// 【v2 移除】 ADMIN_TOKEN 檢查
if (!REDIS_URL) {
    console.error("❌ 錯誤： UPSTASH_REDIS_URL 環境變數未設定！");
    process.exit(1);
}
if (!JWT_SECRET || !SUPER_ADMIN_USERNAME || !SUPER_ADMIN_PASSWORD) {
    console.error("❌ 錯誤： 缺少 JWT_SECRET 或超級管理員帳密 (SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD) 環境變數！");
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
const KEY_ADMIN_LAYOUT = 'callsys:admin-layout'; 
const KEY_ADMIN_LOG = 'callsys:admin-log'; 
const KEY_USERS_HASH = 'callsys:users'; 

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

// 【v2 移除】 舊的 authMiddleware
// const authMiddleware = ... (已移除)

// 【v2 統一】 JWT 驗證中介軟體
const jwtAuthMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: "缺少驗證 Token" });
    }
    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload; // 將用戶資料 (例如 { username: '...', role: '...' }) 附加到 req
        next();
    } catch (e) {
        res.status(401).json({ error: "Token 無效或已過期" });
    }
};

// 【v2 統一】 超級管理員檢查中介軟體
const superAdminCheckMiddleware = (req, res, next) => {
    if (req.user && req.user.role === 'superadmin') {
        next();
    } else {
        res.status(403).json({ error: "權限不足，此操作僅限超級管理員。" });
    }
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

async function addAdminLog(message, actor = "系統") { 
    try {
        const timestamp = new Date().toLocaleTimeString('zh-TW', { hour12: false });
        const logMessage = `[${timestamp}] (${actor}) ${message}`; 
        
        await redis.lpush(KEY_ADMIN_LOG, logMessage);
        await redis.ltrim(KEY_ADMIN_LOG, 0, 50);
        io.emit("newAdminLog", logMessage);
        
    } catch (e) {
        console.error("addAdminLog 失敗:", e);
    }
}


// --- 9. API 路由 (Routes) ---

// 【v2 統一】 登入 API - 不需驗證，但有速率限制
app.post("/api/auth/login", loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: "帳號和密碼為必填。" });
        }
        const userJSON = await redis.hget(KEY_USERS_HASH, username.toLowerCase());
        if (!userJSON) {
            return res.status(401).json({ error: "帳號或密碼錯誤。" });
        }
        const user = JSON.parse(userJSON);
        const match = await bcrypt.compare(password, user.passwordHash);
        if (!match) {
            return res.status(401).json({ error: "帳號或密碼錯誤。" });
        }
        const payload = {
            username: user.username,
            role: user.role
        };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '8h' }); 
        res.json({ success: true, token, user: payload });
    } catch (e) {
        console.error("Login API 錯誤:", e);
        res.status(500).json({ error: "伺服器內部錯誤。" });
    }
});

// 【v2 移除】 舊的 /check-token API
// app.post("/check-token", ... (已移除))

// 【v2 統一】 宣告所有「普通管理員」即可存取的 API
const adminAPIs = [
    "/change-number", "/set-number",
    "/api/passed/add", "/api/passed/remove", "/api/passed/clear",
    "/api/featured/add", "/api/featured/remove", "/api/featured/clear",
    "/set-sound-enabled", "/set-public-status", "/reset",
    "/api/layout/load", "/api/layout/save",
    "/api/logs/clear"
];
// 【v2 統一】 套用「通用限制」和「JWT 驗證」
app.use(adminAPIs, apiLimiter, jwtAuthMiddleware);

// 【v2 統一】 宣告所有「超級管理員」才能存取的 API
const superAdminAPIs = [
    "/api/admin/users/list",
    "/api/admin/users/create",
    "/api/admin/users/delete"
];
// 【v2 統一】 套用「通用限制」、「JWT 驗證」和「Super Admin 檢查」
app.use(superAdminAPIs, apiLimiter, jwtAuthMiddleware, superAdminCheckMiddleware);


// --- 10. API 路由實作 ---
// (注意：所有路由都不再需要 authMiddleware 參數)

app.post("/change-number", async (req, res) => {
    try {
        const { direction } = req.body;
        let num;
        if (direction === "next") {
            num = await redis.incr(KEY_CURRENT_NUMBER);
            await addAdminLog(`號碼增加為 ${num}`, req.user.username); // 【v2 修改】 紀錄操作者
        }
        else if (direction === "prev") {
            const oldNum = await redis.get(KEY_CURRENT_NUMBER) || 0;
            num = await redis.decrIfPositive(KEY_CURRENT_NUMBER);
            if (Number(oldNum) > 0) {
                await addAdminLog(`號碼減少為 ${num}`, req.user.username); // 【v2 修改】
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
        await addAdminLog(`號碼手動設定為 ${num}`, req.user.username); // 【v2 修改】
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
        await redis.zremrangebyrank(KEY_PASSED_NUMBERS, 0, -21); 
        await addAdminLog(`過號列表新增 ${num}`, req.user.username); // 【v2 修改】
        await broadcastPassedNumbers();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/remove", async (req, res) => {
    try {
        const { number } = req.body;
        await redis.zrem(KEY_PASSED_NUMBERS, number);
        await addAdminLog(`過號列表移除 ${number}`, req.user.username); // 【v2 修改】
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
        await addAdminLog(`精選連結新增: ${linkText}`, req.user.username); // 【v2 修改】
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
        await addAdminLog(`精選連結移除: ${linkText}`, req.user.username); // 【v2 修改】
        await broadcastFeaturedContents();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/passed/clear", async (req, res) => {
    try {
        await redis.del(KEY_PASSED_NUMBERS);
        await addAdminLog(`過號列表已清空`, req.user.username); // 【v2 修改】
        io.emit("updatePassed", []);
        await updateTimestamp();
        res.json({ success: true, message: "過號列表已清空" });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/featured/clear", async (req, res) => {
    try {
        await redis.del(KEY_FEATURED_CONTENTS);
        await addAdminLog(`精選連結已清空`, req.user.username); // 【v2 修改】
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
        await addAdminLog(`前台音效已設為: ${enabled ? '開啟' : '關閉'}`, req.user.username); // 【v2 修改】
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
        await addAdminLog(`前台已設為: ${isPublic ? '對外開放' : '關閉維護'}`, req.user.username); // 【v2 修改】
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
        multi.del(KEY_ADMIN_LAYOUT); 
        multi.del(KEY_ADMIN_LOG); 
        await multi.exec();

        await addAdminLog(`💥 系統已重置所有資料`, req.user.username); // 【v2 修改】

        io.emit("update", 0);
        io.emit("updatePassed", []);
        io.emit("updateFeaturedContents", []);
        io.emit("updateSoundSetting", true);
        io.emit("updatePublicStatus", true); 
        io.emit("initAdminLogs", []); 

        await updateTimestamp();

        res.json({ success: true, message: "已重置所有內容" });
    }
    catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/layout/load", async (req, res) => {
    try {
        const layoutJSON = await redis.get(KEY_ADMIN_LAYOUT);
        if (layoutJSON) {
            res.json({ success: true, layout: JSON.parse(layoutJSON) });
        } else {
            res.json({ success: true, layout: null });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/layout/save", async (req, res) => {
    try {
        const { layout } = req.body;
        if (!layout || !Array.isArray(layout)) {
            return res.status(400).json({ error: "排版資料格式不正確。" });
        }
        
        const layoutJSON = JSON.stringify(layout);
        await redis.set(KEY_ADMIN_LAYOUT, layoutJSON);
        await addAdminLog(`💾 儀表板排版已儲存`, req.user.username); // 【v2 修改】
        
        res.json({ success: true, message: "排版已儲存。" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/logs/clear", async (req, res) => {
    try {
        await redis.del(KEY_ADMIN_LOG);
        await addAdminLog(`🧼 管理員清空了所有日誌`, req.user.username); // 【v2 修改】
        io.emit("initAdminLogs", []); 
        res.json({ success: true, message: "日誌已清空。" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/admin/users/list", async (req, res) => {
    try {
        const userHash = await redis.hgetall(KEY_USERS_HASH);
        const users = Object.values(userHash).map(u => {
            const user = JSON.parse(u);
            return { username: user.username, role: user.role };
        });
        res.json({ success: true, users });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/admin/users/create", async (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password || !role) {
            return res.status(400).json({ error: "帳號、密碼和角色為必填。" });
        }
        if (role !== 'admin' && role !== 'superadmin') {
            return res.status(400).json({ error: "無效的角色。" });
        }

        const lowerUsername = username.toLowerCase();
        
        if (await redis.hexists(KEY_USERS_HASH, lowerUsername)) {
            return res.status(409).json({ error: "此帳號名稱已存在。" });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        
        const newUser = {
            username: lowerUsername,
            passwordHash, // 儲存雜湊
            role
        };
        
        await redis.hset(KEY_USERS_HASH, lowerUsername, JSON.stringify(newUser));
        await addAdminLog(`建立了新用戶: ${lowerUsername} (${role})`, req.user.username); 
        
        res.status(201).json({ success: true, user: { username: lowerUsername, role } });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/admin/users/delete", async (req, res) => {
    try {
        const { username } = req.body;
        const lowerUsername = username.toLowerCase();

        if (lowerUsername === req.user.username) {
            return res.status(400).json({ error: "無法刪除您自己的帳號。" });
        }
        
        const result = await redis.hdel(KEY_USERS_HASH, lowerUsername);
        if (result === 0) {
            return res.status(404).json({ error: "找不到該用戶。" });
        }

        await addAdminLog(`刪除了用戶: ${lowerUsername}`, req.user.username); 
        res.json({ success: true, message: "用戶已刪除。" });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// --- 11. Socket.io 連線處理 ---
io.on("connection", async (socket) => {
    const token = socket.handshake.auth.token;
    
    // 【v2 統一】 只使用 JWT 驗證
    let payload;
    try {
        payload = jwt.verify(token, JWT_SECRET);
    } catch (e) {
        // JWT 驗證失敗，視為一般 Public User
        console.log("🔌 一個 Public User 連線 (無效 Token)", socket.id);
        
        // ( Public User 仍可接收資料，保持不變 )
        try {
            const pipeline = redis.multi();
            pipeline.get(KEY_CURRENT_NUMBER);
            pipeline.zrange(KEY_PASSED_NUMBERS, 0, -1);
            pipeline.lrange(KEY_FEATURED_CONTENTS, 0, -1);
            pipeline.get(KEY_LAST_UPDATED);
            pipeline.get(KEY_SOUND_ENABLED);
            pipeline.get(KEY_IS_PUBLIC); 
            const results = await pipeline.exec();
            // ... (省略錯誤處理) ...
            const [ [e0,d0],[e1,d1],[e2,d2],[e3,d3],[e4,d4],[e5,d5] ] = results;
            socket.emit("update", Number(d0 || 0));
            socket.emit("updatePassed", (d1 || []).map(Number));
            socket.emit("updateFeaturedContents", (d2 || []).map(JSON.parse));
            socket.emit("updateTimestamp", d3 || new Date().toISOString());
            socket.emit("updateSoundSetting", (d4 === null ? "1" : d4) === "1");
            socket.emit("updatePublicStatus", (d5 === null ? "1" : d5) === "1");
        } catch(e_inner) {
            socket.emit("initialStateError", "無法載入初始資料。");
        }
        return; // 結束此連線 (作為 Public User)
    }

    // --- 以下為 JWT 驗證成功的管理員 ---
    
    console.log(`✅ 一個已驗證的 (JWT) Admin 連線: ${payload.username}`, socket.id);
    socket.on("disconnect", (reason) => {
        console.log(`🔌 (JWT) Admin ${payload.username} 斷線: ${reason}`);
    });

    // Admin 連線時，傳送日誌歷史
    try {
        const logs = await redis.lrange(KEY_ADMIN_LOG, 0, 50);
        socket.emit("initAdminLogs", logs); 
    } catch (e) {
        console.error("讀取日誌歷史失敗:", e);
    }
        
    // ( Public User 的資料廣播，管理員也需要收到 )
    try {
        const pipeline = redis.multi();
        pipeline.get(KEY_CURRENT_NUMBER);
        pipeline.zrange(KEY_PASSED_NUMBERS, 0, -1);
        pipeline.lrange(KEY_FEATURED_CONTENTS, 0, -1);
        pipeline.get(KEY_LAST_UPDATED);
        pipeline.get(KEY_SOUND_ENABLED);
        pipeline.get(KEY_IS_PUBLIC); 
        const results = await pipeline.exec();
        // ... (省略錯誤處理) ...
        const [ [e0,d0],[e1,d1],[e2,d2],[e3,d3],[e4,d4],[e5,d5] ] = results;
        socket.emit("update", Number(d0 || 0));
        socket.emit("updatePassed", (d1 || []).map(Number));
        socket.emit("updateFeaturedContents", (d2 || []).map(JSON.parse));
        socket.emit("updateTimestamp", d3 || new Date().toISOString());
        socket.emit("updateSoundSetting", (d4 === null ? "1" : d4) === "1");
        socket.emit("updatePublicStatus", (d5 === null ? "1" : d5) === "1");
    }
    catch (e) {
        console.error("Socket 連線處理失敗:", e);
        socket.emit("initialStateError", "無法載入初始資料，請稍後重新整理。");
    }
});


// --- 12. 伺服器啟動 & 自動建立 Super Admin ---

async function createSuperAdminOnStartup() {
    try {
        const username = SUPER_ADMIN_USERNAME.toLowerCase();
        const userExists = await redis.hexists(KEY_USERS_HASH, username);

        if (!userExists) {
            console.log(`... 找不到超級管理員 "${username}"，正在自動建立...`);
            const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);
            const superAdmin = {
                username,
                passwordHash,
                role: 'superadmin'
            };
            await redis.hset(KEY_USERS_HASH, username, JSON.stringify(superAdmin));
            console.log(`✅ 超級管理員 "${username}" 已成功建立！`);
        } else {
            console.log(`ℹ️ 超級管理員 "${username}" 已存在，跳過建立。`);
        }
    } catch (e) {
        console.error("❌ 建立超級管理員時發生嚴重錯誤:", e);
        process.exit(1); // 啟動失敗
    }
}

server.listen(PORT, '0.0.0.0', async () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin login (NEW): http://localhost:${PORT}/login.html`); // 【v2 修改】
    
    await createSuperAdminOnStartup();
});
