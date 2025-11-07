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
const soundPrompt = document.getElementById("sound-prompt"); // 【新】

// --- 3. 前台全域狀態 ---
let isSoundEnabled = true;
let isLocallyMuted = false;
let lastUpdateTime = null;
let isPublic = true;
let audioPermissionGranted = false; // 【新】 標記是否已取得權限

// --- 4. Socket.io 連線狀態監聽 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    if (isPublic) {
        statusBar.classList.remove("visible"); 
    }
});

socket.on("disconnect", () => {
    console.log("Socket.io 已斷線");
    if (isPublic) {
        statusBar.classList.add("visible"); 
    }
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

socket.on("updatePublicStatus", (status) => {
    console.log("Public status updated:", status);
    isPublic = status;
    document.body.classList.toggle("is-closed", !isPublic);
    if (!isPublic) {
        statusBar.classList.remove("visible");
    }
});

socket.on("updateTimestamp", (timestamp) => {
    lastUpdateTime = new Date(timestamp); 
    const timeString = lastUpdateTime.toLocaleTimeString('zh-TW');
    lastUpdatedEl.textContent = `最後更新於 ${timeString}`;
});

// --- 【新】 獨立的播放音效函式 ---
function playNotificationSound() {
    // 如果全域關閉、本機靜音，或音效元件不存在，則不播放
    if (!notifySound || !isSoundEnabled || isLocallyMuted) {
        return;
    }

    // 如果已取得權限，就直接播放
    if (audioPermissionGranted) {
        notifySound.play().catch(e => console.warn("音效播放失敗 (已有權限):", e));
        return;
    }

    // 如果尚未取得權限，嘗試播放
    const playPromise = notifySound.play();
    if (playPromise !== undefined) {
        playPromise.then(() => {
            // 播放成功！標記權限，隱藏提示
            audioPermissionGranted = true;
            if (soundPrompt) soundPrompt.style.display = 'none';
        }).catch(error => {
            // 播放失敗，顯示提示
            console.warn("音效播放失敗，等待使用者互動:", error);
            if (soundPrompt) soundPrompt.style.display = 'block';
            audioPermissionGranted = false;
        });
    }
}

socket.on("update", (num) => {
    if (numberEl.textContent !== String(num)) {
        numberEl.textContent = num;
        
        // --- 【新】 呼叫獨立的播放函式 ---
        playNotificationSound(); 
        
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
        const fragment = document.createDocumentFragment();
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            fragment.appendChild(li);
        });
        passedListEl.appendChild(fragment);
    }
});

socket.on("updateFeaturedContents", (contents) => {
    featuredContainerEl.innerHTML = ""; 
    const emptyMsgNode = featuredEmptyMsg.cloneNode(true);
    featuredContainerEl.appendChild(emptyMsgNode);
    const fragment = document.createDocumentFragment();
    let hasVisibleLinks = false; 
    if (contents && contents.length > 0) {
        contents.forEach(item => {
            if (item && item.linkText && item.linkUrl) {
                const a = document.createElement("a");
                a.className = "featured-link";
                a.target = "_blank";
                a.href = item.linkUrl;
                a.textContent = item.linkText;
                fragment.appendChild(a);
                hasVisibleLinks = true; 
            }
        });
    }
    featuredContainerEl.appendChild(fragment);
    featuredContainerEl.classList.toggle("is-empty", !hasVisibleLinks); 
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
        if (lastUpdateTime && socket.connected && isPublic) { // 只有在公開時才更新時間
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
 * (【新】 整合音效權限邏輯)
 * =============================================
 */

// 【新】 點擊提示時，嘗試播放並隱藏提示
if (soundPrompt) {
    soundPrompt.addEventListener("click", () => {
        if (notifySound) {
            notifySound.play().then(() => {
                audioPermissionGranted = true;
                soundPrompt.style.display = 'none';
            }).catch(e => {
                console.error("點擊提示後播放失敗:", e);
                soundPrompt.style.display = 'none'; // 播放失敗也隱藏，避免干擾
            });
        }
    });
}

if(localMuteBtn) {
    localMuteBtn.addEventListener("click", () => {
        isLocallyMuted = !isLocallyMuted;
        localMuteBtn.classList.toggle("muted", isLocallyMuted);

        if (isLocallyMuted) {
            localMuteBtn.textContent = "🔇";
            localMuteBtn.setAttribute("aria-label", "取消靜音");
        } else {
            localMuteBtn.textContent = "🔈";
            localMuteBtn.setAttribute("aria-label", "靜音");
            
            // 【新】 在取消靜音時，順便嘗試取得權限
            // (如果尚未取得權限，這就是一個很好的互動時機)
            if (!audioPermissionGranted) {
                playNotificationSound();
            }
        }
    });
}

// 首次載入時，嘗試自動播放以取得權限
// (如果失敗，playNotificationSound 內部會處理提示的顯示)
playNotificationSound();
