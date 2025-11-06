/*
 * ==========================================
 * 伺服器 (index.js)
 * * 核心：Node.js + Express + Socket.io
 * 模式：純記憶體 (無 db.json)
 * * 職責：
 * 1. 處理來自後台 (admin.html) 的 API 請求。
 * 2. 透過 Socket.io 即時廣播狀態變更給前台 (index.html)。
 * 3. 在伺服器記憶體中維護所有狀態 (號碼、列表等)。
 * * 警告：
 * 由於是純記憶體模式，伺服器重啟 (如 Render 平台休眠或更新) 
 * 將會導致所有資料重置為預設值。
 * ==========================================
 */

// --- 1. 模組載入 ---
const express = require("express");
const http = require("http");
const socketio = require("socket.io");

// --- 2. 伺服器實體化 ---
// 建立 Express 應用程式
const app = express();
// 建立標準 HTTP 伺服器，並傳入 Express app 作為處理器
const server = http.createServer(app);
// 將 Socket.io 附加到 HTTP 伺服器上，以便共享同一個埠號
const io = socketio(server);

// --- 3. 核心設定 & 安全性 ---
// 埠號 (Port) 優先使用 Render 等平台提供的環境變數，否則使用 3000
const PORT = process.env.PORT || 3000;
// 管理員密碼 (Token)，必須從環境變數設定
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

// 
// ⚠️ 關鍵安全性檢查：
// 如果啟動時沒有設定 ADMIN_TOKEN，伺服器將拒絕啟動。
// 這是導致 Render 部署 "Timed Out" 的常見原因之一。
//
if (!ADMIN_TOKEN) {
    console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
    console.log("👉 請使用 'ADMIN_TOKEN=your_secret_password node index.js' 啟動");
    process.exit(1); // 異常退出
}

console.log("ℹ️ 系統正在以「純記憶體」模式運行。伺服器重啟將會重置所有資料。");

// --- 4. 伺服器全域狀態 (Global State) ---
// 這些變數儲存在 RAM 中，伺服器重啟時會遺失。
let currentNumber = 0;      // 目前號碼
let passedNumbers = [];     // 已過號列表
let featuredContents = [];  // 精選連結列表 (格式: [{ linkText: '', linkUrl: '' }])

// 過號列表的最大顯示數量
const MAX_PASSED_NUMBERS = 5;

// --- 5. Express 中介軟體 (Middleware) ---
// 1. 靜態檔案服務：
//    允許外部直接存取 'public' 資料夾中的檔案 (如 index.html, admin.html, qrcode.png)
app.use(express.static("public"));
// 2. JSON 解析：
//    讓 Express 能夠讀懂 API 請求 (req.body) 中的 JSON 資料
app.use(express.json());

/**
 * 身份驗證中介軟體 (Gatekeeper)
 * * 這是所有「寫入」API 的守門員。
 * 它會檢查請求 body 中的 token 是否與伺服器設定的 ADMIN_TOKEN 相符。
 */
const authMiddleware = (req, res, next) => {
    const { token } = req.body;
    if (token !== ADMIN_TOKEN) {
        // 驗證失敗，回傳 403 (Forbidden)，後台會觸發登出
        return res.status(403).json({ error: "密碼錯誤" });
    }
    // 驗證通過，放行請求到下一個處理函式 (e.g., app.post)
    next();
};

// --- 6. 輔助函式 ---
/**
 * 將一個號碼加入「過號列表」的開頭。
 * - 會過濾 0 或負數。
 * - 會過濾已存在的號碼 (防止重複)。
 * - 會維持 MAX_PASSED_NUMBERS 的長度限制 (移除最舊的)。
 * - 最後會廣播 'updatePassed' 事件給所有前台。
 */
function addNumberToPassed(num) {
    if (num <= 0) return; 
    if (passedNumbers.includes(num)) return; 

    passedNumbers.unshift(num); // 從最前面加入

    if (passedNumbers.length > MAX_PASSED_NUMBERS) {
        passedNumbers.pop(); // 移除最後一個 (最舊的)
    }
    io.emit("updatePassed", passedNumbers);
}

// --- 7. API 路由 (Routes) ---
// 所有的 API 都會先經過 authMiddleware 驗證

/*
 * POST /check-token
 * 專門用於 admin.html 登入時驗證密碼。
 * 只需要 authMiddleware 通過即可。
 */
app.post("/check-token", authMiddleware, (req, res) => {
    res.json({ success: true });
});

/*
 * POST /change-number
 * 處理「上一號」和「下一號」。
 */
app.post("/change-number", authMiddleware, (req, res) => {
    const { direction } = req.body;
    if (direction === "next") {
        addNumberToPassed(currentNumber); // 將目前號碼存入過號
        currentNumber++;
    } else if (direction === "prev" && currentNumber > 0) {
        currentNumber--;
    }
    io.emit("update", currentNumber); // 廣播新號碼
    res.json({ success: true, number: currentNumber });
});

/*
 * POST /set-number
 * 手動設定為指定號碼 (包含重置歸 0)。
 */
app.post("/set-number", authMiddleware, (req, res) => {
    const { number } = req.body;
    if (Number(number) !== 0) { // 歸 0 時，不把 0 存入過號
        addNumberToPassed(currentNumber);
    }
    currentNumber = Number(number);
    io.emit("update", currentNumber);
    res.json({ success: true, number: currentNumber });
});

/*
 * POST /set-passed-numbers
 * 手動編輯並覆寫整個「過號列表」。
 */
app.post("/set-passed-numbers", authMiddleware, (req, res) => {
    const { numbers } = req.body;
    if (!Array.isArray(numbers)) { 
        return res.status(400).json({ error: "Input must be an array." }); 
    }
    // 過濾無效輸入 (NaN, 負數, 小數)
    const sanitizedNumbers = numbers
        .map(n => Number(n))
        .filter(n => !isNaN(n) && n > 0 && Number.isInteger(n));
    
    passedNumbers = sanitizedNumbers;
    io.emit("updatePassed", passedNumbers);
    res.json({ success: true, numbers: passedNumbers });
});


/*
 * POST /set-featured-contents
 * 設定「精選連結」列表 (僅文字 + 網址)。
 */
app.post("/set-featured-contents", authMiddleware, (req, res) => {
    const { contents } = req.body; 
    
    if (!Array.isArray(contents)) {
        return res.status(400).json({ error: "Input must be an array." });
    }

    // 伺服器端過濾：只儲存物件，並確保欄位存在
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


/*
 * POST /reset
 * 將所有記憶體中的狀態重置為初始值。
 */
app.post("/reset", authMiddleware, (req, res) => {
    currentNumber = 0;
    passedNumbers = [];
    featuredContents = [];
    
    // 廣播所有更新
    io.emit("update", currentNumber);
    io.emit("updatePassed", passedNumbers);
    io.emit("updateFeaturedContents", featuredContents);
    
    res.json({ success: true, message: "已重置所有內容" });
});

// --- 8. Socket.io 連線處理 ---
/*
 * 當有任何一個前台 (index.html) 客戶端「連線成功」時觸發。
 * * 職責：
 * 立即將「目前所有狀態」傳送給「剛剛連線的這位」客戶端。
 * 確保新開啟的頁面能立即顯示正確資料，而非等待下一次更新。
 */
io.on("connection", (socket) => {
    socket.emit("update", currentNumber);
    socket.emit("updatePassed", passedNumbers);
    socket.emit("updateFeaturedContents", featuredContents);
});

// --- 9. 啟動伺服器 ---
/*
 * 啟動 HTTP 伺服器 (Socket.io 會一同啟動)。
 * * 關鍵：
 * 監聽 '0.0.0.0' 而不是 'localhost'。
 * '0.0.0.0' 允許 Render 等部署平台的外部健康檢查系統連線，
 * 只用 'localhost' 會導致 "Timed Out"。
 */
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on host 0.0.0.0, port ${PORT}`);
    console.log(`🎟 User page (local): http://localhost:${PORT}/index.html`);
    console.log(`🛠 Admin page (local): http://localhost:${PORT}/admin.html`);
});
