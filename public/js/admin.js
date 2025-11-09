// public/js/admin.js (v3.18 RWD 最終修復)

// --- 1. 元素節點 (DOM) ---
const adminPanel = document.getElementById("admin-panel");
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
const resetAllConfirmBtn = document.getElementById("resetAllConfirm");
const saveLayoutBtn = document.getElementById("save-layout-btn"); 
const toggleLayoutLockBtn = document.getElementById("toggle-layout-lock-btn"); 
const superAdminLink = document.getElementById("superadmin-link");
const logoutButton = document.getElementById("logout-button"); 
const onlineAdminList = document.getElementById("online-admin-list");
const onlineAdminCount = document.getElementById("online-admin-count");

// --- 2. 全域變數 ---
let resetAllTimer = null;
let grid = null; 
let toastTimer = null; 
let currentUser = null;
let isLayoutLocked = true;
let isChangingNumber = false; 

// --- 3. Socket.io ---
const socket = io({ 
    autoConnect: false
});
 
// --- 4. 登入/顯示邏輯 ---
document.addEventListener("DOMContentLoaded", () => {
    const userString = sessionStorage.getItem("currentUser");
 
    if (!userString) {
        alert("您尚未登入或登入已逾時。");
        window.location.href = "/login.html"; 
        return;
    }
 
    try {
        currentUser = JSON.parse(userString);
        console.log("已登入用戶:", currentUser);
    }
    catch (e) {
        alert("用戶資料格式錯誤，請重新登入。");
        sessionStorage.removeItem("currentUser"); 
        window.location.href = "/login.html";
        return;
    }
     
    showPanel();
});
 
// --- showPanel (v3.18 RWD 最終修復) ---
async function showPanel() {
    adminPanel.style.display = "block";
    document.title = "後台管理 - 控制台";
    socket.connect(); 
 
    // 立即初始化 GridStack (v3.15 修復)
    grid = GridStack.init({
        column: 12, 
        cellHeight: 'auto', 
        margin: 10,         
        minRow: 1,           
        float: true,       
        removable: false,   
        alwaysShowResizeHandle: 'mobile',
        disableDrag: true,
        disableResize: true,
        oneColumnMode: 'auto', // RWD 關鍵
        oneColumnModeBreakpoint: 768 // RWD 關鍵
    });

    // (權限按鈕)
    if (currentUser.role === 'superadmin') {
        if (superAdminLink) superAdminLink.style.display = 'block';
        if (toggleLayoutLockBtn) toggleLayoutLockBtn.style.display = 'block';
        if (saveLayoutBtn) saveLayoutBtn.style.display = 'block';
    }
 
    if (saveLayoutBtn) {
        saveLayoutBtn.disabled = true;
    }
 
    // (載入排版)
    let savedLayout = null;
    try {
        if (currentUser.role === 'superadmin') {
            const response = await apiRequest("/api/admin/layout/load", {}, true); 
            if (response && response.layout) {
                savedLayout = response.layout;
                showToast("✅ 已載入儲存的排版", "success");
            } else {
                showToast("ℹ️ 使用預設排版", "info");
            }
        }
    }
    catch (e) {
        showToast(`❌ 讀取排版失敗: ${e.message}`, "error");
    }
 
    // --- 【v3.18 RWD 最終修復】 ---
    // 只有在桌機版 (寬度 > 768) 且有儲存排版時，才載入
    if (savedLayout && window.innerWidth > 768) {
        grid.load(savedLayout);
    }
    // ---
}
 
// --- 5. Toast 通知函式 ---
function showToast(message, type = 'info') {
    const toast = document.getElementById("toast-notification");
    if (!toast) return;
    toast.textContent = message;
    toast.className = type; 
    toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 3000);
}
 
// --- 6. 控制台 Socket 監聽器 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接 (v3.0 Cookie Auth)");
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
    alert("Socket 驗證失敗，您的登入可能已過期，請重新登入。");
    sessionStorage.removeItem("currentUser"); 
    window.location.href = "/login.html";
});
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
    adminLogUI.scrollTop = adminLogUI.scrollHeight; 
});
socket.on("newAdminLog", (logMessage) => {
    const firstLi = adminLogUI.querySelector("li");
    if (firstLi && firstLi.textContent.includes("[目前尚無日誌]")) {
        adminLogUI.innerHTML = "";
    }
    const li = document.createElement("li");
    li.textContent = logMessage;
    adminLogUI.prepend(li); 
});
socket.on("update", (num) => { numberEl.textContent = num; });
socket.on("updatePassed", (numbers) => { renderPassedListUI(numbers); });
socket.on("updateFeaturedContents", (contents) => { renderFeaturedListUI(contents); });
socket.on("updateSoundSetting", (isEnabled) => { soundToggle.checked = isEnabled; });
socket.on("updatePublicStatus", (isPublic) => { publicToggle.checked = isPublic; });
socket.on("updateTimestamp", (timestamp) => { console.log("Timestamp updated:", timestamp); });
socket.on("updateOnlineList", (admins) => {
    renderOnlineList(admins);
});

 
// --- 7. API 請求函式 ---
async function apiRequest(endpoint, body = {}, a_returnResponse = false) {
    try {
        const res = await fetch(endpoint, {
            method: "POST",
            headers: { 
                "Content-Type": "application/json",
            },
            credentials: "include", 
            body: JSON.stringify(body), 
        });
        
        if (res.status === 401 || res.status === 403) {
            alert("權限不足或登入已過期，請重新登入。");
            sessionStorage.removeItem("currentUser");
            window.location.href = "/login.html";
            return false; 
        }
        
        const responseData = await res.json(); 
 
        if (!res.ok) {
            const errorMsg = responseData.error || "未知錯誤";
            showToast(`❌ API 錯誤: ${errorMsg}`, "error");
            alert("發生錯誤：" + errorMsg);
            return false;
        }
 
        if (a_returnResponse) {
            return responseData; 
        }
        
        return true; 
    }
    catch (err) {
        showToast(`❌ 網路連線失敗: ${err.message}`, "error");
        alert("網路連線失敗或伺服器無回應：" + err.message);
        return false;
    }
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
        deleteBtn.onclick = async () => {
            if (confirm(`確定要刪除過號 ${number} 嗎？`)) {
                deleteBtn.disabled = true;
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
        deleteBtn.onclick = async () => {
            if (confirm(`確定要刪除連結 ${item.linkText} 嗎？`)) { 
                deleteBtn.disabled = true;
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
function renderOnlineList(admins) {
    if (!onlineAdminList || !onlineAdminCount) return;
    
    onlineAdminList.innerHTML = ""; 
    onlineAdminCount.textContent = admins.length;

    if (admins.length === 0) {
        onlineAdminList.innerHTML = '<li class="empty-state">目前沒有管理員在線</li>';
        return;
    }
    
    const fragment = document.createDocumentFragment();
    const selfUsername = currentUser?.username; 
    
    admins.sort((a, b) => {
        if (a.username === selfUsername) return -1;
        if (b.username === selfUsername) return 1;
        return a.username.localeCompare(b.username);
    });

    admins.forEach(user => {
        const li = document.createElement("li");
        const roleSpan = document.createElement("span");
        
        roleSpan.className = `role-${user.role}`; 
        roleSpan.textContent = `[${user.role}]`;
        
        li.appendChild(roleSpan);
        li.appendChild(document.createTextNode(` ${user.username} `));
        
        if (user.username === selfUsername) {
            li.innerHTML += " (您)";
            li.style.fontWeight = "bold";
        }
        fragment.appendChild(li);
    });
    onlineAdminList.appendChild(fragment);
}

 
// --- 9. 控制台按鈕功能 ---
async function changeNumber(direction) {
    if (isChangingNumber) return; 
    isChangingNumber = true;
    try {
        await apiRequest("/api/number/change", { direction });
    } catch (e) {
        console.error("changeNumber 失敗:", e);
    } finally {
        isChangingNumber = false; 
    }
}
async function setNumber() {
    const num = document.getElementById("manualNumber").value;
    if (num === "") return;
    const success = await apiRequest("/api/number/set", { number: num });
    if (success) {
        document.getElementById("manualNumber").value = "";
        showToast("✅ 號碼已設定", "success");
    }
}
async function resetNumber() {
    if (!confirm("確定要將「目前號碼」重置為 0 嗎？")) return;
    const success = await apiRequest("/api/number/set", { number: 0 });
    if (success) {
        document.getElementById("manualNumber").value = "";
        showToast("✅ 號碼已重置為 0", "success");
    }
}
async function resetPassed_fixed() {
    if (!confirm("確定要清空「已叫號碼(過號)」列表嗎？")) return;
    const success = await apiRequest("/api/passed/clear", {});
    if (success) {
        showToast("✅ 過號列表已清空", "success");
    }
}
async function resetFeaturedContents_fixed() {
    if (!confirm("確定要清空「精選連結」嗎？")) return;
    const success = await apiRequest("/api/featured/clear", {});
    if (success) {
        showToast("✅ 精選連結已清空", "success");
    }
}
function cancelResetAll() {
    resetAllConfirmBtn.style.display = "none";
    resetAllBtn.style.display = "block";
    if (resetAllTimer) {
        clearTimeout(resetAllTimer);
        resetAllTimer = null;
    }
}
async function confirmResetAll() {
    const success = await apiRequest("/api/system/reset", {});
    if (success) {
        document.getElementById("manualNumber").value = "";
        showToast("💥 所有資料已重置", "success");
        location.reload(); 
    }
    cancelResetAll();
}
function requestResetAll() {
    resetAllBtn.style.display = "none";
    resetAllConfirmBtn.style.display = "block";
    resetAllTimer = setTimeout(() => {
        cancelResetAll();
    }, 5000);
}
async function clearAdminLog() {
    if (confirm("確定要永久清除「所有」管理員的操作日誌嗎？\n此動作無法復原。")) {
        showToast("🧼 正在清除日誌...", "info");
        await apiRequest("/api/logs/clear", {});
    }
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
if (logoutButton) {
    logoutButton.addEventListener("click", () => {
        if (confirm("確定要登出嗎？")) {
            sessionStorage.removeItem("currentUser");
            window.location.href = "/login.html";
        }
    });
}
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
    if (!url.startsWith('http://') && !url.startsWith('httpsS://')) {
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
    apiRequest("/api/settings/sound", { enabled: isEnabled });
});
publicToggle.addEventListener("change", () => {
    const isPublic = publicToggle.checked;
    if (!isPublic) {
        if (!confirm("確定要關閉前台嗎？\n所有使用者將會看到「維護中」畫面。")) {
            publicToggle.checked = true; 
            return;
        }
    }
    apiRequest("/api/settings/public", { isPublic: isPublic });
});
 
// --- 13. 綁定 GridStack 控制按鈕 ---
if (saveLayoutBtn) {
    saveLayoutBtn.addEventListener("click", async () => {
        if (!grid) return;
        
        const layoutData = grid.save(false).map(item => ({
            id: item.id,
            x: item.x, 
            y: item.y, 
            w: item.w, 
            h: item.h 
        }));
 
        showToast("💾 正在儲存排版...", "info");
        console.log("正在儲存:", JSON.stringify(layoutData, null, 2));
 
        const success = await apiRequest("/api/admin/layout/save", { layout: layoutData });
        
        if (success) {
            showToast("✅ 排版已成功儲存！", "success");
            if (!isLayoutLocked) {
                grid.enableMove(false);
                grid.enableResize(false);
                isLayoutLocked = true;
                toggleLayoutLockBtn.textContent = "🔓 解鎖排版";
                saveLayoutBtn.disabled = true;
            }
        } 
    });
}
 
if (toggleLayoutLockBtn) {
    toggleLayoutLockBtn.addEventListener("click", () => {
        if (!grid) return;
        
        if (isLayoutLocked) {
            grid.enableMove(true);
            grid.enableResize(true);
            toggleLayoutLockBtn.textContent = "🔒 鎖定排版";
            saveLayoutBtn.disabled = false;
            showToast("ℹ️ 儀表板已解鎖，您可以拖移卡片。", "info");
        } else {
            grid.enableMove(false);
            grid.enableResize(false);
            toggleLayoutLockBtn.textContent = "🔓 解鎖排版";
            saveLayoutBtn.disabled = true;
            showToast("ℹ️ 儀表板已鎖定。", "info");
        }
        isLayoutLocked = !isLayoutLocked;
    });
}
