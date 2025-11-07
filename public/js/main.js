// --- 1. Socket.io 初始化 ---
const socket = io();

// --- 2. 元素節點 (DOM) ---
const numberEl = document.getElementById("number");
const passedListEl = document.getElementById("passedList");
const featuredContainerEl = document.getElementById("featured-container");
const statusBar = document.getElementById("status-bar");
const notifySound = document.getElementById("notify-sound");
const lastUpdatedEl = document.getElementById("last-updated");
const localMuteBtn = document.getElementById("local-mute-btn");
const featuredEmptyMsg = document.getElementById("featured-empty-msg");
const passedContainerEl = document.getElementById("passed-container"); 

// --- 3. 前台全域狀態 ---
let isSoundEnabled = true; // 全域開關 (來自伺服器)
let isLocallyMuted = false; // 本機開關 (初始為 false = 未靜音)
let lastUpdateTime = null; // 時間戳

// --- 4. Socket.io 連線狀態監聽 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    statusBar.classList.remove("visible"); 
});

socket.on("disconnect", () => {
    console.log("Socket.io 已斷線");
    statusBar.classList.add("visible"); 
    lastUpdatedEl.textContent = "連線中斷...";
});

socket.on("initialStateError", (errorMsg) => {
    console.error("無法載入初始狀態:", errorMsg);
    alert(errorMsg); 
    lastUpdatedEl.textContent = "載入失敗";
});

// --- 5. Socket.io 資料更新監聽 ---
socket.on("updateSoundSetting", (isEnabled) => {
    console.log("音效設定更新:", isEnabled);
    isSoundEnabled = isEnabled;
});

socket.on("updateTimestamp", (timestamp) => {
    lastUpdateTime = new Date(timestamp); 
    const timeString = lastUpdateTime.toLocaleTimeString('zh-TW');
    lastUpdatedEl.textContent = `最後更新於 ${timeString}`;
});

socket.on("update", (num) => {
    if (numberEl.textContent !== String(num)) {
        numberEl.textContent = num;
        
        // 播放音效的檢查邏輯 (這是正確的)
        if (notifySound && isSoundEnabled && !isLocallyMuted) {
            notifySound.play().catch(e => console.warn("音效播放失敗:", e));
        }
        
        document.title = `目前號碼 ${num} - 候位顯示`;
        numberEl.classList.add("updated");
        setTimeout(() => { numberEl.classList.remove("updated"); }, 500);
    }
});

socket.on("updatePassed", (numbers) => {
    passedListEl.innerHTML = "";
    
    const isEmpty = !numbers || numbers.length === 0;
    passedContainerEl.classList.toggle("is-empty", isEmpty);

    if (!isEmpty) {
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            passedListEl.appendChild(li);
        });
    }
});

socket.on("updateFeaturedContents", (contents) => {
    featuredContainerEl.innerHTML = ""; 
    
    const emptyMsgNode = featuredEmptyMsg.cloneNode(true);
    featuredContainerEl.appendChild(emptyMsgNode);

    if (contents && contents.length > 0) {
        let hasVisibleLinks = false; 
        contents.forEach(item => {
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
        
        featuredContainerEl.classList.toggle("is-empty", !hasVisibleLinks); 
    }
    else {
        featuredContainerEl.classList.add("is-empty");
    }
});

/*
 * =============================================
 * 6. 動態 QR Code 產生器 (保持不變)
 * =============================================
 */
try {
    const qrPlaceholder = document.getElementById("qr-code-placeholder");
    if (qrPlaceholder) {
        new QRCode(qrPlaceholder, {
            text: window.location.href,
            width: 120, 
            height: 120,
            correctLevel: QRCode.CorrectLevel.M 
        });
    }
} catch (e) {
    console.error("QR Code 產生失敗", e);
    const qrPlaceholder = document.getElementById("qr-code-placeholder");
    if (qrPlaceholder) { qrPlaceholder.textContent = "QR Code 載入失敗"; }
}

/*
 * =============================================
 * 7. 相對時間自動更新 (保持不變)
 * =============================================
 */
try {
    function formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 10) return "剛剛";
        if (seconds < 60) return `${seconds} 秒前`;
        const minutes = Math.floor(seconds / 60);
        if (minutes === 1) return "1 分鐘前";
        return `${minutes} 分鐘前`;
    }
    setInterval(() => {
        if (lastUpdateTime && socket.connected) {
            const relativeTime = formatTimeAgo(lastUpdateTime);
            lastUpdatedEl.textContent = `最後更新於 ${relativeTime}`;
        }
    }, 10000); 
} catch (e) {
    console.error("相對時間更新失敗:", e);
}

/*
 * =============================================
 * 8. 音效啟用 / 個人靜音
 * (【B. 修正】 -> 【1.A 修正】 修正圖示與狀態顛倒的邏輯)
 * =============================================
 */

// 嘗試自動播放
if (notifySound) {
    notifySound.play().then(() => {
        console.log("音效預載入/自動播放成功。");
    }).catch(e => {
        console.warn("音效自動播放失敗，可能需要使用者互動。");
    });
}

if(localMuteBtn) {
    // 【1.A 修正】 這裡的邏輯已完全修正
    localMuteBtn.addEventListener("click", () => {
        isLocallyMuted = !isLocallyMuted; // 切換狀態
        localMuteBtn.classList.toggle("muted", isLocallyMuted); // 切換 CSS

        if (isLocallyMuted) {
            // **狀態：已靜音**
            localMuteBtn.textContent = "🔇"; // 顯示「已靜音」圖示
            localMuteBtn.setAttribute("aria-label", "取消靜音"); // 提示使用者「點此可取消靜音」
        } else {
            // **狀態：未靜音**
            localMuteBtn.textContent = "🔈"; // 顯示「未靜音」圖示
            // v v v 修正拼寫錯誤 v v v
            localMuteBtn.setAttribute("aria-label", "靜音"); // 提示使用者「點此可靜音」
            // ^ ^ ^ 修正拼寫錯誤 ^ ^ ^
        }
    });
}
