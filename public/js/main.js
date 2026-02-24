/* ==========================================
 * 前台邏輯 (main.js) - Refactored, Fixed HH:MM & Decoupled MAX
 * ========================================== */
const d = document, ls = localStorage, $ = i => d.getElementById(i), $$ = s => d.querySelectorAll(s);
const on = (e, ev, fn) => e?.addEventListener(ev, fn), show = (e, v) => e && (e.style.display = v ? 'block' : 'none');
const i18n={"zh-TW":{cur:"目前叫號",iss:"已發至",online:"線上取號",help:"免排隊，手機領號",man_t:"號碼提醒",man_p:"輸入您的號碼開啟到號提醒",take:"立即取號",track:"追蹤",my:"我的號碼",ahead:"前方",wait:"⏳ 剩 %s 組",arr:"🎉 輪到您了！",pass:"⚠️ 已過號",p_list:"過號",none:"無",links:"精選連結",copy:"複製",sound:"音效",s_on:"開啟",s_off:"靜音",scan:"掃描追蹤",off:"連線中斷",ok:"取號成功",fail:"失敗",no_in:"請輸入號碼",cancel:"取消追蹤？",copied:"已複製",notice:"📢 ",q_left:"還剩 %s 組！",est:"約 %s 分",est_less:"< 1 分",just:"剛剛",ago:"%s 分前",conn:"已連線",retry:"連線中 (%s)...",wait_count:"等待中",sys_close:"⛔ 系統已暫停服務",sys_close_desc:"請稍候，我們將很快回來"},"en":{cur:"Now Serving",iss:"Issued",online:"Get Ticket",help:"Digital ticket & notify",man_t:"Number Alert",man_p:"Enter number to get alerted",take:"Get Ticket",track:"Track",my:"Your #",ahead:"Ahead",wait:"⏳ %s groups",arr:"🎉 Your Turn!",pass:"⚠️ Passed",p_list:"Passed",none:"None",links:"Links",copy:"Copy",sound:"Sound",s_on:"On",s_off:"Mute",scan:"Scan",off:"Offline",ok:"Success",fail:"Failed",no_in:"Enter #",cancel:"Stop tracking?",copied:"Copied",notice:"📢 ",q_left:"%s groups left!",est:"~%s min",est_less:"< 1 min",just:"Now",ago:"%s m ago",conn:"Online",retry:"Retry (%s)...",wait_count:"Waiting",sys_close:"⛔ System Paused",sys_close_desc:"Please wait, we will be back soon"}};

// 引入 currentMax 以記錄系統真實進度
let lang = ls.getItem('callsys_lang')||'zh-TW', T = i18n[lang], myTicket = ls.getItem('callsys_ticket'), sysMode = 'ticketing', allowTicketing = true, currentMax = 0;
let sndEnabled = true, localMute = false, avgTime = 0, lastUpd, audioCtx, wakeLock, connTimer, cachedMode, cachedPublic;
let isDarkMode = ls.getItem('callsys_theme') === 'dark', isKioskMode = () => new URLSearchParams(window.location.search).get('mode')==='kiosk';

const socket = io({ autoConnect: false, reconnection: true });

// --- Helpers ---
const toast = (msg, type='info') => {
    const c = $('toast-container') || d.body.appendChild(Object.assign(d.createElement('div'),{id:'toast-container'}));
    const el = c.appendChild(Object.assign(d.createElement('div'), {className:`toast-message ${type} show`, textContent:msg}));
    navigator.vibrate?.(50); setTimeout(() => { el.classList.remove('show'); setTimeout(()=>el.remove(), 300); }, 3000);
};

const toggleWakeLock = async (act) => {
    if(!('wakeLock' in navigator)) return;
    try { 
        if(act && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock=null; if(d.visibilityState==='visible' && (myTicket||isKioskMode())) toggleWakeLock(true); }); }
        else if(!act && wakeLock) { await wakeLock.release(); wakeLock=null; }
    } catch(e){}
};

const unlockAudio = () => {
    if(!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(audioCtx.state === 'suspended') audioCtx.resume().then(()=>updateMuteUI(false));
    const src = audioCtx.createBufferSource(); src.buffer = audioCtx.createBuffer(1, 1, 22050); src.connect(audioCtx.destination); src.start(0);
    if($("notify-sound")) $("notify-sound").load();
};

const speak = (txt) => {
    if(!localMute && sndEnabled && window.speechSynthesis) {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(txt), v = window.speechSynthesis.getVoices();
        u.voice = v.find(x => x.lang==='zh-TW'||x.lang==='zh_TW') || v.find(x => x.lang.includes('zh'));
        u.lang = 'zh-TW'; window.speechSynthesis.speak(u);
    }
};
const playDing = () => { const s=$("notify-sound"); if(s && !localMute) { s.currentTime=0; s.play().then(()=>updateMuteUI(false)).catch(()=>updateMuteUI(true,true)); }};

// --- UI Logic ---
const applyTheme = () => { d.body.classList.toggle('dark-mode', isDarkMode); if($('theme-toggle')) $('theme-toggle').textContent=isDarkMode?'☀️':'🌙'; ls.setItem('callsys_theme', isDarkMode?'dark':'light'); };
const applyText = () => {
    const map={current_number:'cur', issued_number:'iss', online_ticket_title:'online', help_take_ticket:'help', manual_input_title:'man_t', take_ticket:'take', set_reminder:'track', my_number:'my', wait_count:'wait_count', passed_list_title:'p_list', passed_empty:'none', links_title:'links', copy_link:'copy', sound_enable:'sound', scan_qr:'scan'};
    $$('[data-i18n]').forEach(e => { const k=map[e.dataset.i18n]; if(T[k]) e.textContent=T[k]; });
    if($("manual-ticket-input")) $("manual-ticket-input").placeholder=T.man_p;
    $$("#hero-waiting-count, #ticket-waiting-count").forEach(e => e.previousElementSibling && (e.previousElementSibling.textContent = e.id.includes('hero') ? T.wait_count : T.ahead));
    if($("overlay-title")) $("overlay-title").textContent=T.sys_close; if($("overlay-desc")) $("overlay-desc").textContent=T.sys_close_desc;
};

const renderMode = () => {
    const isT = sysMode==='ticketing', hasT = !!myTicket;
    show($("ticketing-mode-container"), isT && !hasT && allowTicketing);
    show($("input-mode-container"), !isT && !hasT && allowTicketing);
    show($("my-ticket-view"), hasT);
    
    let msgEl = $("ticketing-closed-msg");
    if (!msgEl) {
        msgEl = d.createElement('div');
        msgEl.id = "ticketing-closed-msg";
        msgEl.className = "action-header";
        msgEl.innerHTML = `<h3 style="text-align:center; color: var(--warning); margin-bottom: 15px;">暫停取號</h3><p class="func-desc" style="text-align:center;">目前暫不開放線上取號與追蹤</p>`;
        $("ticketing-mode-container").parentNode.insertBefore(msgEl, $("my-ticket-view"));
    }
    show(msgEl, !hasT && !allowTicketing);

    if(hasT) { $("my-ticket-num").textContent=myTicket; updateTicket(parseInt($("number").textContent)||0); toggleWakeLock(true); } else if(!isKioskMode()) toggleWakeLock(false);
};

// 導入 MAX 進度機制，避免過號重呼時等待人數錯亂
const updateTicket = (curr) => {
    if (!myTicket) return;
    const wEl = $("ticket-wait-time");
    let diff;
    if (myTicket === curr) diff = 0; // 剛好叫到我 (包含正常叫號與重呼)
    else if (myTicket <= currentMax) diff = -1; // 我的號碼比系統最大進度小，且現在不是叫我 -> 已過號
    else diff = myTicket - currentMax; // 還沒輪到我，前方等待人數以「最大進度」為基準

    $("ticket-waiting-count").textContent = diff > 0 ? diff : (diff===0?"0":"-");
    $("ticket-status-text").textContent = diff > 0 ? T.wait.replace("%s",diff) : (diff===0?T.arr:T.pass);
    
    if(diff > 0 && avgTime >= 0) {
        const min = Math.ceil(diff * avgTime), tStr = new Date(Date.now()+min*60000).toLocaleTimeString('zh-TW',{hour:'2-digit',minute:'2-digit',hour12:false});
        wEl.innerHTML = `${(min<=1)?T.est_less:T.est.replace("%s",min)}<br><small style="opacity:0.8;font-size:0.8em">預計 ${tStr} 到號</small>`; show(wEl, true);
    } else show(wEl, false);
    
    if(diff===0) { window.confetti?.({particleCount:100, spread:70, origin:{y:0.6}}); navigator.vibrate?.([200,100,200]); }
    if(diff<=3 && diff>0 && d.hidden && Notification.permission==="granted") new Notification("Queue", {body:T.q_left.replace("%s",diff)});
};

const updateMuteUI = (mute, force) => {
    localMute = mute; const b = $("sound-prompt"); if(!b) return;
    b.children[0].textContent=(force||mute)?'🔇':'🔊'; b.children[1].textContent=(force||mute)?T.s_off:T.s_on; b.classList.toggle("is-active", !force && !mute);
};
const updTime = () => { if(lastUpd) { const m=Math.floor((new Date()-lastUpd)/60000); $("last-updated").textContent = m<1?T.just:T.ago.replace("%s",m); }};

// --- Socket & Init ---
socket.on("connect", () => { socket.emit('joinRoom', 'public'); clearTimeout(connTimer); $("status-bar").textContent=T.conn; $("status-bar").classList.remove("visible"); })
    .on("disconnect", () => connTimer=setTimeout(()=>{$("status-bar").textContent=T.off; $("status-bar").classList.add("visible");}, 1000))
    .on("reconnect_attempt", a => $("status-bar").textContent = T.retry.replace("%s",a))
    .on("updateQueue", d => {
        currentMax = d.max || d.current; // 同步後端傳來的 MAX 進度
        if($("issued-number-main")) $("issued-number-main").textContent = d.issued;
        if($("hero-waiting-count")) $("hero-waiting-count").textContent = Math.max(0, d.issued - currentMax);
        
        if(myTicket && ((d.issued===0 && myTicket>5) || (myTicket < d.current-20))) { ls.removeItem('callsys_ticket'); myTicket=null; renderMode(); if($("btn-take-ticket")) { $("btn-take-ticket").disabled=false; $("btn-take-ticket").textContent=T.take; } toast("票號已過期或系統重置", "info"); }
        const el = $("number");
        if(el.textContent !== String(d.current)) {
            playDing(); setTimeout(()=>speak(`現在號碼，${d.current}號`), 800);
            el.classList.remove("number-change-anim"); void el.offsetWidth; el.classList.add("number-change-anim");
            el.textContent = d.current; d.title = `${d.current} - Queue`;
        }
        updateTicket(d.current);
    })
    .on("adminBroadcast", m => { if(!localMute) speak(m); toast(T.notice+m, 'info'); })
    .on("updateWaitTime", t => { avgTime = t; updateTicket(parseInt($("number").textContent)||0); })
    .on("updateSoundSetting", b => sndEnabled = b)
    .on("updatePublicStatus", b => { 
        if(cachedPublic !== (b?'1':'0')) { ls.setItem('callsys_public_cache', cachedPublic = b?'1':'0'); }
        let ov = $("closed-overlay");
        if(!ov) { ov=d.body.appendChild(Object.assign(d.createElement('div'),{id:"closed-overlay",innerHTML:`<div style="text-align:center;"><div style="font-size:4rem;">⛔</div><h2 id="overlay-title" style="margin:20px 0 10px;font-weight:900;">${T.sys_close}</h2><p id="overlay-desc" style="opacity:0.8;">${T.sys_close_desc}</p></div>`})); Object.assign(ov.style,{position:'fixed',inset:0,background:'var(--bg-body)',zIndex:9998,display:'none',justifyContent:'center',alignItems:'center',flexDirection:'column'}); }
        ov.style.display = !b ? 'flex' : 'none';
    })
    .on("updateTicketingEnabled", b => { allowTicketing = b; renderMode(); })
    .on("updateSystemMode", m => { if(cachedMode!==m) ls.setItem('callsys_mode_cache', cachedMode=sysMode=m); renderMode(); })
    .on("updatePassed", l => { 
        const ul=$("passedList"), mt=$("passed-empty-msg"), len = l?.length||0; 
        if($("passed-count")) $("passed-count").textContent=len;
        show(ul, len); show(mt, !len); 
        ul.innerHTML = len ? l.map(n=>`<li>${n}</li>`).join("") : ""; 
    })
    .on("updateFeaturedContents", l => $("featured-container") && ($("featured-container").innerHTML = l.map(c=>`<a class="link-chip" href="${c.linkUrl}" target="_blank">${c.linkText}</a>`).join("")))
    .on("updateTimestamp", ts => { lastUpd = new Date(ts); updTime(); })
    .on("updateBusinessHours", h => {
        const el = $("business-hours-badge");
        if(el) {
            if (h && h.enabled) {
                el.style.display = "inline-flex";
                el.innerHTML = `<span>🕒</span> ${h.start} - ${h.end}`;
            } else {
                el.style.display = "none";
            }
        }
    });

setInterval(updTime, 10000); d.addEventListener('visibilitychange', () => d.visibilityState==='visible'&&(myTicket||isKioskMode())&&toggleWakeLock(true));

d.addEventListener("DOMContentLoaded", () => {
    if(isKioskMode()) { d.body.classList.add('kiosk-mode'); toggleWakeLock(true); }
    if($("language-selector")) $("language-selector").value = lang;
    applyTheme(); applyText(); renderMode(); socket.connect();

    const unlock = () => { unlockAudio(); d.body.removeEventListener('click', unlock); }; d.body.addEventListener('click', unlock);
    if($("qr-code-placeholder")) try{ new QRCode($("qr-code-placeholder"), {text:location.href, width:120, height:120}); }catch(e){}

    on($("btn-take-ticket"), "click", async function() {
        if(this.disabled || ls.getItem('callsys_ticket')) return toast(ls.getItem('callsys_ticket')?"您已有號碼":"Wait", "error");
        unlockAudio(); if(Notification.permission!=='granted') Notification.requestPermission();
        this.disabled = true; const txt = this.textContent; this.textContent = "處理中...";
        try { 
            const r = await fetch("/api/ticket/take", {method:"POST"}).then(d=>d.json());
            if(r.success) { myTicket=r.ticket; ls.setItem('callsys_ticket', myTicket); renderMode(); toast(T.ok, "success"); } 
            else { toast(r.error||T.fail, "error"); this.disabled = false; this.textContent = txt; }
        } catch(e) { toast(T.off, "error"); this.disabled = false; this.textContent = txt; }
    });
    on($("btn-track-ticket"), "click", () => {
        unlockAudio(); const v=$("manual-ticket-input").value; if(!v) return toast(T.no_in, "error");
        if(Notification.permission!=='granted') Notification.requestPermission(); ls.setItem('callsys_ticket', myTicket=parseInt(v)); $("manual-ticket-input").value=""; renderMode();
    });
    on($("btn-cancel-ticket"), "click", () => { if(confirm(T.cancel)) { ls.removeItem('callsys_ticket'); myTicket=null; renderMode(); $("btn-take-ticket").disabled=false; $("btn-take-ticket").textContent=T.take; }});
    on($("sound-prompt"), "click", () => { unlockAudio(); updateMuteUI(!localMute); });
    on($("copy-link-prompt"), "click", () => navigator.clipboard?.writeText(location.href).then(() => {
        const b=$("copy-link-prompt"), i=b.children[0], t=b.children[1], oi=i.textContent, ot=t.textContent;
        b.classList.add('is-feedback'); i.textContent='✔'; t.textContent=T.copied; setTimeout(()=>{b.classList.remove('is-feedback'); i.textContent=oi; t.textContent=ot;},1500);
    }));
    on($("language-selector"), "change", e => { lang=e.target.value; ls.setItem('callsys_lang', lang); T=i18n[lang]; applyText(); renderMode(); updateMuteUI(localMute); updTime(); });
    on($("theme-toggle"), "click", () => { isDarkMode=!isDarkMode; applyTheme(); });
});
