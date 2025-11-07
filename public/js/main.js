// --- 1. Socket.io 初始化 ---
const socket = io();

// --- 2. 元素節點 (DOM) ---
const numberEl =
document.getElementById("number");
const passedListEl =
document.getElementById("passedList");
const featuredContainerEl =
document.getElementById("featured-container");
const statusBar =
document.getElementById("status-bar");
const notifySound =
document.getElementById("notify-sound"); 
const lastUpdatedEl =
document.getElementById("last-updated");
const localMuteBtn =
document.getElementById("local-mute-btn"); 
const featuredEmptyMsg =
document.getElementById("featured-empty-msg");
const passedContainerEl =
document.getElementById("passed-container"); // 【改善】 新增父容器

// --- 3. 前台全域狀態 ---
let isSoundEnabled = true; // 全域開關 (來自伺服器)
let isLocallyMuted = false; // 本機開關
let lastUpdateTime = null; // 時間戳

// --- 4. Socket.io 連線狀態監聽 ---
socket.on("connect", () => {
    console.log("Socket.io 已連接");
    statusBar.classList.remove("visible"); 
});

socket.on("disconnect", () =>
{
    console.log("Socket.io 已斷線");
    statusBar.classList.add("visible"); 
    lastUpdatedEl.textContent = "連線中斷...";
});

// 【改善】增加初始狀態載入錯誤的監聽
socket.on("initialStateError",
(errorMsg) => {
    console.error("無法載入初始狀態:", errorMsg);
    alert(errorMsg); // 提示使用者
    lastUpdatedEl.textContent = "載入失敗";
});


// --- 5. Socket.io 資料更新監聽 ---
socket.on("updateSoundSetting",
(isEnabled) => {
    console.log("音效設定更新:", isEnabled);
    isSoundEnabled = isEnabled;
});

socket.on("updateTimestamp",
(timestamp) => {
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
        setTimeout(() => { numberEl.classList.remove("updated"); },
500);
     }
});

socket.on("updatePassed",
(numbers) => {
    passedListEl.innerHTML = "";
    // const h3 = document.querySelector("#passed-container h3"); // 已不需要手動調整
     
    // 【改善】 使用 classList.toggle 控制空狀態
    const isEmpty = !numbers || numbers.length === 0;
    passedContainerEl.classList.toggle("is-empty", isEmpty);

    if (!isEmpty) {
        // h3.style.marginTop = "25px"; // CSS 已自動處理
        numbers.forEach((num) => {
            const li = document.createElement("li");
            li.textContent = num;
            passedListEl.appendChild(li);
        });
     }
// else { h3.style.marginTop = "0"; } // CSS 已自動處理
});

socket.on("updateFeaturedContents",
(contents) => {
    featuredContainerEl.innerHTML = ""; // 清空
     
    // 【改善】 複製空訊息模板
    const emptyMsgNode = featuredEmptyMsg.cloneNode(true);
    featuredContainerEl.appendChild(emptyMsgNode);

    if (contents && contents.length > 0) {
        let hasVisibleLinks = false; 
        contents.forEach(item => {
            if (item && item.linkText && item.linkUrl) {
                 const a =
document.createElement("a");
                 a.className =
"featured-link";
                 a.target = "_blank";
                 a.href = item.linkUrl;
                 a.textContent = item.linkText;
                featuredContainerEl.appendChild(a); // 在 empty-msg 之後插入
                 hasVisibleLinks = true; 
            }
        });

        // featuredContainerEl.style.display = "flex"; // CSS 已自動處理
        // 【改善】 使用 classList.toggle 控制空狀態
        featuredContainerEl.classList.toggle("is-empty",
!hasVisibleLinks); 

     }
else {
        // featuredContainerEl.style.display = "none"; // CSS 已自動處理
        featuredContainerEl.classList.add("is-empty");
     }
});


/*
 *
=============================================
 * 6.動態 QR Code 產生器 (保持不變)
 *
=============================================
 */
try {
    const qrPlaceholder =
document.getElementById("qr-code-placeholder");
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
    const qrPlaceholder =
document.getElementById("qr-code-placeholder");
    if (qrPlaceholder) { qrPlaceholder.textContent = "QR Code 載入失敗"; }
}

/*
 *
=============================================
 * 7.相對時間自動更新 (保持不變)
 *
=============================================
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
 *
=============================================
 * 8.音效啟用 / 個人靜音
 * (【改善】 移除失效的 audio-prompt 邏輯)
 *
=============================================
 */

// 嘗試自動播放 (若失敗，使用者仍可透過 localMuteBtn 控制)
if (notifySound) {
    notifySound.play().then(() => {
        console.log("音效預載入/自動播放成功。");
    }).catch(e => {
        console.warn("音效自動播放失敗，可能需要使用者互動。");
    });
}

if(localMuteBtn) {
    localMuteBtn.addEventListener("click", () => {
        isLocallyMuted = !isLocallyMuted; // 切換狀態
        localMuteBtn.classList.toggle("muted", isLocallyMuted); // 切換 CSS
        localMuteBtn.textContent = isLocallyMuted ? "🔈" : "🔇";
        // 【改善】 更新 aria-label
        localMuteBtn.setAttribute("aria-label", isLocallyMuted ?
"取消靜音" : "靜音");
    });
}
