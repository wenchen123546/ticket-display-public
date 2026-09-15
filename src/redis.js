/* Redis 連線與原子操作 Lua 腳本 */
const Redis = require("ioredis");
const { REDIS_URL } = require('./config');

// Upstash 必須使用 TLS；其他 redis:// (例如 Render Key Value 內網) 不強制 TLS
const useTLS = REDIS_URL.startsWith('rediss://') || REDIS_URL.includes('upstash.io');
const redis = new Redis(REDIS_URL, { ...(useTLS ? { tls: { rejectUnauthorized: false } } : {}), maxRetriesPerRequest: 3, retryStrategy: t => Math.min(t * 50, 2000) });

// 連線失敗時 ioredis 會持續重試，同一錯誤每分鐘只記錄一次，避免洗版
let lastRedisErr = '', lastRedisErrAt = 0;
redis.on('error', e => {
    if (e.message === lastRedisErr && Date.now() - lastRedisErrAt < 60000) return;
    lastRedisErr = e.message; lastRedisErrAt = Date.now();
    console.error('Redis Error:', e.message, e.code === 'ENOTFOUND' ? '→ 找不到 Redis 主機：請確認 UPSTASH_REDIS_URL 是否正確，或 Upstash 資料庫是否已被刪除' : '');
});

// 每次連上 (含斷線重連) 都執行註冊的初始化，避免啟動時 Redis 不可用導致 LINE 推播永遠未啟用
const readyHandlers = [];
redis.on('ready', () => { lastRedisErr = ''; console.log('✅ Redis Ready'); readyHandlers.forEach(fn => fn()); });
const onRedisReady = fn => readyHandlers.push(fn);

// 一般叫號：從 MAX 往後找第一個不在略過清單 (ARGV：預約保留號 / 客人已取消) 的號碼
redis.defineCommand("safeNextNumber", { numberOfKeys: 3, lua: `local m=tonumber(redis.call("GET",KEYS[1])) local c=tonumber(redis.call("GET",KEYS[2])) or 0 if not m then m=c end local i=tonumber(redis.call("GET",KEYS[3])) or 0 local s={} for _,v in ipairs(ARGV) do s[tonumber(v)]=true end local n=m+1 while n<=i and s[n] do n=n+1 end if n<=i then redis.call("SET",KEYS[1],n) redis.call("SET",KEYS[2],n) return n else return -1 end` });
// 發號：略過預約保留號，避免現場客人拿到與預約相同的號碼
redis.defineCommand("safeIssue", { numberOfKeys: 1, lua: `local i=(tonumber(redis.call("GET",KEYS[1])) or 0)+1 local s={} for _,v in ipairs(ARGV) do s[tonumber(v)]=true end while s[i] do i=i+1 end redis.call("SET",KEYS[1],i) return i` });
// 上一號：目前是預約號 (大於 MAX) 時回到一般進度，否則遞減
redis.defineCommand("decrIfPositive", { numberOfKeys: 2, lua: `local c=tonumber(redis.call("GET",KEYS[1])) or 0 local m=tonumber(redis.call("GET",KEYS[2])) or c if c > m then redis.call("SET",KEYS[1],m) return m end if c > 0 then local nc=c-1 redis.call("SET",KEYS[1],nc) if m==c then redis.call("SET",KEYS[2],nc) end return nc end return c` });

// Hash 欄位比對後設定 (compare-and-set)：預約狀態從 ARGV[2] 改成 ARGV[3]，兩個櫃台同時叫號時只有一個搶得到
redis.defineCommand("hcas", { numberOfKeys: 1, lua: `if redis.call("HGET",KEYS[1],ARGV[1])==ARGV[2] then redis.call("HSET",KEYS[1],ARGV[1],ARGV[3]) return 1 end return 0` });

module.exports = { redis, onRedisReady };
