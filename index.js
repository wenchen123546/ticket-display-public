/*
 * ==========================================
 * 伺服器 (index.js)
 * * (無 db.json，純記憶體版本)
 * 警告：伺服器重啟後所有資料將會重置。
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
// (移除了 fs 和 path)

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// --- 2. 核心設定 & 安全性 ---
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// 關鍵安全性檢查：
if (!ADMIN_TOKEN) {
    console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
    console.log("👉 請使用 'ADMIN_TOKEN=your_secret_password node index.js' 啟動");
    process.exit(1);
}

// --- 3. 狀態持久化 (Persistence) ---
// (移除了 saveState, loadState, DB_PATH, mountPath 相關邏輯)
console.log("ℹ️ 系統正在以「純記憶體」模式運行。伺服器重啟將會重置所有資料。");

// --- 4. 伺服器全域狀態 (Global State) ---
let currentNumber = 0;
let leftText = "";
let rightText = "";
let passedNumbers = [];
let linksList = [];
let featuredContent = { imageUrl: '', linkText: '', linkUrl: '' };
const MAX_PASSED_NUMBERS = 5;

// (移除了 loadState() 呼叫)

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
// (所有 API 路由都移除了 'saveState()' 呼叫)

app.post("/check-token", authMiddleware, (req, res) => {
    res.json({ success: true });
});

app.post("/change-number", authMiddleware, (req, res) => {
    const { direction } = req.body;
    if (direction === "next") { addNumberToPassed(currentNumber); currentNumber++; } 
    else if (direction === "prev" && currentNumber > 0) { currentNumber--; }
    io.emit("update", currentNumber);
    // saveState(); // 移除
    res.json({ success: true, number: currentNumber });
});

app.post("/set-number", authMiddleware, (req, res) => {
    const { number } = req.body;
    addNumberToPassed(currentNumber); currentNumber = Number(number);
    io.emit("update", currentNumber);
    // saveState(); // 移除
    res.json({ success: true, number: currentNumber });
});

app.post("/set-left-text", authMiddleware, (req, res) => {
    const { text } = req.body; leftText = text;
    io.emit("updateLeftText", leftText);
    // saveState(); // 移除
    res.json({ success: true, text: leftText });
});

app.post("/set-right-text", authMiddleware, (req, res) => {
    const { text } = req.body; rightText = text;
    io.emit("updateRightText", rightText);
    // saveState(); // 移除
    res.json({ success: true, text: rightText });
});

app.post("/set-passed-numbers", authMiddleware, (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) { return res.status(400).json({ error: "Input must be an array." }); }
    const sanitizedNumbers = numbers.map(n => Number(n)).filter(n => !isNaN(n) && n > 0 && Number.isInteger(n));
    passedNumbers = sanitizedNumbers;
    io.emit("updatePassed", passedNumbers);
    // saveState(); // 移除
    res.json({ success: true, numbers: passedNumbers });
});

app.post("/set-links", authMiddleware, (req, res) => {
    const { links } = req.body;
    if (!Array.isArray(links)) { return res.status(400).json({ error: "Input must be an array." }); }
    const sanitizedLinks = links.filter(l => l && typeof l.title === 'string' && typeof l.url === 'string');
    linksList = sanitizedLinks;
    io.emit("updateLinks", linksList);
    // saveState(); // 移除
    res.json({ success: true, links: linksList });
});

app.post("/set-featured-content", authMiddleware, (req, res) => {
    const { imageUrl, linkText, linkUrl } = req.body;
    featuredContent = { imageUrl: imageUrl || '', linkText: linkText || '', linkUrl: linkUrl || '' };
    io.emit("updateFeatured", featuredContent);
    // saveState(); // 移除
    res.json({ success: true, content: featuredContent });
});

app.post("/reset", authMiddleware, (req, res) => {
    currentNumber = 0;
    leftText = "";
    rightText = "";
    passedNumbers = [];
    linksList = [];
    featuredContent = { imageUrl: '', linkText: '', linkUrl: '' };
    
    io.emit("update", currentNumber);
    io.emit("updateLeftText", leftText);
    io.emit("updateRightText", rightText);
    io.emit("updatePassed", passedNumbers);
    io.emit("updateLinks", linksList);
    io.emit("updateFeatured", featuredContent);
    
    // saveState(); // 移除
    res.json({ success: true, message: "已重置所有內容" });
});

// --- 8. Socket.io 連線處理 ---
io.on("connection", (socket) => {
    socket.emit("update", currentNumber);
    socket.emit("updateLeftText", leftText);
    socket.emit("updateRightText", rightText);
    socket.emit("updatePassed", passedNumbers);
    socket.emit("updateLinks", linksList);
    socket.emit("updateFeatured", featuredContent);
});

// --- 9. 啟動伺服器 ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
