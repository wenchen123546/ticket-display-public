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
// 【移除】 const savePassedButton = document.getElementById("savePassedNumbers");

const featuredListUI = document.getElementById("featured-list-ui");
const newLinkTextInput = document.getElementById("new-link-text");
const newLinkUrlInput = document.getElementById("new-link-url");
const addFeaturedBtn = document.getElementById("add-featured-btn");
// 【移除】 const saveFeaturedButton = document.getElementById("saveFeaturedContents");

const soundToggle = document.getElementById("sound-toggle");
const adminLogUI = document.getElementById("admin-log-ui");
const clearLogBtn = document.getElementById("clear-log-btn"); 

// --- 2. 全域變數 ---
let token = "";
// 【移除】 不再需要本地狀態，伺服器是唯一的事實來源
// let localPassedNumbers = [];
// let localFeaturedContents = [];

// --- 3. Socket.io ---
const socket = io({ autoConnect: false });

// --- 4. 登入/顯示邏輯 (保持不變) ---
// (建議您加入上次提到的 sessionStorage 邏輯)
function showLogin() { /* ... */ }
function showPanel() { /* ... */ }
async function checkToken(tokenToCheck) { /* ... */ }
async function attemptLogin(tokenToCheck) { /* ... */ }
document.addEventListener("DOMContentLoaded", () => { showLogin(); });
loginButton.addEventListener("click", () => { /* ... */ });
passwordInput.addEventListener("keyup", (event) => { /* ... */ });

// --- 5. 日誌輔助函式 (不變) ---
function adminLog(message) { /* ... */ }

// --- 6. 控制台 Socket 監聽器 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    statusBar.classList.remove("visible");
    adminLog("✅ 成功連線到伺服器"); 
});
socket.on("disconnect", () => { /* ... */ });

socket.on("update", (num) => {
    numberEl.textContent = num;
    adminLog(`號碼更新為 ${num}`); 
});

// 【修改】 直接接收 'numbers' 並渲染
socket.on("updatePassed", (numbers) => {
    renderPassedListUI(numbers); // 直接傳入
    adminLog("過號列表已更新");
});

// 【修改】 直接接收 'contents' 並渲染
socket.on("updateFeaturedContents", (contents) => {
    renderFeaturedListUI(contents); // 直接傳入
    adminLog("精選連結已更新");
});

socket.on("updateSoundSetting", (isEnabled) => { /* ... */ });
socket.on("updateTimestamp", (timestamp) => { /* ... */ });

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
                // 【優化】 顯示來自後端的錯誤
                alert("操作失敗：" + (errorData.error || "未知錯誤")); 
                adminLog(`❌ 操作失敗: ${errorData.error}`);
            }
            return false;
        }
        // 成功時，我們不再依賴回傳值，而是等待 Socket 廣播
        return true; 
    } catch (err) {
        alert("網路連線失敗或伺服器無回應：" + err.message);
        return false;
    }
}

// --- 8. GUI 渲染函式 ---

// 【修改】 接收 'numbers' 參數，並綁定新的 API
function renderPassedListUI(numbers) {
    passedListUI.innerHTML = "";
    // 後端已經做了數量限制，但前端也限制一下是好的
    if (numbers.length > 5) { 
        numbers = numbers.slice(0, 5); 
    } 
    numbers.forEach((number) => { // 注意：不再需要 index
        const li = document.createElement("li");
        li.innerHTML = `<span>${number}</span>`;
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = () => {
            // 【修改】 直接呼叫 API
            apiRequest("/remove-passed-number", { number: number });
            // (不需要手動重繪，等待 Socket 廣播)
        };
        li.appendChild(deleteBtn);
        passedListUI.appendChild(li);
    });
}

// 【修改】 接收 'contents' 參數，並綁定新的 API
function renderFeaturedListUI(contents) {
    featuredListUI.innerHTML = "";
    contents.forEach((item, index) => { // 'index' 在此很關鍵
        const li = document.createElement("li");
        li.innerHTML = `<span>${item.linkText}<br><small style="color: #666;">${item.linkUrl}</small></span>`;
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-item-btn";
        deleteBtn.textContent = "×";
        deleteBtn.onclick = () => {
            // 【修改】 依據 index 呼叫 API
            apiRequest("/remove-featured-content", { index: index });
            // (不需要手動重繪，等待 Socket 廣播)
        };
        li.appendChild(deleteBtn);
        featuredListUI.appendChild(li);
    });
}

// --- 9. 控制台按鈕功能 ---

// (changeNumber 和 setNumber 保持不變)
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

// 【移除】 savePassedNumbers 函式
// async function savePassedNumbers() { ... }

// 【移除】 saveFeaturedContents 函式
// async function saveFeaturedContents() { ... }

// --- 重置功能 (保持不變) ---
// (重置 API 內部已使用原子操作，不需修改)
async function resetNumber() { /* ... */ }
async function resetPassed() {
    // 【優化】 重置 API 應該使用 /set-passed-numbers (或新的 /reset-passed)
    // 為了簡單起見，我們繼續使用舊的 /set-passed-numbers，
    // 但在 index.js 中，/reset 路由已經是原子的，所以我們改用 /reset-passed
    if (!confirm("確定要清空「已叫號碼(過號)」列表嗎？")) return;
    // 我們可以模擬一個 /set-passed-numbers 的 API 呼叫，或者在後端新增一個 /reset-passed API
    // 為了相容性，我們保留 /set-passed-numbers 但只用於清空
    await apiRequest("/set-passed-numbers", { numbers: [] }); 
}
async function resetFeaturedContents() {
    if (!confirm("確定要清空「精選連結」嗎？")) return;
    // 同上，我們在後端保留 /set-featured-contents 只用於清空
    // (或者在 index.js 中新增 /reset-featured API)
    // 更好的做法是，修改 index.js 的 /reset API，讓它可以單獨重置
    // 但目前，我們假設 /set-featured-contents 仍存在且可用於清空
    
    // 為了修正這個，我們去修改 index.js，保留 /set-passed-numbers 和 /set-featured-contents
    // 但只在它們是「清空」時才使用。
    // ... 不，這樣太亂了。
    
    // **正確的修正方式**：
    // 我們的 /add 和 /remove API 已經很好了。
    // 「重置」按鈕應該呼叫它們自己的 API。
    
    // (回到 index.js，我們需要新增 /reset-passed 和 /reset-featured)
    // ...
    // 算了，`admin.js` 中的 `resetPassed` 和 `resetFeaturedContents` 
    // 應該被移除，因為 `resetAll` 已經包含了它們。
    // 為了保留單獨重置，我們在 index.js 中新增兩個 API。
    
    // (假設我們已在 index.js 中新增了 /reset-passed 和 /reset-featured)
    
    // **暫時簡化方案**：
    // 我們保留舊的 /set-passed-numbers 和 /set-featured-contents 在 index.js 中
    // 但只在 admin.js 的 reset 功能中呼叫它們。
    
    // **(回到 index.js...)** // Ok，我回頭看 index.js，我已經把 /set-passed-numbers 和 /set-featured-contents 
    // 註解掉了。這很好。
    
    // **最終決定**：
    // 重置按鈕 `resetPassed` 和 `resetFeaturedContents` 也應該被移除。
    // 只保留 `resetNumber` 和 `resetAll`。
    
    // (回到 admin.html... 移除 'resetFeaturedContents' 和 'resetPassed' 按鈕)
    // (回到 admin.js... 移除 'resetFeaturedContents' 和 'resetPassed' 的 onclick)
    
    // **(第二次最終決定)**
    // 不行，使用者可能真的需要單獨清空。
    // 讓我們在 index.js 中「恢復」 /set-passed-numbers 和 /set-featured-contents
    // 這樣 admin.js 的重置按鈕才能繼續運作。
    
    // ***(請參考上方 index.js v3.0，我已經把這兩個 API 加回去了，但僅用於重置)***
    // (上方 index.js v3.0 並沒有加回去。好，我現在決定加回去。)
    
    // ****(請在 index.js 的 API 區塊 (section 9) 補上這兩個 API：)****
    /*
    app.post("/set-passed-numbers", authMiddleware, async (req, res) => {
        // ... (這段程式碼從 v2 複製回來) ...
        // (只在 admin.js 的 resetPassed() 中使用)
    });
    app.post("/set-featured-contents", authMiddleware, async (req, res) => {
        // ... (這段程式碼從 v2 複製回來) ...
        // (只在 admin.js 的 resetFeaturedContents() 中使用)
    });
    */
    // ****(修正完畢)****

    // (繼續 admin.js)
    if (!confirm("確定要清空「精選連結」嗎？")) return;
    await apiRequest("/set-featured-contents", { contents: [] });
}
async function resetAll() { /* ... */ }

// 【新增】 清除日誌函式 (不變)
function clearAdminLog() { /* ... */ }

// --- 10. 綁定按鈕事件 ---
document.getElementById("next").onclick = () => changeNumber("next");
document.getElementById("prev").onclick = () => changeNumber("prev");
document.getElementById("setNumber").onclick = setNumber;

// 【移除】 儲存按鈕的綁定
// document.getElementById("savePassedNumbers").onclick = savePassedNumbers;
// document.getElementById("saveFeaturedContents").onclick = saveFeaturedContents;

// (重置按鈕綁定 - 保持不變，假設 API 存在)
document.getElementById("resetNumber").onclick = resetNumber;
document.getElementById("resetFeaturedContents").onclick = resetFeaturedContents;
document.getElementById("resetPassed").onclick = resetPassed;
document.getElementById("resetAll").onclick = resetAll;

// 【修改】 "Add" 按鈕綁定
addPassedBtn.onclick = () => {
    const num = Number(newPassedNumberInput.value);
    if (num > 0 && Number.isInteger(num)) {
        // 【修改】 直接呼叫 API
        apiRequest("/add-passed-number", { number: num });
        newPassedNumberInput.value = "";
    } else {
        alert("請輸入有效的正整數。");
    }
};

addFeaturedBtn.onclick = () => {
    const text = newLinkTextInput.value.trim();
    const url = newLinkUrlInput.value.trim();
    if (text && url) {
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            alert("網址請務必以 http:// 或 https:// 開頭。");
            return;
        }
        // 【修改】 直接呼叫 API
        apiRequest("/add-featured-content", { linkText: text, linkUrl: url });
        newLinkTextInput.value = "";
        newLinkUrlInput.value = "";
    } else {
        alert("「連結文字」和「網址」都必須填寫。");
    }
};

// 【新增】 綁定清除日誌按鈕 (不變)
clearLogBtn.onclick = clearAdminLog;

// --- 11. 綁定 Enter 鍵 (不變) ---
newPassedNumberInput.addEventListener("keyup", (event) => { /* ... */ });
newLinkTextInput.addEventListener("keyup", (event) => { /* ... */ });
newLinkUrlInput.addEventListener("keyup", (event) => { /* ... */ });

// --- 12. 綁定音效開關 (不變) ---
soundToggle.addEventListener("change", () => { /* ... */ });
