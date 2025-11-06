// --- 1. Socket.io 初始化 ---
const socket = io();

// --- 2. 元素節點 (DOM) ---
const numberEl = document.getElementById("number");
const passedListEl = document.getElementById("passedList");
const featuredContainerEl = document.getElementById("featured-container");
const statusBar = document.getElementById("status-bar");
const notifySound = document.getElementById("notify-sound"); 
const lastUpdatedEl = document.getElementById("last-updated");

// --- 3. 【新增】 前台全域狀態 ---
let isSoundEnabled = true; // 預設為 true，伺服器會立刻傳來正確值

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

// --- 5. Socket.io 資料更新監聽 ---

/** 【新增】 監聽音效設定 */
socket.on("updateSoundSetting", (isEnabled) => {
    console.log("音效設定更新:", isEnabled);
    isSoundEnabled = isEnabled;
});

/** 監聽 'updateTimestamp' */
socket.on("updateTimestamp", (timestamp) => {
    const date = new Date(timestamp);
    const timeString = date.toLocaleTimeString('zh-TW');
    lastUpdatedEl.textContent = `最後更新於 ${timeString}`;
});

/** 監聽 'update': 更新目前號碼 */
socket.on("update", (num) => {
    if (numberEl.textContent !== String(num)) {
        numberEl.textContent = num;
        
        // 【修改】 檢查 isSoundEnabled
        if (notifySound && isSoundEnabled) {
            notifySound.play().catch(e => console.warn("音效播放失敗 (需使用者互動):", e));
        }
        document.title = `目前號碼 ${num} - 候位顯示`;

        numberEl.classList.add("updated");
        setTimeout(() => {
            numberEl.classList.remove("updated");
        }, 500);
    }
});

/** 監聽 'updatePassed': 更新已過號列表 */
socket.on("updatePassed", (numbers) => {
    passedListEl.innerHTML = "";
    const h3 = document.querySelector("#passed-container h3");

    if (numbers && numbers.length > 0) {
        h3.style.marginTop = "25px";
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            passedListEl.appendChild(li);
        });
    } else {
        h3.style.marginTop = "0";
    }
});

/** 監聽 'updateFeaturedContents': 更新精選連結列表 */
socket.on("updateFeaturedContents", (contents) => {
    featuredContainerEl.innerHTML = "";
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
        if (hasVisibleLinks) {
            featuredContainerEl.style.display = "flex";
        } else {
            featuredContainerEl.style.display = "none";
        }
    } else {
        featuredContainerEl.style.display = "none";
    }
});


/*
 * =============================================
 * 6. 動態 QR Code 產生器
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
    if (qrPlaceholder) {
        qrPlaceholder.textContent = "QR Code 載入失敗";
    }
}

/*
 * =============================================
 * 7. 相對時間自動更新
 * =============================================
 */
let lastUpdateTime = null;
try {
    // 格式化相對時間的函式
    function formatTimeAgo(date) {
        const seconds = Math.floor((new Date() - date) / 1000);
        if (seconds < 10) return "剛剛";
        if (seconds < 60) return `${seconds} 秒前`;
        const minutes = Math.floor(seconds / 60);
        if (minutes === 1) return "1 分鐘前";
        return `${minutes} 分鐘前`;
    }

    // 重新綁定 "updateTimestamp" 監聽器以儲存 Date 物件
    socket.on("updateTimestamp", (timestamp) => {
        lastUpdateTime = new Date(timestamp); // 儲存 Date 物件
        const timeString = lastUpdateTime.toLocaleTimeString('zh-TW');
        lastUpdatedEl.textContent = `最後更新於 ${timeString}`;
    });

    // 每 10 秒鐘刷新一次
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
 * 8. 音效啟用
 * =============================================
 */
const audioPrompt = document.getElementById("audio-prompt");
if (audioPrompt && notifySound) {
    audioPrompt.addEventListener("click", () => {
        notifySound.play()
            .then(() => {
                console.log("音效已啟用。");
                audioPrompt.style.opacity = "0";
                setTimeout(() => { audioPrompt.style.display = "none"; }, 300);
            })
            .catch(e => {
                console.error("音效播放失敗:", e);
                alert("音效啟用失敗，請檢查瀏覽器設定。");
            });
    });

    // 嘗試自動播放 (如果瀏覽器允許，就自動隱藏按鈕)
    notifySound.play().then(() => {
        audioPrompt.style.display = "none";
    }).catch(e => {
        // 需要使用者手動點擊
    });
}
