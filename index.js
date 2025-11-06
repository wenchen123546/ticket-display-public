/*
 * ==========================================
 * 伺服器 (index.js)
 * * 核心：Node.js + Express + Socket.io
 * 職責：
 * 1. 處理 API 請求 (驗證權杖、更新狀態)
 * 2. 透過 Socket.io 即時廣播狀態變更
 * 3. 透過 db.json 持久化儲存狀態
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = socketio(server);

// --- 2. 核心設定 & 安全性 ---
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
const DB_PATH = path.join(__dirname, "db.json");

if (!ADMIN_TOKEN) {
    console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
    console.log("👉 請使用 'ADMIN_TOKEN=your_secret_password node index.js' 啟動");
    process.exit(1);
}

// --- 3. 狀態持久化 (Persistence) ---

function saveState() {
    try {
        // 【修改】 更新儲存的狀態
        const state = { currentNumber, leftText, rightText, passedNumbers, linksList }; // 新增 linksList
        fs.writeFileSync(DB_PATH, JSON.stringify(state, null, 2));
    } catch (err) {
        console.error("❌ 儲存狀態失敗:", err);
    }
}

function loadState() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = fs.readFileSync(DB_PATH, "utf-8");
            const state = JSON.parse(data);
            
            // 【修改】 回填狀態
            currentNumber = state.currentNumber || 0;
            leftText = state.leftText || "";
            rightText = state.rightText || "";
            passedNumbers = state.passedNumbers || [];
            linksList = state.linksList || []; // 新增
            console.log("✅ 狀態已從 db.json 載入。");
        }
    } catch (err) {
        console.error("❌ 載入狀態失敗:", err);
    }
}

// --- 4. 伺服器全域狀態 (Global State) ---
let currentNumber = 0;
let leftText = "";
let rightText = "";
let passedNumbers = [];
let linksList = []; // 【新增】 連結列表狀態
const MAX_PASSED_NUMBERS = 5;

loadState(); // 啟動時載入狀態

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

// (check-token, change-number, set-number, set-left-text, set-right-text 保持不變)
app.post("/check-token", authMiddleware, (req, res) => {
    res.json({ success: true, message: "Token is valid" });
});
app.post("/change-number", authMiddleware, (req, res) => {
    const { direction } = req.body;
    if (direction === "next") {
        addNumberToPassed(currentNumber);
        currentNumber++;
    } else if (direction === "prev" && currentNumber > 0) {
        currentNumber--;
    }
    io.emit("update", currentNumber);
    saveState();
    res.json({ success: true, number: currentNumber });
});
app.post("/set-number", authMiddleware, (req, res) => {
    const { number } = req.body;
    addNumberToPassed(currentNumber);
    currentNumber = Number(number);
    io.emit("update", currentNumber);
    saveState();
    res.json({ success: true, number: currentNumber });
});
app.post("/set-left-text", authMiddleware, (req, res) => {
    const { text } = req.body;
    leftText = text;
    io.emit("updateLeftText", leftText);
    saveState();
    res.json({ success: true, text: leftText });
});
app.post("/set-right-text", authMiddleware, (req, res) => {
    const { text } = req.body;
    rightText = text;
    io.emit("updateRightText", rightText);
    saveState();
    res.json({ success: true, text: rightText });
});

// (set-passed-numbers 保持不變)
app.post("/set-passed-numbers", authMiddleware, (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) {
        return res.status(400).json({ error: "Input must be an array." });
    }
    const sanitizedNumbers = numbers
        .map(n => Number(n))
        .filter(n => !isNaN(n) && n > 0 && Number.isInteger(n));
    passedNumbers = sanitizedNumbers;
    io.emit("updatePassed", passedNumbers);
    saveState();
    res.json({ success: true, numbers: passedNumbers });
});

// 【新增】 設定「連結列表」 API
app.post("/set-links", authMiddleware, (req, res) => {
    const { links } = req.body;
    
    // 伺服器端驗證，確保 links 是
    // 一個 {title: string, url: string} 的陣列
    if (!Array.isArray(links)) {
        return res.status(400).json({ error: "Input must be an array." });
    }
    
    const sanitizedLinks = links.filter(l => 
        l && typeof l.title === 'string' && typeof l.url === 'string'
    );

    linksList = sanitizedLinks;
    io.emit("updateLinks", linksList); // 廣播新連結列表
    saveState();
    res.json({ success: true, links: linksList });
});


// 【修改】 重置 API
app.post("/reset", authMiddleware, (req, res) => {
    currentNumber = 0;
    leftText = "";
    rightText = "";
    passedNumbers = [];
    linksList = []; // 新增
    
    // 廣播所有更新
    io.emit("update", currentNumber);
    io.emit("updateLeftText", leftText);
    io.emit("updateRightText", rightText);
    io.emit("updatePassed", passedNumbers);
    io.emit("updateLinks", linksList); // 新增
    
    saveState();
    res.json({ success: true, message: "已重置所有內容" });
});

// --- 8. Socket.io 連線處理 ---
io.on("connection", (socket) => {
    // 【修改】 傳送所有狀態
    socket.emit("update", currentNumber);
    socket.emit("updateLeftText", leftText);
    socket.emit("updateRightText", rightText);
    socket.emit("updatePassed", passedNumbers);
    socket.emit("updateLinks", linksList); // 新增
});

// --- 9. 啟動伺服器 ---
server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🎟 User page: http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page: http://localhost:${PORT}/admin.html`);
});
