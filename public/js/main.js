/* ==========================================
 * 前台邏輯 (main.js) - Refactored, Fixed HH:MM, Decoupled MAX & Custom Texts
 * ========================================== */
const d = document, ls = localStorage, $ = i => d.getElementById(i), $$ = s => d.querySelectorAll(s);
const on = (e, ev, fn) => e?.addEventListener(ev, fn), show = (e, v) => e && (e.style.display = v ? 'block' : 'none');
const el = (tag, props = {}, ...children) => { const e = Object.assign(d.createElement(tag), props); children.forEach(c => c != null && e.append(c)); return e; };

// 增加 brand_title 預設字典
const i18n={"zh-TW":{brand_title:"即時叫號系統",cur:"目前叫號",iss:"已發至",online:"線上取號",help:"免排隊，手機領號",man_t:"號碼提醒",man_p:"輸入您的號碼開啟到號提醒",take:"立即取號",track:"追蹤",my:"我的號碼",ahead:"前方",wait:"⏳ 剩 %s 組",arr:"🎉 輪到您了！",pass:"⚠️ 已過號",p_list:"過號",none:"無",links:"精選連結",copy:"複製",sound:"音效",s_on:"開啟",s_off:"靜音",scan:"掃描追蹤",off:"連線中斷",ok:"取號成功",fail:"失敗",no_in:"請輸入號碼",cancel:"取消追蹤？",copied:"已複製",notice:"📢 ",q_left:"還剩 %s 組！",est:"約 %s 分",est_less:"< 1 分",est_at:"預計 %s 到號",just:"剛剛",ago:"%s 分前",conn:"已連線",retry:"連線中 (%s)...",wait_count:"等待中",sys_close:"⛔ 系統已暫停服務",sys_close_desc:"請稍候，我們將很快回來",recall_badge:"↩️ 過號重呼"},"en":{brand_title:"Queue System",cur:"Now Serving",iss:"Issued",online:"Get Ticket",help:"Digital ticket & notify",man_t:"Number Alert",man_p:"Enter number to get alerted",take:"Get Ticket",track:"Track",my:"Your #",ahead:"Ahead",wait:"⏳ %s groups",arr:"🎉 Your Turn!",pass:"⚠️ Passed",p_list:"Passed",none:"None",links:"Links",copy:"Copy",sound:"Sound",s_on:"On",s_off:"Mute",scan:"Scan",off:"Offline",ok:"Success",fail:"Failed",no_in:"Enter #",cancel:"Stop tracking?",copied:"Copied",notice:"📢 ",q_left:"%s groups left!",est:"~%s min",est_less:"< 1 min",est_at:"ETA %s",just:"Now",ago:"%s m ago",conn:"Online",retry:"Retry (%s)...",wait_count:"Waiting",sys_close:"⛔ System Paused",sys_close_desc:"Please wait, we will be back soon",recall_badge:"↩️ Recalled"}};

// localStorage 取出的是字串，必須轉成數字，否則 myTicket === curr 永遠不成立 (重新整理後不會顯示「輪到您了」)
const loadTicket = () => { const n = parseInt(ls.getItem('callsys_ticket'), 10); return n > 0 ? n : null; };
let lang = ls.getItem('callsys_lang')||'zh-TW', T = i18n[lang]||i18n["zh-TW"], myTicket = loadTicket(), sysMode = 'ticketing', allowTicketing = true, currentMax = 0;
let sndEnabled = true, localMute = false, avgTime = 0, lastUpd, audioCtx, wakeLock, connTimer, cachedMode, cachedPublic, lastDiff = null, firstQueue = true;
let isDarkMode = ls.getItem('callsys_theme') === 'dark', isKioskMode = () => new URLSearchParams(window.location.search).get('mode')==='kiosk';

// 用於儲存後台傳來的自定義文字
let customTexts = {};
// 取得當前應顯示的文字 (若有自定義則覆蓋預設)
const gt = (k) => customTexts[k] || T[k];

const socket = io({ autoConnect: false, reconnection: true });

// --- Helpers ---
const toast = (msg, type='info') => {
    const c = $('toast-container') || d.body.appendChild(el('div', {id:'toast-container'}));
    const t = c.appendChild(el('div', {className:`toast-message ${type} show`, textContent:msg}));
    navigator.vibrate?.(50); setTimeout(() => { t.classList.remove('show'); setTimeout(()=>t.remove(), 300); }, 3000);
};

// iOS Safari (未加入主畫面) 沒有 Notification 物件，直接存取會拋錯導致取號按鈕失效
const hasNotify = () => 'Notification' in window;
const askNotify = () => { try { if(hasNotify() && Notification.permission === 'default') Notification.requestPermission()?.catch?.(()=>{}); } catch(e){} };

const toggleWakeLock = async (act) => {
    if(!('wakeLock' in navigator)) return;
    try {
        if(act && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock=null; if(d.visibilityState==='visible' && (myTicket||isKioskMode())) toggleWakeLock(true); }); }
        else if(!act && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
    } catch(e){}
};

const unlockAudio = () => {
    try {
        if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
        if(audioCtx.state === 'suspended') audioCtx.resume().then(()=>updateMuteUI(false));
        const src = audioCtx.createBufferSource(); src.buffer = audioCtx.createBuffer(1, 1, 22050); src.connect(audioCtx.destination); src.start(0);
    } catch(e){}
    if($("notify-sound")) $("notify-sound").load();
};

const speak = (txt) => {
    if(!localMute && sndEnabled && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(txt), v = window.speechSynthesis.getVoices();
        u.voice = v.find(x => x.lang==='zh-TW'||x.lang==='zh_TW') || v.find(x => x.lang.includes('zh')) || null;
        u.lang = 'zh-TW'; window.speechSynthesis.speak(u);
    }
};
const playDing = () => { const s=$("notify-sound"); if(s && !localMute) { s.currentTime=0; s.play().then(()=>updateMuteUI(false)).catch(()=>updateMuteUI(true,true)); }};

// --- UI Logic ---
const applyTheme = () => { d.body.classList.toggle('dark-mode', isDarkMode); if($('theme-toggle')) $('theme-toggle').textContent=isDarkMode?'☀️':'🌙'; ls.setItem('callsys_theme', isDarkMode?'dark':'light'); };

// 以 DOM 建立按鈕內容，避免自定義文字被當成 HTML 執行
const renderTakeBtn = () => { const b = $("btn-take-ticket"); if(b) b.replaceChildren(el('span', {textContent: gt('take')}), ' ', el('span', {className: 'btn-arrow', textContent: '➔'})); };
const resetTakeBtn = () => { const b = $("btn-take-ticket"); if(b) { b.disabled = false; renderTakeBtn(); } };
const clearTicket = () => { ls.removeItem('callsys_ticket'); myTicket = null; lastDiff = null; renderMode(); resetTakeBtn(); };

const applyText = () => {
    const map={brand_title:'brand_title', current_number:'cur', issued_number:'iss', online_ticket_title:'online', help_take_ticket:'help', manual_input_title:'man_t', take_ticket:'take', set_reminder:'track', my_number:'my', wait_count:'wait_count', passed_list_title:'p_list', passed_empty:'none', links_title:'links', copy_link:'copy', sound_enable:'sound', scan_qr:'scan', recall_badge:'recall_badge'};
    $$('[data-i18n]').forEach(e => { const k=map[e.dataset.i18n]; if(gt(k)) e.textContent=gt(k); });
    if($("manual-ticket-input")) $("manual-ticket-input").placeholder=gt('man_p');
    $$("#hero-waiting-count, #ticket-waiting-count").forEach(e => e.previousElementSibling && (e.previousElementSibling.textContent = e.id.includes('hero') ? gt('wait_count') : gt('ahead')));
    if($("overlay-title")) $("overlay-title").textContent=gt('sys_close'); if($("overlay-desc")) $("overlay-desc").textContent=gt('sys_close_desc');
    if(!$("btn-take-ticket")?.disabled) renderTakeBtn();
};

const renderMode = () => {
    const isT = sysMode==='ticketing', hasT = !!myTicket;
    show($("ticketing-mode-container"), isT && !hasT && allowTicketing);
    show($("input-mode-container"), !isT && !hasT && allowTicketing);
    show($("my-ticket-view"), hasT);

    const controlBody = d.querySelector('.control-body');
    if (controlBody) show(controlBody, hasT || allowTicketing);

    if(hasT) { $("my-ticket-num").textContent=myTicket; updateTicket(parseInt($("number").textContent)||0); toggleWakeLock(true); } else if(!isKioskMode()) toggleWakeLock(false);
};

const updateTicket = (curr) => {
    if (!myTicket) return;
    const wEl = $("ticket-wait-time");
    let diff;
    if (myTicket === curr) diff = 0;
    else if (myTicket <= currentMax) diff = -1;
    else diff = myTicket - currentMax;

    $("ticket-waiting-count").textContent = diff > 0 ? diff : (diff===0?"0":"-");
    $("ticket-status-text").textContent = diff > 0 ? gt('wait').replace("%s",diff) : (diff===0?gt('arr'):gt('pass'));

    // avgTime 為 0 代表尚無足夠資料，不顯示估計時間 (避免誤導顯示「< 1 分」)
    if(diff > 0 && avgTime > 0) {
        const min = Math.ceil(diff * avgTime), tStr = new Date(Date.now()+min*60000).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});
        wEl.replaceChildren((min<=1)?gt('est_less'):gt('est').replace("%s",min), el('br'), el('small', {style:'opacity:0.8;font-size:0.8em', textContent: gt('est_at').replace("%s", tStr)})); show(wEl, true);
    } else show(wEl, false);

    // 只在狀態改變時觸發特效 / 通知，避免每次廣播 (等待時間、語言切換) 重複放彩帶與推播
    if(diff === lastDiff) return;
    lastDiff = diff;
    if(diff===0) { window.confetti?.({particleCount:100, spread:70, origin:{y:0.6}}); navigator.vibrate?.([200,100,200]); }
    if(diff<=3 && diff>0 && d.hidden && hasNotify() && Notification.permission==="granted") { try { new Notification("Queue", {body:gt('q_left').replace("%s",diff)}); } catch(e){} }
};

const updateMuteUI = (mute, force) => {
    localMute = mute; const b = $("sound-prompt"); if(!b) return;
    b.children[0].textContent=(force||mute)?'🔇':'🔊'; b.children[1].textContent=(force||mute)?gt('s_off'):gt('s_on'); b.classList.toggle("is-active", !force && !mute);
};
const updTime = () => { if(lastUpd) { const m=Math.floor((new Date()-lastUpd)/60000); $("last-updated").textContent = m<1?gt('just'):gt('ago').replace("%s",m); }};

// --- Socket & Init ---
socket.on("connect", () => { clearTimeout(connTimer); $("status-bar").textContent=gt('conn'); $("status-bar").classList.remove("visible"); })
    .on("disconnect", () => connTimer=setTimeout(()=>{$("status-bar").textContent=gt('off'); $("status-bar").classList.add("visible");}, 1000))
    .on("reconnect_attempt", a => $("status-bar").textContent = gt('retry').replace("%s",a))
    .on("updateFrontendTexts", t => { customTexts = t || {}; applyText(); renderMode(); })
    .on("updateQueue", q => {
        currentMax = q.max || q.current;
        if($("issued-number-main")) $("issued-number-main").textContent = q.issued;
        if($("hero-waiting-count")) $("hero-waiting-count").textContent = Math.max(0, q.issued - currentMax);

        const isRecall = (q.current > 0 && q.current < currentMax);
        if($("recall-badge")) $("recall-badge").style.display = isRecall ? "inline-block" : "none";

        if(myTicket && ((q.issued===0 && myTicket>5) || (myTicket < q.current-20))) { clearTicket(); toast("票號已過期或系統重置", "info"); }
        const n = $("number");
        if(n.textContent !== String(q.current)) {
            // 首次連線只同步畫面，不播放提示音 / 語音
            if(!firstQueue) { playDing(); setTimeout(()=>speak(`現在號碼，${q.current}號`), 800); }
            n.classList.remove("number-change-anim"); void n.offsetWidth; n.classList.add("number-change-anim");
            n.textContent = q.current; document.title = `${q.current} - Queue`;
        }
        firstQueue = false;
        updateTicket(q.current);
    })
    .on("adminBroadcast", m => { if(!localMute) speak(m); toast(gt('notice')+m, 'info'); })
    .on("updateWaitTime", t => { avgTime = t; updateTicket(parseInt($("number").textContent)||0); })
    .on("updateSoundSetting", b => sndEnabled = b)
    .on("updatePublicStatus", b => {
        if(cachedPublic !== (b?'1':'0')) { ls.setItem('callsys_public_cache', cachedPublic = b?'1':'0'); }
        let ov = $("closed-overlay");
        if(!ov) {
            ov = d.body.appendChild(el('div', {id:"closed-overlay"}, el('div', {style:'text-align:center;'},
                el('div', {style:'font-size:4rem;', textContent:'⛔'}),
                el('h2', {id:'overlay-title', style:'margin:20px 0 10px;font-weight:900;', textContent:gt('sys_close')}),
                el('p', {id:'overlay-desc', style:'opacity:0.8;', textContent:gt('sys_close_desc')}))));
            Object.assign(ov.style,{position:'fixed',inset:0,background:'var(--bg-body)',zIndex:9998,display:'none',justifyContent:'center',alignItems:'center',flexDirection:'column'});
        }
        ov.style.display = !b ? 'flex' : 'none';
    })
    .on("updateTicketingEnabled", b => { allowTicketing = b; renderMode(); })
    .on("updateSystemMode", m => { if(cachedMode!==m) ls.setItem('callsys_mode_cache', cachedMode=sysMode=m); renderMode(); })
    .on("updatePassed", l => {
        const ul=$("passedList"), mt=$("passed-empty-msg"), len = l?.length||0;
        if($("passed-count")) $("passed-count").textContent=len;
        show(ul, len); show(mt, !len);
        ul.replaceChildren(...(l||[]).map(n => el('li', {textContent: n})));
    })
    .on("updateFeaturedContents", l => {
        const ct = $("featured-container"); if(!ct) return;
        const safe = u => { try { return ['http:','https:'].includes(new URL(u, location.href).protocol); } catch(e) { return false; } };
        ct.replaceChildren(...(l||[]).filter(c => c && safe(c.linkUrl)).map(c => el('a', {className:'link-chip', href:c.linkUrl, target:'_blank', rel:'noopener noreferrer', textContent:c.linkText})));
    })
    .on("updateTimestamp", ts => { lastUpd = new Date(ts); updTime(); })
    .on("updateBusinessHours", h => {
        const b = $("business-hours-badge"); if(!b) return;
        if (h && h.enabled) { b.style.display = "inline-flex"; b.replaceChildren(el('span', {textContent:'🕒'}), ` ${h.start} - ${h.end}`); }
        else b.style.display = "none";
    });

setInterval(updTime, 10000); d.addEventListener('visibilitychange', () => d.visibilityState==='visible'&&(myTicket||isKioskMode())&&toggleWakeLock(true));

d.addEventListener("DOMContentLoaded", () => {
    if(isKioskMode()) { d.body.classList.add('kiosk-mode'); toggleWakeLock(true); }
    if($("language-selector")) $("language-selector").value = lang;
    applyTheme(); applyText(); renderMode(); socket.connect();

    const unlock = () => { unlockAudio(); d.body.removeEventListener('click', unlock); }; d.body.addEventListener('click', unlock);
    if($("qr-code-placeholder")) try{ new QRCode($("qr-code-placeholder"), {text:location.href, width:120, height:120}); }catch(e){}

    on($("btn-take-ticket"), "click", async function() {
        if(this.disabled || loadTicket()) return toast(loadTicket()?"您已有號碼":"Wait", "error");
        unlockAudio(); askNotify();
        this.disabled = true; this.textContent = "處理中...";
        try {
            const r = await fetch("/api/ticket/take", {method:"POST"}).then(x=>x.json());
            if(r.success) { myTicket=r.ticket; ls.setItem('callsys_ticket', myTicket); lastDiff = null; renderMode(); toast(gt('ok'), "success"); }
            else { toast(r.error||gt('fail'), "error"); resetTakeBtn(); }
        } catch(e) { toast(gt('off'), "error"); resetTakeBtn(); }
    });
    on($("btn-track-ticket"), "click", () => {
        unlockAudio(); const n=parseInt($("manual-ticket-input").value, 10); if(!(n > 0)) return toast(gt('no_in'), "error");
        askNotify(); ls.setItem('callsys_ticket', myTicket=n); lastDiff = null; $("manual-ticket-input").value=""; renderMode();
    });
    on($("btn-cancel-ticket"), "click", () => { if(confirm(gt('cancel'))) clearTicket(); });
    on($("sound-prompt"), "click", () => { unlockAudio(); updateMuteUI(!localMute); });
    on($("copy-link-prompt"), "click", () => navigator.clipboard?.writeText(location.href).then(() => {
        const b=$("copy-link-prompt"), i=b.children[0], t=b.children[1], oi=i.textContent, ot=t.textContent;
        b.classList.add('is-feedback'); i.textContent='✔'; t.textContent=gt('copied'); setTimeout(()=>{b.classList.remove('is-feedback'); i.textContent=oi; t.textContent=ot;},1500);
    }));
    on($("language-selector"), "change", e => { lang=e.target.value; ls.setItem('callsys_lang', lang); T=i18n[lang]||i18n["zh-TW"]; applyText(); renderMode(); updateMuteUI(localMute); updTime(); });
    on($("theme-toggle"), "click", () => { isDarkMode=!isDarkMode; applyTheme(); });
});
