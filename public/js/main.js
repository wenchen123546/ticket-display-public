// --- 1. Socket.io 初始化 ---
const socket = io();

// --- 2. 元素節點 (DOM) ---
const numberEl = document.getElementById("number");
const passedListEl = document.getElementById("passedList");
const featuredContainerEl = document.getElementById("featured-container");
const statusBar = document.getElementById("status-bar");
const notifySound = document.getElementById("notify-sound"); // 音效

// --- 3. Socket.io 連線狀態監聽 ---

socket.on("connect", () => {
    console.log("Socket.io 已連接");
    statusBar.classList.remove("visible"); // 隱藏狀態條
});

socket.on("disconnect", () => {
    console.log("Socket.io 已斷線");
    statusBar.classList.add("visible"); // 顯示狀態條
});

// --- 4. Socket.io 資料更新監聽 ---

/** 監聽 'update': 更新目前號碼 */
socket.on("update", (num) => {
    // 檢查號碼是否有實際變更
    if (numberEl.textContent !== String(num)) {
        numberEl.textContent = num;
        
        // 播放音效 (如果有的話)
        if (notifySound) {
            notifySound.play().catch(e => console.warn("音效播放失敗 (需使用者互動):", e));
        }

        // 更新瀏覽器標籤
        document.title = `目前號碼 ${num} - 候位顯示`;
    }
});

/** 監聽 'updatePassed': 更新已過號列表 */
socket.on("updatePassed", (numbers) => {
    passedListEl.innerHTML = "";
    const h3 = document.querySelector("#passed-container h3");

    if (numbers && numbers.length > 0) {
        // 動態在 "已過號" 標題上方加入 25px 間距
        h3.style.marginTop = "25px";
        
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            passedListEl.appendChild(li);
        });
    } else {
        // 移除間距，保持緊湊
        h3.style.marginTop = "0";
    }
});

/** 監聽 'updateFeaturedContents': 更新精選連結列表 */
socket.on("updateFeaturedContents", (contents) => {
    featuredContainerEl.innerHTML = "";
    
    if (contents && contents.length > 0) {
        let hasVisibleLinks = false; 

        contents.forEach(item => {
            // 只顯示同時有 linkText 和 linkUrl 的項目
            if (item && item.linkText && item.linkUrl) {
                const a = document.createElement("a");
                a.className = "featured-link";
                a.target = "_blank";
                a.href = item.linkUrl;
                a.textContent = item.linkText;
                featuredContainerEl.appendChild(a);
                hasVisibleLinks = true; 
            }
        });

        if (hasVisibleLinks) {
            featuredContainerEl.style.display = "flex";
        } else {
            featuredContainerEl.style.display = "none";
        }

    } else {
        featuredContainerEl.style.display = "none";
    }
});