const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "1234";

let currentNumber = 0;
let currentText = "";

app.use(express.static("public"));
app.use(express.json());

app.post("/change-number", (req, res) => {
  const { token, direction } = req.body;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: "密碼錯誤" });
  if (direction === "next") currentNumber++;
  else if (direction === "prev" && currentNumber > 0) currentNumber--;
  io.emit("update", currentNumber);
  res.json({ success: true, number: currentNumber });
});

app.post("/set-number", (req, res) => {
  const { token, number } = req.body;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: "密碼錯誤" });
  currentNumber = Number(number);
  io.emit("update", currentNumber);
  res.json({ success: true, number: currentNumber });
});

app.post("/set-text", (req, res) => {
  const { token, text } = req.body;
  if (token !== ADMIN_TOKEN) return res.status(403).json({ error: "密碼錯誤" });
  currentText = text;
  io.emit("updateText", currentText);
  res.json({ success: true, text: currentText });
});

io.on("connection", (socket) => {
  socket.emit("update", currentNumber);
  socket.emit("updateText", currentText);
});

http.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`🎟 User page: http://localhost:${PORT}/index.html`);
  console.log(`🛠 Admin page: http://localhost:${PORT}/admin.html`);
});