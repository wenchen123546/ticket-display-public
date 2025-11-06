/*
 * ==========================================
 * 伺服器 (index.js)
 * (無 db.json，純記憶體版本)
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
let leftText = "";
let rightText = "";
let passedNumbers = [];
let linksList = [];
// 【修改】 從單一物件變為陣列
let featuredContents = []; 
const MAX_PASSED_NUMBERS = 5;

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
function addNumberToPassed(num) {
    if (num <= 0) return;
    if (passedNumbers.includes(num)) return;
    passedNumbers.unshift(num);
    if (passedNumbers.length > MAX_PASSED_NUMBERS) {
        passedNumbers.pop();
    }
    io.emit("updatePassed", passedNumbers);
}

// --- 7. API 路由 (Routes) ---

// (check-token, change-number, set-number, set-left-text, set-right-text, set-passed-numbers, set-links 保持不變)
app.post("/check-token", authMiddleware, (req, res) => { res.json({ success: true }); });
app.post("/change-number", authMiddleware, (req, res) => {
    const { direction } = req.body;
    if (direction === "next") { addNumberToPassed(currentNumber); currentNumber++; } 
    else if (direction === "prev" && currentNumber > 0) { currentNumber--; }
    io.emit("update", currentNumber); res.json({ success: true, number: currentNumber });
});
app.post("/set-number", authMiddleware, (req, res) => {
    const { number } = req.body;
    addNumberToPassed(currentNumber); currentNumber = Number(number);
    io.emit("update", currentNumber); res.json({ success: true, number: currentNumber });
});
app.post("/set-left-text", authMiddleware, (req, res) => {
    const { text } = req.body; leftText = text;
    io.emit("updateLeftText", leftText); res.json({ success: true, text: leftText });
});
app.post("/set-right-text", authMiddleware, (req, res) => {
    const { text } = req.body; rightText = text;
    io.emit("updateRightText", rightText); res.json({ success: true, text: rightText });
});
app.post("/set-passed-numbers", authMiddleware, (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) { return res.status(400).json({ error: "Input must be an array." }); }
    const sanitizedNumbers = numbers.map(n => Number(n)).filter(n => !isNaN(n) && n > 0 && Number.isInteger(n));
    passedNumbers = sanitizedNumbers;
    io.emit("updatePassed", passedNumbers); res.json({ success: true, numbers: passedNumbers });
});
app.post("/set-links", authMiddleware, (req, res) => {
    const { links } = req.body;
    if (!Array.isArray(links)) { return res.status(400).json({ error: "Input must be an array." }); }
    const sanitizedLinks = links.filter(l => l && typeof l.title === 'string' && typeof l.url === 'string');
    linksList = sanitizedLinks;
    io.emit("updateLinks", linksList); res.json({ success: true, links: linksList });
});

// 【修改】 API 更新為 /set-featured-contents
app.post("/set-featured-contents", authMiddleware, (req, res) => {
    const { contents } = req.body; // 預期收到一個 'contents' 陣列
    
    if (!Array.isArray(contents)) {
        return res.status(400).json({ error: "Input must be an array." });
    }

    // 驗證陣列中的物件
    const sanitizedContents = contents.filter(item => 
        item && (item.imageUrl || item.linkText) // 至少要有圖片或文字
    ).map(item => ({ // 確保資料乾淨
        imageUrl: item.imageUrl || '',
        linkText: item.linkText || '',
        linkUrl: item.linkUrl || ''
    }));

    featuredContents = sanitizedContents;
    io.emit("updateFeaturedContents", featuredContents); // 【修改】 廣播新事件
    res.json({ success: true, contents: featuredContents });
});


// 【修改】 重置 API
app.post("/reset", authMiddleware, (req, res) => {
    currentNumber = 0;
    leftText = "";
    rightText = "";
    passedNumbers = [];
    linksList = [];
    featuredContents = []; // 【修改】 重置為空陣列
    
    io.emit("update", currentNumber);
    io.emit("updateLeftText", leftText);
    io.emit("updateRightText", rightText);
    io.emit("updatePassed", passedNumbers);
    io.emit("updateLinks", linksList);
    io.emit("updateFeaturedContents", featuredContents); // 【修改】 廣播新事件
    
    res.json({ success: true, message: "已重置所有內容" });
});

// --- 8. Socket.io 連線處理 ---
io.on("connection", (socket) => {
    socket.emit("update", currentNumber);
    socket.emit("updateLeftText", leftText);
    socket.emit("updateRightText", rightText);
    socket.emit("updatePassed", passedNumbers);
    socket.emit("updateLinks", linksList);
    socket.emit("updateFeaturedContents", featuredContents); // 【修改】 廣播新事件
});

// --- 9. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
