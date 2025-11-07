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
const publicToggle = document.getElementById("public-toggle"); // 【新功能】
const adminLogUI = document.getElementById("admin-log-ui");
const clearLogBtn = document.getElementById("clear-log-btn");
const resetAllBtn = document.getElementById("resetAll");
const resetAllConfirmBtn = document.getElementById("resetAllConfirm");

// --- 2. 全域變數 ---
let token = "";
let resetAllTimer = null;

// --- 3. Socket.io (【B. 已修改】) ---
const socket = io({ 
    autoConnect: false,
    auth: {
        token: "" 
    }
});

// --- 4. 登入/顯示邏輯 (【B. 已修改】) ---
function showLogin() {
    loginContainer.style.display = "block";
    adminPanel.style.display = "none";
    document.title = "後台管理 - 登入";
    socket.disconnect();
}
function showPanel() {
    loginContainer.style.display = "none";
    adminPanel.style.display = "block";
    document.title = "後台管理 - 控制台";
    socket.connect();
}
async function checkToken(tokenToCheck) {
    if (!tokenToCheck) return false;
    try {
        const res = await fetch("/check-token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: tokenToCheck }),
        });
        return res.ok;
    } catch (err) {
        console.error("checkToken 失敗:", err);
        return false;
    }
}
async function attemptLogin(tokenToCheck) {
    loginError.textContent = "驗證中...";
    const isValid = await checkToken(tokenToCheck);
    if (isValid) {
        token = tokenToCheck;
        socket.auth.token = tokenToCheck;
        showPanel();
    } else {
        loginError.textContent = "密碼錯誤";
        showLogin();
    }
}
document.addEventListener("DOMContentLoaded", () => { showLogin(); });
loginButton.addEventListener("click", () => { attemptLogin(passwordInput.value); });
passwordInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { attemptLogin(passwordInput.value); } });

// --- 5. 日誌輔助函式 ---
function adminLog(message) {
    if (!adminLogUI) return;
    const li = document.createElement("li");
    if (message.includes("❌") || message.includes("失敗")) {
        li.style.color = "var(--color-danger-light)";
    } else if (message.includes("✅") || message.includes("成功")) {
        li.style.color = "var(--color-success)";
    }
    li.textContent = `[${new Date().toLocaleTimeString('zh-TW')}] ${message}`;
    adminLogUI.append(li);
    adminLogUI.scrollTop = adminLogUI.scrollHeight;
}

// --- 6. 控制台 Socket 監聽器 (【D. 已修改】) ---
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
socket.on("connect_error", (err) => {
    console.error("Socket 連線失敗:", err.message);
    adminLog(`❌ Socket 連線失敗: ${err.message}`);
    if (err.message === "Authentication failed") {
        alert("密碼驗證失敗或 Token 已過期，請重新登入。");
        showLogin();
    }
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

// 【新功能】 監聽公開狀態
socket.on("updatePublicStatus", (isPublic) => {
    console.log("收到公開狀態:", isPublic);
    publicToggle.checked = isPublic;
    adminLog(`前台已設為 ${isPublic ? '對外開放' : '關閉維護'}`);
});

socket.on("updateTimestamp", (timestamp) => {
    console.log("Timestamp updated:", timestamp);
});

// --- 7. API 請求函式 ---
async function apiRequest(endpoint, body) {
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, token }),
        });
        if (!res.ok) {
            const errorData = await res.json();
            if (res.status === 403) {
                alert("密碼驗證失敗或 Token 已過期，請重新登入。");
                showLogin();
            } else {
                adminLog(`❌ API 錯誤 (${endpoint}): ${errorData.error || "未知錯誤"}`);
                alert("發生錯誤：" + (errorData.error || "未知錯誤"));
            }
            return false;
        }
        return true;
    } catch (err) {
        adminLog(`❌ 網路連線失敗: ${err.message}`);
        alert("網路連線失敗或伺服器無回應：" + err.message);
        return false;
    }
}

// --- 8. GUI 渲染函式 (【D. 已修改】 + 【優化 2】) ---
function renderPassedListUI(numbers) {
    passedListUI.innerHTML = ""; 
    if (!Array.isArray(numbers)) return;
    const fragment = document.createDocumentFragment();
    numbers.forEach((number) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${number}</span>`;
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = async () => {
            if (confirm(`確定要刪除過號 ${number} 嗎？`)) {
                deleteBtn.disabled = true;
                adminLog(`正在刪除過號 ${number}...`);
                await apiRequest("/api/passed/remove", { number: number });
            }
        };
        li.appendChild(deleteBtn);
        fragment.appendChild(li);
    });
    passedListUI.appendChild(fragment);
}

function renderFeaturedListUI(contents) {
    featuredListUI.innerHTML = "";
    if (!Array.isArray(contents)) return;
    const fragment = document.createDocumentFragment();
    contents.forEach((item) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${item.linkText}<br><small style="color: #666;">${item.linkUrl}</small></span>`;
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = async () => {
            if (confirm(`確定要刪除連結 ${item.linkText} 嗎？`)) {
                deleteBtn.disabled = true;
                adminLog(`正在刪除連結 ${item.linkText}...`);
                await apiRequest("/api/featured/remove", {
                    linkText: item.linkText,
                    linkUrl: item.linkUrl
                });
            }
        };
        li.appendChild(deleteBtn);
        fragment.appendChild(li);
    });
    featuredListUI.appendChild(fragment);
}

// --- 9. 控制台按鈕功能 ---
async function changeNumber(direction) {
    await apiRequest("/change-number", { direction });
}
async function setNumber() {
    const num = document.getElementById("manualNumber").value;
    if (num === "") return;
    const success = await apiRequest("/set-number", { number: num });
    if (success) {
        document.getElementById("manualNumber").value = "";
    }
}

// --- 重置功能 ---
async function resetNumber() {
    if (!confirm("確定要將「目前號碼」重置為 0 嗎？")) return;
    const success = await apiRequest("/set-number", { number: 0 });
    if (success) {
        document.getElementById("manualNumber").value = "";
        alert("號碼已重置為 0。");
    }
}

async function resetPassed_fixed() {
    if (!confirm("確定要清空「已叫號碼(過號)」列表嗎？")) return;
    adminLog("正在清空過號列表...");
    const success = await apiRequest("/api/passed/clear", {});
    if (success) {
        adminLog("✅ 過號列表已清空");
    } else {
        adminLog("❌ 清空過號列表失敗");
    }
}

async function resetFeaturedContents_fixed() {
    if (!confirm("確定要清空「精選連結」嗎？")) return;
    adminLog("正在清空精選連結...");
    const success = await apiRequest("/api/featured/clear", {});
    if (success) {
        adminLog("✅ 精選連結已清空");
    } else {
        adminLog("❌ 清空精選連結失敗");
    }
}

// --- ResetAll 防呆機制 ---
function cancelResetAll() {
    resetAllConfirmBtn.style.display = "none";
    resetAllBtn.style.display = "block";
    if (resetAllTimer) {
        clearTimeout(resetAllTimer);
        resetAllTimer = null;
    }
}
async function confirmResetAll() {
    adminLog("⚠️ 正在執行所有重置...");
    const success = await apiRequest("/reset", {});
    if (success) {
        document.getElementById("manualNumber").value = "";
        alert("已全部重置。");
        adminLog("✅ 所有資料已重置");
    } else {
        adminLog("❌ 重置失敗");
    }
    cancelResetAll();
}
function requestResetAll() {
    adminLog("要求重置所有資料，等待確認...");
    resetAllBtn.style.display = "none";
    resetAllConfirmBtn.style.display = "block";
    resetAllTimer = setTimeout(() => {
        adminLog("重置操作已自動取消 (逾時)");
        cancelResetAll();
    }, 5000);
}
function clearAdminLog() {
    adminLogUI.innerHTML = "";
    adminLog("日誌已清除。");
}

// --- 10. 綁定按鈕事件 ---
document.getElementById("next").onclick = () => changeNumber("next");
document.getElementById("prev").onclick = () => changeNumber("prev");
document.getElementById("setNumber").onclick = setNumber;

document.getElementById("resetNumber").onclick = resetNumber;
document.getElementById("resetFeaturedContents").onclick = resetFeaturedContents_fixed;
document.getElementById("resetPassed").onclick = resetPassed_fixed;

resetAllBtn.onclick = requestResetAll;
resetAllConfirmBtn.onclick = confirmResetAll;
clearLogBtn.onclick = clearAdminLog;

// --- (GUI Add 按鈕綁定) ---
addPassedBtn.onclick = async () => {
    const num = Number(newPassedNumberInput.value);
    if (num <= 0 || !Number.isInteger(num)) {
        alert("請輸入有效的正整數。");
        return;
    }
    addPassedBtn.disabled = true;
    const success = await apiRequest("/api/passed/add", { number: num });
    if (success) {
        newPassedNumberInput.value = "";
    }
    addPassedBtn.disabled = false;
};

addFeaturedBtn.onclick = async () => {
    const text = newLinkTextInput.value.trim();
    const url = newLinkUrlInput.value.trim();
    if (!text || !url) {
        alert("「連結文字」和「網址」都必須填寫。");
        return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        alert("網址請務必以 http:// 或 https:// 開頭。");
        return;
    }
    addFeaturedBtn.disabled = true;
    const success = await apiRequest("/api/featured/add", {
        linkText: text,
        linkUrl: url
    });
    if (success) {
        newLinkTextInput.value = "";
        newLinkUrlInput.value = "";
    }
    addFeaturedBtn.disabled = false;
};

// --- 11. 綁定 Enter 鍵 ---
newPassedNumberInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { addPassedBtn.click(); } });
newLinkTextInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { newLinkUrlInput.focus(); } });
newLinkUrlInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { addFeaturedBtn.click(); } });

// --- 12. 綁定開關 ---
soundToggle.addEventListener("change", () => {
    const isEnabled = soundToggle.checked;
    apiRequest("/set-sound-enabled", { enabled: isEnabled });
});

// 【新功能】 綁定公開狀態開關
publicToggle.addEventListener("change", () => {
    const isPublic = publicToggle.checked;
    if (!isPublic) {
        if (!confirm("確定要關閉前台嗎？\n所有使用者將會看到「維護中」畫面。")) {
            publicToggle.checked = true; // 取消操作，恢復勾選
            return;
        }
    }
    apiRequest("/set-public-status", { isPublic: isPublic });
});
