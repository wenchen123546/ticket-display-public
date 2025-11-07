// --- 1. 元素節點 (DOM) ---
const loginContainer = document.getElementById("login-container");
const adminPanel = document.getElementById("admin-panel");
const passwordInput = document.getElementById("password-input");
const loginButton = document.getElementById("login-button");
const loginError = document.getElementById("login-error");
const numberEl = document.getElementById("number");
const statusBar = document.getElementById("status-bar");
const passedListUI = document.getElementById("passed-list-ui");
const newPassedNumberInput = document.getElementById("new-passed-number");
const addPassedBtn = document.getElementById("add-passed-btn");
const featuredListUI = document.getElementById("featured-list-ui");
const newLinkTextInput = document.getElementById("new-link-text");
const newLinkUrlInput = document.getElementById("new-link-url");
const addFeaturedBtn = document.getElementById("add-featured-btn");
const soundToggle = document.getElementById("sound-toggle");
const adminLogUI = document.getElementById("admin-log-ui");
const clearLogBtn = document.getElementById("clear-log-btn"); 

// --- 2. 全域變數 ---
let token = "";

// --- 3. Socket.io ---
const socket = io({ autoConnect: false });

// --- 4. 登入/顯示邏輯 (保持不變) ---
// (建議加入 sessionStorage 邏輯)
function showLogin() { loginContainer.style.display = "block"; adminPanel.style.display = "none"; document.title = "後台管理 - 登入"; socket.disconnect(); }
function showPanel() { loginContainer.style.display = "none"; adminPanel.style.display = "block"; document.title = "後台管理 - 控制台"; socket.connect(); }
async function checkToken(tokenToCheck) { if (!tokenToCheck) return false; try { const res = await fetch("/check-token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: tokenToCheck }), }); return res.ok; } catch (err) { console.error("checkToken 失敗:", err); return false; } }
async function attemptLogin(tokenToCheck) { loginError.textContent = "驗證中..."; const isValid = await checkToken(tokenToCheck); if (isValid) { token = tokenToCheck; showPanel(); } else { loginError.textContent = "密碼錯誤"; showLogin(); } }
document.addEventListener("DOMContentLoaded", () => { showLogin(); });
loginButton.addEventListener("click", () => { attemptLogin(passwordInput.value); });
passwordInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { attemptLogin(passwordInput.value); } });

// --- 5. 日誌輔助函式 (不變) ---
function adminLog(message) { if (!adminLogUI) return; const li = document.createElement("li"); li.textContent = `[${new Date().toLocaleTimeString('zh-TW')}] ${message}`; adminLogUI.prepend(li); }

// --- 6. 控制台 Socket 監聽器 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    statusBar.classList.remove("visible");
    adminLog("✅ 成功連線到伺服器"); 
});
socket.on("disconnect", () => { 
    console.warn("Socket.io 已斷線"); 
    statusBar.classList.add("visible"); 
    adminLog("❌ 連線中斷"); 
});

// 【重要修正】 加入 initialStateError 監聽
socket.on("initialStateError", (errorMsg) => {
    console.error("無法載入初始狀態:", errorMsg);
    alert("後台載入失敗：" + errorMsg); // 彈出錯誤
    adminLog(`❌ 錯誤: ${errorMsg}`);
});

socket.on("update", (num) => {
    numberEl.textContent = num;
    adminLog(`號碼更新為 ${num}`); 
});
socket.on("updatePassed", (numbers) => {
    renderPassedListUI(numbers); 
    adminLog("過號列表已更新");
});
socket.on("updateFeaturedContents", (contents) => {
    renderFeaturedListUI(contents); 
    adminLog("精選連結已更新");
});
socket.on("updateSoundSetting", (isEnabled) => { 
    console.log("收到音效設定:", isEnabled); 
    soundToggle.checked = isEnabled; 
    adminLog(`音效已設為 ${isEnabled ? '開啟' : '關閉'}`); 
});
socket.on("updateTimestamp", (timestamp) => { 
    console.log("Timestamp updated:", timestamp); 
});

// --- 7. API 請求函式 (不變) ---
async function apiRequest(endpoint, body) { try { const res = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, token }), }); if (!res.ok) { const errorData = await res.json(); if (res.status === 403) { alert("密碼驗證失敗或 Token 已過期，請重新登入。"); showLogin(); } else { alert("操作失敗：" + (errorData.error || "未知錯誤")); adminLog(`❌ 操作失敗: ${errorData.error}`); } return false; } return true; } catch (err) { alert("網路連線失敗或伺服器無回應：" + err.message); return false; } }

// --- 8. GUI 渲染函式 (不變) ---
function renderPassedListUI(numbers) {
    passedListUI.innerHTML = "";
    if (numbers.length > 5) { numbers = numbers.slice(0, 5); } 
    numbers.forEach((number) => { 
        const li = document.createElement("li");
        li.innerHTML = `<span>${number}</span>`;
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = () => {
            apiRequest("/remove-passed-number", { number: number });
        };
        li.appendChild(deleteBtn);
        passedListUI.appendChild(li);
    });
}
function renderFeaturedListUI(contents) {
    featuredListUI.innerHTML = "";
    contents.forEach((item, index) => { 
        const li = document.createElement("li");
        li.innerHTML = `<span>${item.linkText}<br><small style="color: #666;">${item.linkUrl}</small></span>`;
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = () => {
            apiRequest("/remove-featured-content", { index: index });
        };
        li.appendChild(deleteBtn);
        featuredListUI.appendChild(li);
    });
}

// --- 9. 控制台按鈕功能 (不變) ---
async function changeNumber(direction) { await apiRequest("/change-number", { direction }); }
async function setNumber() { const num = document.getElementById("manualNumber").value; if (num === "") return; const success = await apiRequest("/set-number", { number: num }); if (success) { document.getElementById("manualNumber").value = ""; } }
async function resetNumber() { if (!confirm("確定要將「目前號碼」重置為 0 嗎？")) return; const success = await apiRequest("/set-number", { number: 0 }); if (success) { document.getElementById("manualNumber").value = ""; alert("號碼已重置為 0。"); } }
async function resetPassed() { if (!confirm("確定要清空「已叫號碼(過號)」列表嗎？")) return; await apiRequest("/set-passed-numbers", { numbers: [] }); }
async function resetFeaturedContents() { if (!confirm("確定要清空「精選連結」嗎？")) return; await apiRequest("/set-featured-contents", { contents: [] }); }
async function resetAll() { const confirmation = prompt( "⚠️ 警告！這將會重置「所有」資料 (號碼、過號、精選連結)！\n\n" + "若要確認，請在下方輸入 'RESET' (全大寫)：" ); if (confirmation !== "RESET") { alert("操作已取消。"); return; } const success = await apiRequest("/reset", {}); if (success) { document.getElementById("manualNumber").value = ""; alert("已全部重置。"); } }

// --- 清除日誌 (不變) ---
function clearAdminLog() { adminLogUI.innerHTML = ""; adminLog("日誌已清除。"); }

// --- 10. 綁定按鈕事件 (不變) ---
document.getElementById("next").onclick = () => changeNumber("next");
document.getElementById("prev").onclick = () => changeNumber("prev");
document.getElementById("setNumber").onclick = setNumber;
document.getElementById("resetNumber").onclick = resetNumber;
document.getElementById("resetFeaturedContents").onclick = resetFeaturedContents;
document.getElementById("resetPassed").onclick = resetPassed;
document.getElementById("resetAll").onclick = resetAll;
addPassedBtn.onclick = () => { const num = Number(newPassedNumberInput.value); if (num > 0 && Number.isInteger(num)) { apiRequest("/add-passed-number", { number: num }); newPassedNumberInput.value = ""; } else { alert("請輸入有效的正整數。"); } };
addFeaturedBtn.onclick = () => { const text = newLinkTextInput.value.trim(); const url = newLinkUrlInput.value.trim(); if (text && url) { if (!url.startsWith('http://') && !url.startsWith('https://')) { alert("網址請務必以 http:// 或 https:// 開頭。"); return; } apiRequest("/add-featured-content", { linkText: text, linkUrl: url }); newLinkTextInput.value = ""; newLinkUrlInput.value = ""; } else { alert("「連結文字」和「網址」都必須填寫。"); } };
clearLogBtn.onclick = clearAdminLog;

// --- 11. 綁定 Enter 鍵 (不變) ---
newPassedNumberInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { addPassedBtn.click(); } });
newLinkTextInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { newLinkUrlInput.focus(); } });
newLinkUrlInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { addFeaturedBtn.click(); } });

// --- 12. 綁定音效開關 (不變) ---
soundToggle.addEventListener("change", () => { const isEnabled = soundToggle.checked; apiRequest("/set-sound-enabled", { enabled: isEnabled }); });
