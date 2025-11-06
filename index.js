const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const PORT = process.env.PORT || 3000;

// --- 安全性優化：移除預設密碼 ---
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!ADMIN_TOKEN) {
  console.error("❌ 錯誤： ADMIN_TOKEN 環境變數未設定！");
  console.log("👉 請使用 'ADMIN_TOKEN=your_secret_password node index.js' 啟動");
  process.exit(1);
}
// ---

let currentNumber = 0;
let currentText = "";
let passedNumbers = []; // <-- 新增：儲存已叫號碼
const MAX_PASSED_NUMBERS = 5; // <-- 新增：只保留最近 5 筆

app.use(express.static("public"));
app.use(express.json());

// --- 新增：一個中介軟體來驗證 token ---
const authMiddleware = (req, res, next) => {
  const { token } = req.body;
  if (token !== ADMIN_TOKEN) {
    return res.status(403).json({ error: "密碼錯誤" });
  }
  next();
};

// --- 新增：一個輔助函式來更新已叫號碼 ---
function addNumberToPassed(num) {
  if (num <= 0) return; // 不儲存 0
  if (passedNumbers.includes(num)) return; // 不儲存重複的

  // 將號碼加到列表最前面
  passedNumbers.unshift(num);

  // 如果列表超過長度，移除最舊的一個
  if (passedNumbers.length > MAX_PASSED_NUMBERS) {
    passedNumbers.pop();
  }
  
  // 向所有人廣播更新
  io.emit("updatePassed", passedNumbers);
}

// 下一號 / 上一號
app.post("/change-number", authMiddleware, (req, res) => {
  const { direction } = req.body;

  if (direction === "next") {
    // 只有按 "下一號" 時，才將目前號碼存入「已叫號碼」
    addNumberToPassed(currentNumber);
    currentNumber++;
  } else if (direction === "prev" && currentNumber > 0) {
    currentNumber--;
    // (我們假設 "上一號" 是修正錯誤，所以不更新 passedNumbers)
  }

  io.emit("update", currentNumber);
  res.json({ success: true, number: currentNumber });
});

// 設定號碼
app.post("/set-number", authMiddleware, (req, res) => {
  const { number } = req.body;

  // 按 "設定號碼" 時，也將舊號碼存入
  addNumberToPassed(currentNumber);
  
  currentNumber = Number(number);
  io.emit("update", currentNumber);
  res.json({ success: true, number: currentNumber });
});

// 設定提示文字
app.post("/set-text", authMiddleware, (req, res) => {
  const { text } = req.body;
  currentText = text;
  io.emit("updateText", currentText);
  res.json({ success: true, text: currentText });
});

// 重置全部
app.post("/reset", authMiddleware, (req, res) => {
  currentNumber = 0;
  currentText = "";
  passedNumbers = []; // <-- 修改：重置時清空已叫號碼
  
  io.emit("update", currentNumber);
  io.emit("updateText", currentText);
  io.emit("updatePassed", passedNumbers); // <-- 修改：廣播空的列表
  res.json({ success: true, message: "已重置所有內容" });
});

// Socket.io 初始化
io.on("connection", (socket) => {
  socket.emit("update", currentNumber);
  socket.emit("updateText", currentText);
  socket.emit("updatePassed", passedNumbers); // <-- 新增：讓新連線者取得列表
});

http.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🎟 User page: http://localhost:${PORT}/index.html`);
  console.log(`🛠 Admin page: http://localhost:${PORT}/admin.html`);
});
