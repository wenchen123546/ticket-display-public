/*
 * ==========================================
 * 伺服器 (index.js)
 * * (無 db.json，純記憶體版本)
 * * (已移除「自動加入過號」功能)
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// --- 2. 核心設定 & 安全性 ---
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
    console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
    console.log("👉 請使用 'ADMIN_TOKEN=your_secret_password node index.js' 啟動");
    process.exit(1);
}
console.log("ℹ️ 系統正在以「純記憶體」模式運行。伺服器重啟將會重置所有資料。");

// --- 4. 伺服器全域狀態 (Global State) ---
let currentNumber = 0;
let passedNumbers = [];
let featuredContents = []; 
const MAX_PASSED_NUMBERS = 5; // 限制手動儲存的數量

// --- 5. Express 中介軟體 (Middleware) ---
app.use(express.static("public"));
app.use(express.json());

const authMiddleware = (req, res, next) => {
    const { token } = req.body;
    if (token !== ADMIN_TOKEN) {
        return res.status(403).json({ error: "密碼錯誤" });
    }
    next();
};

// --- 6. 輔助函式 ---
// [REMOVED] addNumberToPassed 函式已被移除

// --- 7. API 路由 (Routes) ---

app.post("/check-token", authMiddleware, (req, res) => { res.json({ success: true }); });

app.post("/change-number", authMiddleware, (req, res) => {
    const { direction } = req.body;
    if (direction === "next") { 
        // addNumberToPassed(currentNumber); // [REMOVED]
        currentNumber++; 
    } 
    else if (direction === "prev" && currentNumber > 0) { 
        currentNumber--; 
    }
    io.emit("update", currentNumber); 
    res.json({ success: true, number: currentNumber });
});

app.post("/set-number", authMiddleware, (req, res) => {
    const { number } = req.body;
    // if (Number(number) !== 0) { // [REMOVED]
    //     addNumberToPassed(currentNumber); 
    // }
    currentNumber = Number(number);
    io.emit("update", currentNumber); 
    res.json({ success: true, number: currentNumber });
});

app.post("/set-passed-numbers", authMiddleware, (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) { return res.status(400).json({ error: "Input must be an array." }); }
    
    const sanitizedNumbers = numbers
        .map(n => Number(n))
        .filter(n => !isNaN(n) && n > 0 && Number.isInteger(n));
    
    // 【保留】 仍然限制手動儲存的數量，防止記憶體濫用
    passedNumbers = sanitizedNumbers.slice(0, MAX_PASSED_NUMBERS);
    
    io.emit("updatePassed", passedNumbers); 
    res.json({ success: true, numbers: passedNumbers });
});


app.post("/set-featured-contents", authMiddleware, (req, res) => {
    const { contents } = req.body; 
    if (!Array.isArray(contents)) {
        return res.status(400).json({ error: "Input must be an array." });
    }
    const sanitizedContents = contents
        .filter(item => item && typeof item === 'object') 
        .map(item => ({ 
            linkText: item.linkText || '', 
            linkUrl: item.linkUrl || ''
        }));
    featuredContents = sanitizedContents;
    io.emit("updateFeaturedContents", featuredContents); 
    res.json({ success: true, contents: featuredContents });
});


app.post("/reset", authMiddleware, (req, res) => {
    currentNumber = 0;
    passedNumbers = [];
    featuredContents = [];
    
    io.emit("update", currentNumber);
    io.emit("updatePassed", passedNumbers);
    io.emit("updateFeaturedContents", featuredContents);
    
    res.json({ success: true, message: "已重置所有內容" });
});

// --- 8. Socket.io 連線處理 ---
io.on("connection", (socket) => {
    socket.emit("update", currentNumber);
    socket.emit("updatePassed", passedNumbers);
    socket.emit("updateFeaturedContents", featuredContents);
});

// --- 9. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
