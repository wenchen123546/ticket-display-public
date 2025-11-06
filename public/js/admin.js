// --- 1. 元素節點 (DOM) ---
const loginContainer = document.getElementById("login-container");
const adminPanel = document.getElementById("admin-panel");
const passwordInput = document.getElementById("password-input");
const loginButton = document.getElementById("login-button");
const loginError = document.getElementById("login-error");
const numberEl = document.getElementById("number");
const passedNumbersInputEl = document.getElementById("passedNumbersInput");
const featuredEditorInput = document.getElementById("featuredEditorInput");

// --- 2. 全域變數 ---
let token = "";
// const TOKEN_KEY = "adminToken"; // [REMOVED]

// --- 3. Socket.io ---
const socket = io({ autoConnect: false });

// --- 4. 登入/顯示邏輯 ---

/** 顯示登入畫面 (同時也是登出函式) */
function showLogin() {
    loginContainer.style.display = "block";
    adminPanel.style.display = "none";
    // localStorage.removeItem(TOKEN_KEY); // [REMOVED]
    document.title = "後台管理 - 登入";
    socket.disconnect(); 
}

/** 顯示後台控制台 */
function showPanel() {
    loginContainer.style.display = "none";
    adminPanel.style.display = "block";
    document.title = "後台管理 - 控制台";
    socket.connect(); 
}

/** [API] 檢查 Token 是否有效 */
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

/** 嘗試登入 */
async function attemptLogin(tokenToCheck) {
    loginError.textContent = "驗證中...";
    const isValid = await checkToken(tokenToCheck);
    if (isValid) {
        token = tokenToCheck;
        // localStorage.setItem(TOKEN_KEY, tokenToCheck); // [REMOVED]
        showPanel(); 
    } else {
        loginError.textContent = "密碼錯誤";
        showLogin();
    }
}

/** 【修改】 頁面載入完成時的入口 (強制顯示登入) */
document.addEventListener("DOMContentLoaded", () => {
    // 移除自動登入邏輯，一律顯示登入畫面
    showLogin();
});

// 綁定登入按鈕點擊事件
loginButton.addEventListener("click", () => {
    attemptLogin(passwordInput.value);
});
// 綁定密碼框 Enter 鍵
passwordInput.addEventListener("keyup", (event) => {
    if (event.key === "Enter") {
        attemptLogin(passwordInput.value);
    }
});

// --- 5. 控制台 Socket 監聽器 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
});

socket.on("update", (num) => (numberEl.textContent = num));

socket.on("updatePassed", (numbers) => {
    if (numbers && Array.isArray(numbers)) {
        passedNumbersInputEl.value = numbers.join(", ");
    } else {
        passedNumbersInputEl.value = "";
    }
});

socket.on("updateFeaturedContents", (contents) => {
    if (contents && Array.isArray(contents)) {
        const textValue = contents.map(item => 
            `${item.linkText},${item.linkUrl}`
        ).join("\n");
        featuredEditorInput.value = textValue;
    } else {
        featuredEditorInput.value = "";
    }
});

// --- 6. API 請求函式 ---
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
                alert("發生錯誤：" + (errorData.error || "未知錯誤"));
            }
            return false;
        }
        return true;
    } catch (err) {
        alert("網路連線失敗或伺服器無回應：" + err.message);
        return false;
    }
}

// --- 7. 控制台按鈕功能 ---
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

async function savePassedNumbers() {
    const text = passedNumbersInputEl.value;
    const numbersArray = text.split(",")
        .map((n) => n.trim())
        .filter((n) => n.length > 0)
        .map((n) => Number(n));
        
    const limitedNumbers = numbersArray.slice(0, 5); // 限制數量

    const success = await apiRequest("/set-passed-numbers", { numbers: limitedNumbers });
    if (success) {
        alert("過號列表已儲存。");
    }
}

async function saveFeaturedContents() {
    const text = featuredEditorInput.value;
    const contentsArray = text
        .split('\n')
        .map(line => {
            if (line.trim() === '') return null;
            const parts = line.split(',');
            return {
                linkText: parts[0] ? parts[0].trim() : '',
                linkUrl: parts[1] ? parts.slice(1).join(',').trim() : ''
            };
        })
        .filter(Boolean); 

    const success = await apiRequest("/set-featured-contents", { contents: contentsArray });
    if (success) {
        alert("精選連結已儲存。");
    }
}

// --- 重置功能 ---

async function resetNumber() {
    if (!confirm("確定要將「目前號碼」重置為 0 嗎？ (會將現有號碼加入過號列表)")) return;
    
    const success = await apiRequest("/set-number", { number: 0 });
    if (success) {
        document.getElementById("manualNumber").value = "";
        alert("號碼已重置為 0。");
    }
}

async function resetPassed() {
    if (!confirm("確定要清空「已叫號碼(過號)」列表嗎？")) return;
    
    await apiRequest("/set-passed-numbers", { numbers: [] });
}

async function resetFeaturedContents() {
    if (!confirm("確定要清空「精選連結」嗎？")) return;
    
    const success = await apiRequest("/set-featured-contents", { contents: [] });
    if (success) {
        alert("精選連結已清空。");
    }
}

async function resetAll() {
    if (!confirm("確定要將所有內容全部重置嗎？")) { return; }
    const success = await apiRequest("/reset", {});
    if (success) {
        document.getElementById("manualNumber").value = "";
        alert("已全部重置。");
    }
}

// --- 8. 綁定按鈕事件 ---
document.getElementById("next").onclick = () => changeNumber("next");
document.getElementById("prev").onclick = () => changeNumber("prev");
document.getElementById("setNumber").onclick = setNumber;
document.getElementById("savePassedNumbers").onclick = savePassedNumbers;
document.getElementById("saveFeaturedContents").onclick = saveFeaturedContents;
document.getElementById("resetNumber").onclick = resetNumber;
document.getElementById("resetFeaturedContents").onclick = resetFeaturedContents;
document.getElementById("resetPassed").onclick = resetPassed;
document.getElementById("resetAll").onclick = resetAll;

// [REMOVED] 登出按鈕
