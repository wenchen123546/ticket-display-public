/* 設定與常數：環境變數、Redis key、角色與 LINE 預設值 (需在 dotenv 載入後才 require) */
const { PORT = 3000, UPSTASH_REDIS_URL: REDIS_URL, ADMIN_TOKEN, LINE_ACCESS_TOKEN: LAT, LINE_CHANNEL_SECRET: LCS, ALLOWED_ORIGINS } = process.env;

const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_TTL = 28800, TICKET_TTL = 43200, APPROACH_DIFF = 5;
// 叫號明細保留 180 天；已完成 / 取消的預約 (含客人手機) 在時段過後 30 天刪除；報表一次最多查 92 天
const HIST_TTL = 180 * 86400, APPT_KEEP_MS = 30 * 86400000, MAX_REPORT_DAYS = 92;

const DEFAULT_ROLES = {
    OPERATOR: { level: 1, can: ['perm_command', 'perm_issue', 'perm_passed_view', 'perm_passed_edit', 'perm_booking_view'] },
    MANAGER: { level: 2, can: ['perm_command', 'perm_issue', 'perm_passed_view', 'perm_passed_edit', 'perm_booking_view', 'perm_booking_edit', 'perm_stats_view', 'perm_logs_view', 'perm_system_view', 'perm_links_view', 'perm_links_edit', 'perm_online_view', 'perm_users_view'] },
    ADMIN: { level: 9, can: ['*'] }
};
const VALID_ROLES = ['OPERATOR', 'MANAGER', 'ADMIN'], DEFAULT_HOURS = { enabled: false, start: "08:00", end: "22:00" };
const FRONTEND_TEXT_KEYS = ['brand_title', 'cur', 'iss', 'wait_count', 'online', 'help', 'take', 'man_t', 'man_p', 'track', 'recall_badge', 'sys_close', 'sys_close_desc', 'counter_to'];
// 只計算「往前推進」的動作 (一般叫號、叫預約、過號) 來估算等待時間
const ADVANCE_ACTIONS = ['call', 'call_appt', 'pass'];

const KEYS = {
    CURRENT: 'callsys:number', MAX: 'callsys:max', ISSUED: 'callsys:issued', MODE: 'callsys:mode', PASSED: 'callsys:passed', PASSED_BACK: 'callsys:passed:back', FEATURED: 'callsys:featured', LOGS: 'callsys:admin-log',
    USERS: 'callsys:users', NICKS: 'callsys:nicknames', USER_ROLES: 'callsys:user_roles', SESSION: 'callsys:session:', HOURLY: 'callsys:stats:hourly:', HIST: 'callsys:hist:',
    ROLES: 'callsys:config:roles', HOURS: 'callsys:config:hours', FRONTEND_TEXTS: 'callsys:config:frontend_texts', PAUSE: 'callsys:config:pause',
    CANCELLED: 'callsys:cancelled', COUNTER: 'callsys:counter', RECENT: 'callsys:recent', TICKET: 'callsys:ticket:', EPOCH: 'callsys:epoch', APPROACHED: 'callsys:notify:approached',
    APPT: { SEQ: 'callsys:appt:seq', DATA: 'callsys:appt:data', STATUS: 'callsys:appt:status' },
    BOOKING: { CFG: 'callsys:config:booking', TOKEN: 'callsys:booking:token:', SLOT: 'callsys:booking:slot:', NUM: 'callsys:booking:num:' },
    PUSH: { VAPID: 'callsys:push:vapid', SUB: 'callsys:push:sub:', EP: 'callsys:push:ep:', ACTIVE: 'callsys:push:active' },
    LINE: {
        SUB: 'callsys:line:notify:', USER: 'callsys:line:user:', PWD: 'callsys:line:unlock_pwd', ADMIN: 'callsys:line:admin_session:', CTX: 'callsys:line:context:', ACTIVE: 'callsys:line:active_subs_set',
        CFG_TOKEN: 'callsys:line:cfg:token', CFG_SECRET: 'callsys:line:cfg:secret',
        MSG: { APPROACH: 'callsys:line:msg:approach', ARRIVAL: 'callsys:line:msg:arrival', SUCCESS: 'callsys:line:msg:success', PASSED: 'callsys:line:msg:passed', CANCEL: 'callsys:line:msg:cancel', DEFAULT: 'callsys:line:msg:default', HELP: 'callsys:line:msg:help', LOGIN_PROMPT: 'callsys:line:msg:login_prompt', LOGIN_SUCCESS: 'callsys:line:msg:login_success', NO_TRACKING: 'callsys:line:msg:no_tracking', NO_PASSED: 'callsys:line:msg:no_passed', PASSED_PREFIX: 'callsys:line:msg:passed_prefix' },
        CMD: { LOGIN: 'callsys:line:cmd:login', STATUS: 'callsys:line:cmd:status', CANCEL: 'callsys:line:cmd:cancel', PASSED: 'callsys:line:cmd:passed', HELP: 'callsys:line:cmd:help' },
        AUTOREPLY: 'callsys:line:autoreply_rules'
    }
};
const S_KEYS = { SOUND: 'callsys:soundEnabled', PUBLIC: 'callsys:isPublic', ALLOW_T: 'callsys:allowTicketing' };

// LINE 訊息 / 指令欄位與預設值 (callback、get、save 共用，避免三處預設值不一致)
const LINE_MSG_FIELDS = { approach: 'APPROACH', arrival: 'ARRIVAL', success: 'SUCCESS', passed: 'PASSED', cancel: 'CANCEL', help: 'HELP', loginPrompt: 'LOGIN_PROMPT', loginSuccess: 'LOGIN_SUCCESS', noTracking: 'NO_TRACKING', noPassed: 'NO_PASSED', passedPrefix: 'PASSED_PREFIX' };
const LINE_MSG_DEFAULTS = { approach: '🔔 {target}號快到了 (前方剩{diff}組)', arrival: '🎉 {current}號 到您了！請前往{counter}', success: '設定成功: {number}號', passed: '已過號', cancel: '已取消', help: '💡 請輸入數字', loginPrompt: '請輸入密碼', loginSuccess: '🔓 驗證成功', noTracking: '無追蹤', noPassed: '無過號', passedPrefix: '⚠️ 過號：' };
const LINE_CMD_DEFAULTS = { login: '後台登入', status: 'status,?,查詢,查詢進度', cancel: 'cancel,取消,取消提醒', passed: 'passed,過號,過號名單', help: 'help,提醒,設定提醒' };

module.exports = {
    PORT, REDIS_URL, ADMIN_TOKEN, LAT, LCS, ALLOWED_ORIGINS, IS_PROD,
    SESSION_TTL, TICKET_TTL, APPROACH_DIFF, HIST_TTL, APPT_KEEP_MS, MAX_REPORT_DAYS,
    DEFAULT_ROLES, VALID_ROLES, DEFAULT_HOURS, FRONTEND_TEXT_KEYS, ADVANCE_ACTIONS,
    KEYS, S_KEYS, LINE_MSG_FIELDS, LINE_MSG_DEFAULTS, LINE_CMD_DEFAULTS
};
