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
const publicToggle = document.getElementById("public-toggle"); 
const adminLogUI = document.getElementById("admin-log-ui");
const clearLogBtn = document.getElementById("clear-log-btn");
const resetAllBtn = document.getElementById("resetAll");
// resetAllConfirmBtn 已移除

// --- 2. 全域變數 ---
let token = "";
let toastTimer = null; // 【新】 Toast 計時器
let publicToggleConfirmTimer = null; // 【新】 公開狀態的確認計時器


// --- 3. Socket.io ---
const socket = io({ 
    autoConnect: false,
    auth: {
        token: "" 
    }
});

// --- 4. 登入/顯示邏輯 ---
function showLogin() {
    loginContainer.style.display = "block";
    adminPanel.style.display = "none";
    document.title = "後台管理 - 登入";
    socket.disconnect();
}

async function showPanel() {
    loginContainer.style.display = "none";
    adminPanel.style.display = "block";
    document.title = "後台管理 - 控制台";
    socket.connect();

    // 移除所有 GridStack 和 layout 載入邏輯
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
        await showPanel(); 
    } else {
        loginError.textContent = "密碼錯誤";
        showLogin();
    }
}
document.addEventListener("DOMContentLoaded", () => { showLogin(); });
loginButton.addEventListener("click", () => { attemptLogin(passwordInput.value); });
passwordInput.addEventListener("keyup", (event) => { if (event.key === "Enter") { attemptLogin(passwordInput.value); } });

// --- 5. 【新】 Toast 通知函式 ---
function showToast(message, type = 'info') {
    const toast = document.getElementById("toast-notification");
    if (!toast) return;
    
    toast.textContent = message;
    toast.className = type; // 'success' or 'error' or 'info'
    
    toast.classList.add("show");
    
    if (toastTimer) clearTimeout(toastTimer);
    
    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 3000);
}


// --- 6. 控制台 Socket 監聽器 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    statusBar.classList.remove("visible");
    showToast("✅ 已連線到伺服器", "success");
});
socket.on("disconnect", () => {
    console.warn("Socket.io 已斷線");
    statusBar.classList.add("visible");
    showToast("❌ 已從伺服器斷線", "error");
});
socket.on("connect_error", (err) => {
    console.error("Socket 連線失敗:", err.message);
    if (err.message === "Authentication failed") {
        alert("密碼驗證失敗或 Token 已過期，請重新登入。");
        showLogin();
    }
});

// --- 【新】 伺服器日誌監聽器 ---
socket.on("initAdminLogs", (logs) => {
    adminLogUI.innerHTML = "";
    if (!logs || logs.length === 0) {
        adminLogUI.innerHTML = "<li>[目前尚無日誌]</li>";
        return;
    }
    const fragment = document.createDocumentFragment();
    logs.forEach(logMsg => {
        const li = document.createElement("li");
        li.textContent = logMsg;
        fragment.appendChild(li);
    });
    adminLogUI.appendChild(fragment);
    adminLogUI.scrollTop = adminLogUI.scrollHeight; // 自動滾動到底部
});

socket.on("newAdminLog", (logMessage) => {
    // 移除 "尚無日誌" 的提示
    const firstLi = adminLogUI.querySelector("li");
    if (firstLi && firstLi.textContent.includes("[目前尚無日誌]")) {
        adminLogUI.innerHTML = "";
    }
    
    const li = document.createElement("li");
    li.textContent = logMessage;
    adminLogUI.prepend(li); // 將最新的日誌加到最上方
});
// ---

// (移除舊的 update, updatePassed 等事件中的 adminLog 呼叫)
socket.on("update", (num) => {
    numberEl.textContent = num;
});
socket.on("updatePassed", (numbers) => {
    renderPassedListUI(numbers);
});
socket.on("updateFeaturedContents", (contents) => {
    renderFeaturedListUI(contents);
});
socket.on("updateSoundSetting", (isEnabled) => {
    console.log("收到音效設定:", isEnabled);
    soundToggle.checked = isEnabled;
});
socket.on("updatePublicStatus", (isPublic) => {
    console.log("收到公開狀態:", isEnabled);
    publicToggle.checked = isPublic;
});
socket.on("updateTimestamp", (timestamp) => {
    console.log("Timestamp updated:", timestamp);
});

// --- 7. API 請求函式 ---
async function apiRequest(endpoint, body, a_returnResponse = false) {
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...body, token }),
        });
        
        const responseData = await res.json(); 

        if (!res.ok) {
            if (res.status === 403) {
                alert("密碼驗證失敗或 Token 已過期，請重新登入。");
                showLogin();
            } else {
                const errorMsg = responseData.error || "未知錯誤";
                showToast(`❌ API 錯誤: ${errorMsg}`, "error");
                alert("發生錯誤：" + errorMsg);
            }
            return false;
        }

        if (a_returnResponse) {
            return responseData; 
        }
        
        return true; 
    } catch (err) {
        showToast(`❌ 網路連線失敗: ${err.message}`, "error");
        alert("網路連線失敗或伺服器無回應：" + err.message);
        return false;
    }
}

// --- 【新】 按鈕確認邏輯 (重構) ---
// (此函式現在會被 GUI 渲染函式呼叫)
function setupConfirmationButton(buttonEl, originalText, confirmText, actionCallback) {
    if (!buttonEl) return;
    
    let timer = null;
    let interval = null;
    let isConfirming = false;
    let countdown = 5;

    // 檢查是否需要顯示倒數計時 (小按鈕 "⚠️" 不需要)
    const showCountdown = confirmText.includes("點此") || confirmText.includes("重置");

    const resetBtn = () => {
        clearInterval(interval);
        clearTimeout(timer);
        isConfirming = false;
        countdown = 5;
        buttonEl.textContent = originalText;
        buttonEl.classList.remove("is-confirming");
        interval = null;
        timer = null;
    };

    buttonEl.addEventListener("click", () => {
        if (isConfirming) {
            // --- 執行動作 ---
            actionCallback();
            resetBtn();
        } else {
            // --- 進入確認 ---
            isConfirming = true;
            countdown = 5;
            buttonEl.textContent = showCountdown ? `${confirmText} (${countdown}s)` : confirmText;
            buttonEl.classList.add("is-confirming");

            if (showCountdown) {
                interval = setInterval(() => {
                    countdown--;
                    if (countdown > 0) {
                        buttonEl.textContent = `${confirmText} (${countdown}s)`;
                    } else {
                        clearInterval(interval); // Stop countdown
                    }
                }, 1000);
            }

            timer = setTimeout(() => {
                resetBtn();
            }, 5000);
        }
    });
}


// --- 8. GUI 渲染函式 ---
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
        
        // 【修改】 移除 confirm()，改用 setupConfirmationButton
        const actionCallback = async () => {
            deleteBtn.disabled = true;
            await apiRequest("/api/passed/remove", { number: number });
            // (日誌由伺服器自動發送)
        };
        
        setupConfirmationButton(deleteBtn, "×", "⚠️", actionCallback);
        
        li.appendChild(deleteBtn);
        fragment.appendChild(li);
    });
    passedListUI.appendChild(fragment);
}

// 【XSS 安全修正】
function renderFeaturedListUI(contents) {
    featuredListUI.innerHTML = "";
    if (!Array.isArray(contents)) return;
    
    const fragment = document.createDocumentFragment();
    
    contents.forEach((item) => {
        const li = document.createElement("li");
        // ... (span, textNode, small... 程式碼不變)
        const span = document.createElement("span");
        const textNode = document.createTextNode(item.linkText);
        span.appendChild(textNode);
        span.appendChild(document.createElement("br"));
        const small = document.createElement("small");
        small.style.color = "#666";
        small.textContent = item.linkUrl; 
        span.appendChild(small);
        li.appendChild(span);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        
        // 【修改】 移除 confirm()，改用 setupConfirmationButton
        const actionCallback = async () => {
            deleteBtn.disabled = true;
            await apiRequest("/api/featured/remove", {
                linkText: item.linkText,
                linkUrl: item.linkUrl
            });
        };
        
        setupConfirmationButton(deleteBtn, "×", "⚠️", actionCallback);
        
        li.appendChild(deleteBtn);
        fragment.appendChild(li);
    });
    featuredListUI.appendChild(fragment);
}

// --- 9. 控制台按鈕功能 ---

// (setupConfirmationButton 函式已移至上方)

// 【新】 重置按鈕的實際執行動作
const actionResetNumber = async () => {
    const success = await apiRequest("/set-number", { number: 0 });
    if (success) {
        document.getElementById("manualNumber").value = "";
        showToast("✅ 號碼已重置為 0", "success");
    }
};
const actionResetPassed = async () => {
    const success = await apiRequest("/api/passed/clear", {});
    if (success) {
        showToast("✅ 過號列表已清空", "success");
    }
};
const actionResetFeatured = async () => {
    const success = await apiRequest("/api/featured/clear", {});
    if (success) {
        showToast("✅ 精選連結已清空", "success");
    }
};
const actionResetAll = async () => {
    const success = await apiRequest("/reset", {});
    if (success) {
        document.getElementById("manualNumber").value = "";
        showToast("💥 所有資料已重置", "success");
        location.reload(); // 重載以獲取新排版和日誌
    }
};


// --- 其他按鈕功能 ---
async function changeNumber(direction) {
    await apiRequest("/change-number", { direction });
}
async function setNumber() {
    const num = document.getElementById("manualNumber").value;
    if (num === "") return;
    const success = await apiRequest("/set-number", { number: num });
    if (success) {
        document.getElementById("manualNumber").value = "";
        showToast("✅ 號碼已設定", "success");
    }
}

// 【修改】 清除日誌功能 (移除 confirm)
const actionClearAdminLog = async () => {
    showToast("🧼 正在清除日誌...", "info");
    await apiRequest("/api/logs/clear", {});
    // UI 會由 "initAdminLogs" socket 事件自動更新
}

// --- 10. 綁定按鈕事件 ---
document.getElementById("next").onclick = () => changeNumber("next");
document.getElementById("prev").onclick = () => changeNumber("prev");
document.getElementById("setNumber").onclick = setNumber;

// 【新】 綁定清除日誌和重置按鈕的新邏輯
setupConfirmationButton(
    document.getElementById("clear-log-btn"),
    "清除日誌",
    "⚠️ 點此確認清除",
    actionClearAdminLog
);
setupConfirmationButton(
    document.getElementById("resetNumber"),
    "重置號碼",
    "⚠️ 點此確認重置",
    actionResetNumber
);
setupConfirmationButton(
    document.getElementById("resetPassed"),
    "重置過號列表",
    "⚠️ 點此確認重置",
    actionResetPassed
);
setupConfirmationButton(
    document.getElementById("resetFeaturedContents"),
    "重置精選連結",
    "⚠️ 點此確認重置",
    actionResetFeatured
);
setupConfirmationButton(
    document.getElementById("resetAll"),
    "💥 重置所有 (點擊確認)",
    "⚠️ 點此確認重置 ⚠️",
    actionResetAll
);


// (舊的 .onclick 綁定已移除)

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

// 【重大修改】 移除 publicToggle 的 confirm()，改用倒數計時
const publicToggleLabel = document.getElementById("public-toggle-label");
const originalToggleText = "對外開放前台";

publicToggle.addEventListener("change", () => {
    const isPublic = publicToggle.checked;

    if (isPublic) {
        // --- 1. 正在從「關閉」切換回「開啟」 ---
        // 總是允許
        if (publicToggleConfirmTimer) {
            // 如果正在倒數，取消倒數
            clearTimeout(publicToggleConfirmTimer.timer);
            clearInterval(publicToggleConfirmTimer.interval);
            publicToggleConfirmTimer = null;
            publicToggleLabel.textContent = originalToggleText;
            publicToggleLabel.classList.remove("is-confirming-label");
        }
        apiRequest("/set-public-status", { isPublic: true });
    } else {
        // --- 2. 正在從「開啟」切換到「關閉」 ---
        if (publicToggleConfirmTimer) {
            // --- 2a. 正在確認中，執行動作 ---
            clearTimeout(publicToggleConfirmTimer.timer);
            clearInterval(publicToggleConfirmTimer.interval);
            publicToggleConfirmTimer = null;
            publicToggleLabel.textContent = originalToggleText;
            publicToggleLabel.classList.remove("is-confirming-label");
            
            apiRequest("/set-public-status", { isPublic: false });
            
        } else {
            // --- 2b. 首次點擊，開始確認 ---
            // 立即取消
            publicToggle.checked = true; 
            
            let countdown = 5;
            publicToggleLabel.textContent = `⚠️ 點此確認關閉 (${countdown}s)`;
            publicToggleLabel.classList.add("is-confirming-label");

            const interval = setInterval(() => {
                countdown--;
                if (countdown > 0) {
                    publicToggleLabel.textContent = `⚠️ 點此確認關閉 (${countdown}s)`;
                } else {
                    clearInterval(interval);
                }
            }, 1000);

            const timer = setTimeout(() => {
                clearInterval(interval);
                publicToggleLabel.textContent = originalToggleText;
                publicToggleLabel.classList.remove("is-confirming-label");
                publicToggleConfirmTimer = null;
            }, 5000);
            
            // 儲存計時器ID
            publicToggleConfirmTimer = { timer, interval };
        }
    }
});
