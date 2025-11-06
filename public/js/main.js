// --- 1. Socket.io 初始化 ---
const socket = io();

// --- 2. 元素節點 (DOM) ---
const numberEl = document.getElementById("number");
const passedListEl = document.getElementById("passedList");
const featuredContainerEl = document.getElementById("featured-container");
const statusBar = document.getElementById("status-bar");
const notifySound = document.getElementById("notify-sound"); 
const lastUpdatedEl = document.getElementById("last-updated");
const localMuteBtn = document.getElementById("local-mute-btn"); // 個人靜音
const passedEmptyMsg = document.getElementById("passed-empty-msg"); // 【新增】
const featuredEmptyMsg = document.getElementById("featured-empty-msg"); // 【新增】


// --- 3. 前台全域狀態 ---
let isSoundEnabled = true; // 全域開關 (來自伺服器)
let isLocallyMuted = false; // 本機開關
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

// --- 5. Socket.io 資料更新監聽 ---
socket.on("updateSoundSetting", (isEnabled) => {
    console.log("音效設定更新:", isEnabled);
    isSoundEnabled = isEnabled;
});
socket.on("updateTimestamp", (timestamp) => {
    lastUpdateTime = new Date(timestamp); // 儲存 Date 物件
    const timeString = lastUpdateTime.toLocaleTimeString('zh-TW');
    lastUpdatedEl.textContent = `最後更新於 ${timeString}`;
});
socket.on("update", (num) => {
    if (numberEl.textContent !== String(num)) {
        numberEl.textContent = num;
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
    const h3 = document.querySelector("#passed-container h3");

    if (numbers && numbers.length > 0) {
        h3.style.marginTop = "25px";
        passedEmptyMsg.style.display = "none"; // 【新增】 隱藏提示
        
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            passedListEl.appendChild(li);
        });
    } else {
        h3.style.marginTop = "0";
        passedEmptyMsg.style.display = "block"; // 【新增】 顯示提示
    }
});
socket.on("updateFeaturedContents", (contents) => {
    featuredContainerEl.innerHTML = ""; // 清空
    
    // 【修改】 確保在有連結時才插入 empty-msg
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
                featuredContainerEl.appendChild(a); // 在 empty-msg 之後插入
                hasVisibleLinks = true; 
            }
        });

        if (hasVisibleLinks) {
            featuredContainerEl.style.display = "flex";
            emptyMsgNode.style.display = "none"; // 隱藏提示
        } else {
            featuredContainerEl.style.display = "block"; // 顯示容器
            emptyMsgNode.style.display = "block"; // 顯示提示
        }
    } else {
        featuredContainerEl.style.display = "none";
        emptyMsgNode.style.display = "none";
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
    if (qrPlaceholder) { qrPlaceholder.textContent = "QR Code 載入失敗"; }
}

/*
 * =============================================
 * 7. 相對時間自動更新
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
    // 嘗試自動播放
    notifySound.play().then(() => {
        audioPrompt.style.display = "none";
    }).catch(e => {
        // 需要使用者手動點擊
    });
}
if(localMuteBtn) {
    localMuteBtn.addEventListener("click", () => {
        isLocallyMuted = !isLocallyMuted; // 切換狀態
        localMuteBtn.classList.toggle("muted", isLocallyMuted); // 切換 CSS
        localMuteBtn.textContent = isLocallyMuted ? "🔈" : "🔇";
    });
}
